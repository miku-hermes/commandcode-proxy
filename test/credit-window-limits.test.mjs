import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { setup } from './helpers.mjs';

const ADMIN_TOKEN = 'credit_window_test';
const ADMIN = { 'x-admin-token': ADMIN_TOKEN };
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const HOUR_MS = 3600000;

async function admin(proxy, method, path, body) {
  const response = await fetch(proxy.base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...ADMIN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}

const routing = (proxy, body) => admin(proxy, 'PUT', '/admin/api/routing', body);
const metrics = proxy => admin(proxy, 'GET', '/admin/api/metrics');
const usage = (proxy, account) => admin(proxy, 'GET', '/admin/api/accounts/' + account.id + '/usage?refresh=1');
const accountMetrics = async (proxy, account) => (await metrics(proxy)).accounts.find(item => item.id === account.id);

async function addAccount(proxy, name = 'limited', weight = 10) {
  return (await admin(proxy, 'POST', '/admin/api/accounts', { name, apiKey: 'user_' + name + '_window', weight })).account;
}

async function addClient(proxy) {
  return (await admin(proxy, 'POST', '/admin/api/clients', { name: 'window-client' })).client;
}

async function request(proxy, client, path = '/v1/chat/completions', stream = false) {
  const body = path === '/v1/responses'
    ? { model: 'm', input: 'hi', stream }
    : { ...CHAT, max_tokens: 32, stream };
  const response = await proxy.post(path, body, { Authorization: 'Bearer ' + client.token });
  const text = await response.text();
  return { status: response.status, text };
}

function windows(fiveHour = {}, weekly = {}) {
  return {
    limited: true, exceeded: null,
    fiveHour: { used: 0, cap: 3, exceeded: false, resetAt: 0, ...fiveHour },
    weekly: { used: 0, cap: 6, exceeded: false, resetAt: 0, ...weekly },
  };
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

async function withPool(state, run) {
  state.periodEnd ??= new Date(Date.now() + 30 * 24 * HOUR_MS).toISOString();
  const fixture = await setup({
    env: {
      CC_ADMIN_TOKEN: ADMIN_TOKEN,
      CC_USAGE_REFRESH_MS: '60000',
      CC_STREAM_IDLE_MS: '150',
      CC_NONSTREAM_IDLE_MS: '150',
    },
    onRequest(req, res) {
      if (req.url.startsWith('/alpha/whoami')) {
        if (state.usageError) return json(res, { error: 'unavailable' }, 503);
        return json(res, { org: { id: 'org_window' } });
      }
      if (req.url.startsWith('/alpha/billing/credits')) {
        if (state.creditsBody) return json(res, state.creditsBody);
        return json(res, {
          credits: { planId: 'individual-go', monthlyCredits: state.remaining ?? 10 },
          windowLimits: state.limits,
          sandboxAccess: true, sandboxMinutes: 7,
        });
      }
      if (req.url.startsWith('/alpha/billing/subscriptions')) return json(res, { data: {
        planId: 'individual-go', status: 'active',
        currentPeriodStart: new Date(Date.now() - HOUR_MS).toISOString(),
        currentPeriodEnd: state.periodEnd,
      } });
      if (req.url.startsWith('/alpha/usage/summary')) return json(res, { totalCost: 0 });
      if (req.url !== '/alpha/generate' || req.headers.authorization.includes('user_healthy_')) return false;
      if (state.hang) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('{"type":"text-start"}\n');
        return true;
      }
      if (state.semantic429) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('{"type":"error","error":{"message":"rate limited","statusCode":429}}\n');
        return true;
      }
      if (state.status) return json(res, { code: 'BAD_REQUEST', message: state.message ?? 'You have insufficient credits to make this request' }, state.status);
      return false;
    },
  });
  try { await run(fixture); } finally { await fixture.close(); }
}

test('窗口字段透出：顶层优先，完整保留窗口和 sandbox 字段', async () => {
  const limits = windows();
  await withPool({ creditsBody: {
    credits: { monthlyCredits: 10, windowLimits: windows({ cap: 99 }), sandboxAccess: true, sandboxMinutes: 99 },
    windowLimits: limits, sandboxAccess: false, sandboxMinutes: 0,
  } }, async ({ proxy }) => {
    const account = await addAccount(proxy);
    await usage(proxy, account);
    const view = (await admin(proxy, 'GET', '/admin/api/usage')).usage.find(item => item.id === account.id);
    assert.deepEqual(view.credits.windowLimits, limits);
    assert.equal(view.credits.windowLimits.fiveHour.cap, 3);
    assert.equal(view.credits.windowLimits.weekly.cap, 6);
    assert.equal(view.credits.sandboxAccess, false);
    assert.equal(view.credits.sandboxMinutes, 0);
  });
});

for (const shape of ['legacy', 'envelope']) {
  test('额度字段兼容：' + shape, async () => {
    const fields = { windowLimits: windows(), sandboxAccess: true, sandboxMinutes: 8 };
    const creditsBody = shape === 'legacy'
      ? { credits: { monthlyCredits: 10, ...fields } }
      : { data: { credits: { monthlyCredits: 10 }, ...fields } };
    await withPool({ creditsBody }, async ({ proxy }) => {
      const account = await addAccount(proxy);
      const view = (await usage(proxy, account)).usage;
      assert.deepEqual(view.credits.windowLimits, fields.windowLimits);
      assert.equal(view.credits.sandboxAccess, true);
      assert.equal(view.credits.sandboxMinutes, 8);
    });
  });
}

test('窗口暂停 ≤1h：额度错误优先窗口，2h resetAt 不会变成月度阻断', async () => {
  const resetAt = Date.now() + 2 * HOUR_MS;
  await withPool({ status: 400, remaining: 0.1, limits: windows({ exceeded: true, resetAt }) }, async ({ proxy, mock }) => {
    const limited = await addAccount(proxy);
    await addAccount(proxy, 'healthy', 1);
    await routing(proxy, { selection: 'best' });
    const client = await addClient(proxy);
    const before = Date.now();
    assert.equal((await request(proxy, client)).status, 200);
    const after = Date.now();
    const current = await accountMetrics(proxy, limited);
    assert.equal(current.creditExhausted, false);
    assert.equal(current.creditResetAt, null);
    assert.equal(current.windowExhausted, true);
    assert.equal(current.windowKind, 'fiveHour');
    assert.equal(current.windowResetAt, resetAt);
    assert.equal(current.cooling, true);
    assert.ok(current.cooldownUntil >= before + HOUR_MS);
    assert.ok(current.cooldownUntil <= after + HOUR_MS);
    assert.ok(current.cooldownUntil < resetAt);
    assert.equal((await request(proxy, client)).status, 200);
    assert.equal(mock.seen.filter(item => item.url === '/alpha/generate' && item.headers.authorization.includes('user_limited_')).length, 1);
  });
});

for (const fallback of [undefined, 60000]) {
  for (const reset of ['zero', 'missing', 'expired']) {
    test('窗口保险丝：resetAt=' + reset + ' fallback=' + (fallback ?? 'default'), async () => {
      const fiveHour = { exceeded: true, resetAt: reset === 'expired' ? Date.now() - HOUR_MS : 0 };
      if (reset === 'missing') delete fiveHour.resetAt;
      const limits = windows(fiveHour);
      if (reset === 'missing') delete limits.fiveHour.resetAt;
      await withPool({ status: 400, limits }, async ({ proxy, mock }) => {
        const account = await addAccount(proxy);
        const applied = await routing(proxy, { creditFailoverMax: 0, ...(fallback === undefined ? {} : { windowFallbackCooldownMs: fallback }) });
        assert.equal(applied.routing.windowFallbackCooldownMs, fallback ?? 600000);
        const client = await addClient(proxy);
        assert.equal((await request(proxy, client)).status, 400);
        const current = await accountMetrics(proxy, account);
        const now = Date.now();
        assert.equal(current.creditExhausted, false);
        assert.equal(current.creditResetAt, null);
        assert.equal(current.windowExhausted, true);
        assert.ok(current.cooldownUntil > now);
        assert.ok(current.cooldownUntil - now <= (fallback ?? 600000));
        assert.ok(current.cooldownUntil - now <= HOUR_MS);
        assert.equal((await request(proxy, client)).status, 503);
        assert.equal(mock.generateCount(), 1);
      });
    });
  }
}

test('窗口正常时仍走旧月度路径：95% 兜底及套餐周期保持不变', async () => {
  await withPool({ status: 400, message: 'unrecognized billing rejection', remaining: 0.1, limits: windows() }, async ({ proxy }) => {
    const account = await addAccount(proxy);
    const client = await addClient(proxy);
    await routing(proxy, { creditFailoverMax: 0 });
    assert.equal((await request(proxy, client)).status, 400);
    const view = (await usage(proxy, account)).usage;
    assert.ok(view.credits.usagePercent >= 0.95);
    const current = await accountMetrics(proxy, account);
    assert.equal(current.creditExhausted, true);
    assert.equal(current.creditResetAt, Date.parse(view.subscription.currentPeriodEnd));
    assert.equal(current.cooldownUntil, current.creditResetAt);
    assert.equal(current.windowExhausted, false);
  });
});

for (const later of ['fiveHour', 'weekly']) {
  test('查询直接暂停且两个窗口取较晚 resetAt：' + later, async () => {
    const limits = windows(
      { exceeded: true, resetAt: Date.now() + 600000 },
      { exceeded: true, resetAt: Date.now() + 600000 },
    );
    limits[later].resetAt += 600000;
    const state = { limits };
    await withPool(state, async ({ proxy, mock }) => {
      const account = await addAccount(proxy);
      const client = await addClient(proxy);
      await usage(proxy, account);
      let current = await accountMetrics(proxy, account);
      assert.equal(current.windowKind, later);
      assert.equal(current.windowResetAt, limits[later].resetAt);
      assert.equal(current.cooldownUntil, limits[later].resetAt);
      assert.equal(current.creditExhausted, false);
      await admin(proxy, 'POST', '/admin/api/accounts/' + account.id + '/reset-metrics');
      assert.equal((await request(proxy, client)).status, 503);
      assert.equal(mock.generateCount(), 0);
      state.limits = windows({ used: 100 }, { used: 100 });
      await usage(proxy, account);
      current = await accountMetrics(proxy, account);
      assert.equal(current.windowExhausted, false);
      assert.equal(current.creditExhausted, false);
      assert.equal((await request(proxy, client)).status, 200);
    });
  });
}

test('窗口到期后选路惰性解除，不依赖新额度查询', async () => {
  const state = { limits: windows() };
  await withPool(state, async ({ proxy, mock }) => {
    const account = await addAccount(proxy);
    const client = await addClient(proxy);
    state.limits = windows({ exceeded: true, resetAt: Date.now() + 400 });
    await usage(proxy, account);
    assert.equal((await request(proxy, client)).status, 503);
    await sleep(450);
    assert.equal((await request(proxy, client)).status, 200);
    assert.equal(mock.generateCount(), 1);
    const current = await accountMetrics(proxy, account);
    assert.equal(current.windowExhausted, false);
    assert.equal(current.windowResetAt, null);
    assert.equal(current.cooling, false);
  });
});

test('月度阻断不受窗口查询污染；窗口缺失仍按旧逻辑', async () => {
  const state = { status: 400 };
  await withPool(state, async ({ proxy }) => {
    const account = await addAccount(proxy);
    const client = await addClient(proxy);
    await routing(proxy, { creditFailoverMax: 0 });
    assert.equal((await request(proxy, client)).status, 400);
    const original = await accountMetrics(proxy, account);
    assert.equal(original.creditExhausted, true);
    state.limits = windows({ exceeded: true, resetAt: Date.now() + 600000 });
    await usage(proxy, account);
    state.limits = windows();
    await usage(proxy, account);
    const current = await accountMetrics(proxy, account);
    assert.equal(current.creditExhausted, true);
    assert.equal(current.creditResetAt, original.creditResetAt);
    assert.equal(current.cooldownUntil, original.creditResetAt);
    assert.equal(current.windowExhausted, false);
  });
});

test('windowFallbackCooldownMs 经管理接口归一化限制在 1min–1h', async () => {
  await withPool({}, async ({ proxy }) => {
    for (const [input, expected] of [[1, 60000], [99999999, HOUR_MS], ['invalid', 600000]]) {
      const applied = await routing(proxy, { windowFallbackCooldownMs: input });
      assert.equal(applied.routing.windowFallbackCooldownMs, expected);
    }
  });
});

for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) {
  for (const semantic429 of [false, true]) {
    test('countRateLimitAsFailure：false 为 neutral，true 恢复 fail ' + path + (semantic429 ? ' NDJSON 429' : ' HTTP 429'), async () => {
      await withPool({ status: 429, message: 'rate limited', semantic429 }, async ({ proxy }) => {
        const account = await addAccount(proxy);
        const client = await addClient(proxy);
        await routing(proxy, { countRateLimitAsFailure: false, failureCooldownThreshold: 1 });
        const response = await request(proxy, client, path);
        assert.equal(response.status, 429, response.text);
        let current = await accountMetrics(proxy, account);
        assert.equal(current.cooling, false);
        assert.equal(current.consecutiveFailures, 0);
        assert.equal(current.window.fail, 0);
        assert.equal(current.window.n, 0);
        assert.equal(current.totals.neutral, 1);
        assert.equal(current.inFlight, 0);
        await routing(proxy, { countRateLimitAsFailure: true, failureCooldownThreshold: 1 });
        assert.equal((await request(proxy, client, path)).status, 429);
        current = await accountMetrics(proxy, account);
        assert.equal(current.cooling, true);
        assert.equal(current.consecutiveFailures, 1);
        assert.equal(current.window.fail, 1);
        assert.equal(current.totals.fail, 1);
      });
    });
  }
  for (const stream of [false, true]) {
    test('countTimeoutsAsFailure 独立于 429 开关 ' + path + ' stream=' + stream, async () => {
      await withPool({ hang: true }, async ({ proxy }) => {
        const account = await addAccount(proxy);
        const client = await addClient(proxy);
        await routing(proxy, { countTimeoutsAsFailure: false, countRateLimitAsFailure: true, failureCooldownThreshold: 1 });
        await request(proxy, client, path, stream);
        let current = await accountMetrics(proxy, account);
        assert.equal(current.cooling, false);
        assert.equal(current.consecutiveFailures, 0);
        assert.equal(current.window.fail, 0);
        assert.equal(current.window.n, 0);
        assert.equal(current.totals.neutral, 1);
        assert.equal(current.inFlight, 0);
        await routing(proxy, { countTimeoutsAsFailure: true, countRateLimitAsFailure: false, failureCooldownThreshold: 1 });
        await request(proxy, client, path, stream);
        current = await accountMetrics(proxy, account);
        assert.equal(current.cooling, true);
        assert.equal(current.consecutiveFailures, 1);
        assert.equal(current.window.fail, 1);
        assert.equal(current.totals.fail, 1);
      });
    });
  }
}
