import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { setup } from './helpers.mjs';

const ADMIN_TOKEN = 'quota-window-regression-admin-token-32';
const HOUR_MS = 3600000;
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

async function admin(proxy, method, path, body) {
  const response = await fetch(proxy.base + '/admin/api/' + path, {
    method,
    headers: { 'x-admin-token': ADMIN_TOKEN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

async function withPool(state, run) {
  const fixture = await setup({
    env: { CC_ADMIN_TOKEN: ADMIN_TOKEN, CC_USAGE_REFRESH_MS: '60000' },
    onRequest(req, res) {
      if (req.url.startsWith('/alpha/whoami')) return json(res, { org: { id: 'org_quota' } });
      if (req.url.startsWith('/alpha/billing/credits')) {
        return json(res, { credits: state.credits ?? {}, windowLimits: state.limits });
      }
      if (req.url.startsWith('/alpha/billing/subscriptions')) return json(res, { data: state.subscription ?? {} });
      if (req.url.startsWith('/alpha/usage/summary')) return json(res, { totalCost: state.spent ?? 0 });
      if (req.url === '/alpha/generate' && state.status) return json(res, { code: 'BAD_REQUEST', message: 'invalid input' }, state.status);
      return false;
    },
  });
  try {
    const { account } = await admin(fixture.proxy, 'POST', 'accounts', { name: 'quota', apiKey: 'user_quota_unknown' });
    const { client } = await admin(fixture.proxy, 'POST', 'clients', { name: 'quota-client' });
    const refresh = async () => {
      const result = await admin(fixture.proxy, 'GET', 'accounts/' + account.id + '/usage?refresh=1');
      assert.equal(result.usage.ok, true);
      return result.usage;
    };
    const metrics = async () => (await admin(fixture.proxy, 'GET', 'metrics')).accounts.find(item => item.id === account.id);
    const routing = body => admin(fixture.proxy, 'PUT', 'routing', body);
    await run({ ...fixture, account, client, refresh, metrics, routing });
  } finally {
    await fixture.close();
  }
}

test('unknown quota uses null and the configured quotaUnknownScore', async () => {
  await withPool({}, async ({ refresh, metrics, routing }) => {
    const usage = await refresh();
    assert.equal(usage.credits.totalPool, 0);
    assert.equal(usage.credits.hasCreditsInfo, false);
    assert.equal(usage.credits.usagePercent, null);
    let current = await metrics();
    assert.equal(current.components.usagePercent, null);
    assert.equal(current.components.remaining, null);
    assert.equal(current.components.quota, 1);
    await routing({ quotaUnknownScore: 0.3 });
    current = await metrics();
    assert.equal(current.components.usagePercent, null);
    assert.equal(current.components.quota, 0.3);
  });
});

test('known positive pool with zero balance and spending is fully exhausted', async () => {
  await withPool({ subscription: { status: 'active', planId: 'individual-go' } }, async ({ refresh, metrics }) => {
    const usage = await refresh();
    assert.equal(usage.credits.totalPool, 10);
    assert.equal(usage.credits.hasCreditsInfo, false);
    assert.equal(usage.credits.usagePercent, 1);
    const current = await metrics();
    assert.equal(current.components.usagePercent, 1);
    assert.equal(current.components.remaining, 0);
    assert.equal(current.components.quota, 0);
  });
});

test('known remaining 20 percent preserves usage and quota formulas', async () => {
  await withPool({ credits: { monthlyCredits: 2, planId: 'individual-go' }, subscription: { status: 'active' } }, async ({ refresh, metrics, routing }) => {
    const usage = await refresh();
    assert.equal(usage.credits.hasCreditsInfo, true);
    assert.equal(usage.credits.usagePercent, 0.8);
    let current = await metrics();
    assert.ok(Math.abs(current.components.remaining - 0.2) < 1e-12);
    assert.ok(Math.abs(current.components.quota - 1) < 1e-12);
    await routing({ quotaFloor: 0.4 });
    current = await metrics();
    assert.ok(Math.abs(current.components.quota - 0.5) < 1e-12);
  });
});

test('known 95 percent usage survives a successful refresh without credit information', async () => {
  const state = { credits: { monthlyCredits: 0.5, planId: 'individual-go' }, subscription: { status: 'active' } };
  await withPool(state, async ({ refresh, metrics, routing }) => {
    await refresh();
    const original = await metrics();
    assert.equal(original.components.usagePercent, 0.95);
    assert.ok(original.components.quota > 0 && original.components.quota < 0.3);
    state.credits = {};
    state.subscription = {};
    await routing({ quotaUnknownScore: 0.3 });
    const usage = await refresh();
    assert.equal(usage.credits.hasCreditsInfo, false);
    assert.equal(usage.credits.totalPool, 0);
    assert.equal(usage.credits.usagePercent, null);
    const current = await metrics();
    assert.equal(current.components.usagePercent, 0.95);
    assert.equal(current.components.quota, original.components.quota);
  });
});

test('unknown quota plus HTTP 400 never triggers credit fallback even at threshold zero', async () => {
  await withPool({ status: 400 }, async ({ proxy, client, refresh, metrics, routing }) => {
    await routing({ creditUsageThreshold: 0 });
    await refresh();
    const response = await proxy.post('/v1/chat/completions', CHAT, { Authorization: 'Bearer ' + client.token });
    await response.text();
    assert.equal(response.status, 400);
    const current = await metrics();
    assert.equal(current.creditExhausted, false);
    assert.equal(current.components.usagePercent, null);
  });
});

test('weekly information extends a fiveHour block and survives its original expiry', async () => {
  const state = {};
  await withPool(state, async ({ refresh, metrics }) => {
    const shortResetAt = Date.now() + 2500;
    state.limits = { fiveHour: { exceeded: true, resetAt: shortResetAt } };
    await refresh();
    assert.equal((await metrics()).windowBlockedUntil, shortResetAt);
    state.limits = { weekly: { exceeded: true, resetAt: Date.now() + 48 * HOUR_MS } };
    const before = Date.now();
    assert.ok(before < shortResetAt);
    await refresh();
    const after = Date.now();
    const extended = await metrics();
    assert.equal(extended.windowKind, 'weekly');
    assert.ok(extended.windowBlockedUntil >= before + HOUR_MS);
    assert.ok(extended.windowBlockedUntil <= after + HOUR_MS);
    await sleep(Math.max(0, shortResetAt + 50 - Date.now()));
    const current = await metrics();
    assert.equal(current.windowExhausted, true);
    assert.equal(current.cooling, true);
    assert.ok(current.windowBlockedUntil > Date.now());
  });
});

test('shorter fiveHour information never shortens an active weekly block', async () => {
  const state = { limits: { weekly: { exceeded: true, resetAt: Date.now() + 48 * HOUR_MS } } };
  await withPool(state, async ({ refresh, metrics }) => {
    await refresh();
    const original = await metrics();
    state.limits = { fiveHour: { exceeded: true, resetAt: Date.now() + 600000 } };
    await refresh();
    const current = await metrics();
    assert.equal(current.windowExhausted, true);
    assert.equal(current.windowBlockedUntil, original.windowBlockedUntil);
  });
});

test('an expired window may be replaced with a new short block', async () => {
  const state = {};
  await withPool(state, async ({ refresh, metrics }) => {
    state.limits = { fiveHour: { exceeded: true, resetAt: Date.now() + 100 } };
    await refresh();
    await sleep(150);
    assert.equal((await metrics()).windowExhausted, false);
    const resetAt = Date.now() + 600000;
    state.limits = { weekly: { exceeded: true, resetAt } };
    await refresh();
    assert.equal((await metrics()).windowBlockedUntil, resetAt);
  });
});
