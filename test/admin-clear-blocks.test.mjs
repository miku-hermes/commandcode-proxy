import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup } from './helpers.mjs';

const ADMIN = { 'x-admin-token': 'clear_blocks_test' };
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const EMPTY = {
  creditExhausted: false, creditResetAt: null,
  windowExhausted: false, windowKind: null, cooldownUntil: 0,
};

async function admin(proxy, method, path, body) {
  const response = await fetch(proxy.base + path, {
    method, headers: { ...ADMIN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, method === 'POST' && path === '/admin/api/accounts' ? 201 : 200,
    await response.clone().text());
  return response.json();
}

const clear = (proxy, account) => admin(proxy, 'POST', '/admin/api/accounts/' + account.id + '/clear-blocks');
const metrics = async (proxy, account) => (await admin(proxy, 'GET', '/admin/api/metrics'))
  .accounts.find(item => item.id === account.id);

async function request(proxy, client) {
  const response = await proxy.post('/v1/chat/completions', CHAT, { Authorization: 'Bearer ' + client.token });
  await response.text();
  return response.status;
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

async function withAccount(run) {
  const state = { status: 200, limits: undefined };
  const fixture = await setup({
    env: { CC_ADMIN_TOKEN: ADMIN['x-admin-token'], CC_USAGE_REFRESH_MS: '60000' },
    onRequest(req, res) {
      if (req.url.startsWith('/alpha/whoami')) return json(res, { org: { id: 'org_clear' } });
      if (req.url.startsWith('/alpha/billing/credits')) return json(res, {
        credits: { planId: 'individual-go', monthlyCredits: 0.1 }, windowLimits: state.limits,
      });
      if (req.url.startsWith('/alpha/billing/subscriptions')) return json(res, { data: {
        planId: 'individual-go', status: 'active',
        currentPeriodStart: new Date(Date.now() - 3600000).toISOString(),
        currentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
      } });
      if (req.url.startsWith('/alpha/usage/summary')) return json(res, { totalCost: 0 });
      if (req.url === '/alpha/generate' && state.status !== 200) return json(res, {
        code: 'BAD_REQUEST', message: 'You have insufficient credits to make this request',
      }, state.status);
      return false;
    },
  });
  try {
    const { proxy } = fixture;
    const account = (await admin(proxy, 'POST', '/admin/api/accounts', {
      name: 'limited', apiKey: 'user_limited_clear',
    })).account;
    const response = await proxy.post('/admin/api/clients', { name: 'clear-client' }, ADMIN);
    assert.equal(response.status, 201);
    const { client } = await response.json();
    await admin(proxy, 'PUT', '/admin/api/routing', { creditFailoverMax: 0, failureCooldownThreshold: 1 });
    await run({ ...fixture, account, client, state });
  } finally { await fixture.close(); }
}

function assertUnblocked(current) {
  assert.equal(current.creditExhausted, false);
  assert.equal(current.creditResetAt, null);
  assert.equal(current.windowExhausted, false);
  assert.equal(current.windowResetAt, null);
  assert.equal(current.windowKind, null);
  assert.equal(current.windowBlockedUntil, 0);
  assert.equal(current.cooling, false);
  assert.equal(current.cooldownUntil, 0);

  assert.equal(current.consecutiveFailures, 0);
}

test('月度阻断可解除，返回解除前摘要并重新获流', async () => {
  await withAccount(async ({ proxy, mock, account, client, state }) => {
    state.status = 400;
    assert.equal(await request(proxy, client), 400);
    const before = await metrics(proxy, account);
    assert.equal(before.creditExhausted, true);
    const usage = await admin(proxy, 'GET', '/admin/api/accounts/' + account.id + '/usage');
    assert.ok(usage.usage.credits.usagePercent >= 0.95);
    const result = await clear(proxy, account);
    assert.deepEqual(result, { ok: true, id: account.id, cleared: {
      ...EMPTY, creditExhausted: true, creditResetAt: before.creditResetAt, cooldownUntil: before.cooldownUntil,
    } });
    assert.equal(JSON.stringify(result).includes('apiKey'), false);
    assert.equal(JSON.stringify(result).includes('user_limited_'), false);
    assertUnblocked(await metrics(proxy, account));
    const hits = () => mock.seen.filter(item => item.url === '/alpha/generate'
      && item.headers.authorization.includes('user_' + account.name + '_')).length;
    const previousHits = hits();
    state.status = 200;
    assert.equal(await request(proxy, client), 200);
    assert.equal(hits(), previousHits + 1);
    assert.match(proxy.logs(), /Admin: account blocks cleared/);
    assert.ok(proxy.logs().includes(account.id));
  });
});

for (const [kind, knownReset] of [['fiveHour', true], ['fiveHour', false], ['weekly', true]]) {
  test('窗口暂停可解除：' + kind + ' reset=' + knownReset, async () => {
    await withAccount(async ({ proxy, account, client, state }) => {
      state.limits = { [kind]: { exceeded: true, resetAt: knownReset ? Date.now() + 600000 : 0 } };
      await admin(proxy, 'GET', '/admin/api/accounts/' + account.id + '/usage?refresh=1');
      const before = await metrics(proxy, account);
      assert.equal(before.windowExhausted, true);
      assert.equal(before.windowKind, kind);
      assert.equal(await request(proxy, client), 503);
      const result = await clear(proxy, account);
      assert.deepEqual(result.cleared, { ...EMPTY, windowExhausted: true,
        windowKind: kind, cooldownUntil: before.cooldownUntil });
      assertUnblocked(await metrics(proxy, account));
      assert.equal(await request(proxy, client), 200);
    });
  });
}

test('解除不动统计、延迟与 lastError，且不落盘', async () => {
  await withAccount(async ({ proxy, account, client, state }) => {
    assert.equal(await request(proxy, client), 200);
    state.status = 400;
    assert.equal(await request(proxy, client), 400);
    const before = await metrics(proxy, account);
    assert.equal(before.totals.fail, 1);
    assert.equal(before.window.n, 2);
    assert.equal(before.window.ok, 1);
    assert.ok(before.lastError);
    const accountsPath = join(proxy.workdir, 'accounts.json');
    const persisted = readFileSync(accountsPath, 'utf8');
    await clear(proxy, account);
    const after = await metrics(proxy, account);
    assert.deepEqual(after.totals, before.totals);
    assert.deepEqual(after.window, before.window);
    assert.deepEqual(after.lastError, before.lastError);
    assert.equal(after.ewmaTtftMs, before.ewmaTtftMs);
    assert.equal(after.lastLatencyMs, before.lastLatencyMs);
    assert.equal(readFileSync(accountsPath, 'utf8'), persisted);
  });
});

test('普通失败冷却也可解除', async () => {
  await withAccount(async ({ proxy, account, client, state }) => {
    state.status = 500;
    assert.equal(await request(proxy, client), 502);
    const before = await metrics(proxy, account);
    assert.equal(before.creditExhausted, false);
    assert.equal(before.windowExhausted, false);
    assert.equal(before.cooling, true);
    assert.ok(before.consecutiveFailures > 0);

    assert.deepEqual((await clear(proxy, account)).cleared, { ...EMPTY, cooldownUntil: before.cooldownUntil });
    assertUnblocked(await metrics(proxy, account));
  });
});

test('解除阻断要求管理员鉴权，不存在账号返回 404', async () => {
  await withAccount(async ({ proxy, account }) => {
    const path = '/admin/api/accounts/' + account.id + '/clear-blocks';
    assert.equal((await proxy.post(path, {})).status, 401);
    assert.equal((await proxy.post(path, {}, { 'x-admin-token': 'wrong' })).status, 401);
    assert.equal((await proxy.post('/admin/api/accounts/missing/clear-blocks', {}, ADMIN)).status, 404);
  });
});

test('幂等：健康账号首次与重复解除均返回 200 和空摘要', async () => {
  await withAccount(async ({ proxy, account }) => {
    for (const attempt of [1, 2]) {
      assert.deepEqual(await clear(proxy, account), { ok: true, id: account.id, cleared: EMPTY }, 'attempt ' + attempt);
      assertUnblocked(await metrics(proxy, account));
    }
  });
});
