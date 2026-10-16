import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { setup } from './helpers.mjs';

const ADMIN_TOKEN = 'admin-strong-random-regression-token-32';
const BAD_TOKEN = 'wrong-secret-do-not-log-this-token';
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

async function metricsAuth(proxy, token, headers = {}) {
  const response = await proxy.get('/admin/api/metrics', { headers: { 'x-admin-token': token, ...headers } });
  await response.text();
  return response;
}

async function withProxy(env, run) {
  const fixture = await setup({ env: { CC_ADMIN_TOKEN: ADMIN_TOKEN, ...env } });
  try { await run(fixture); } finally { await fixture.close(); }
}

async function admin(proxy, path, body) {
  const response = await proxy.post('/admin/api/' + path, body, { 'x-admin-token': ADMIN_TOKEN });
  assert.ok(response.ok, await response.clone().text());
  return response.json();
}

async function chat(proxy, key, path = '/v1/chat/completions') {
  const body = path === '/v1/responses' ? { model: 'm', input: 'hi' } : { ...CHAT, max_tokens: 32 };
  const response = await proxy.post(path, body, { Authorization: 'Bearer ' + key });
  await response.text();
  return response;
}

const fingerprintCount = (mock, key) => mock.seen.filter(request => request.url === '/alpha/fingerprint/record'
  && request.headers.authorization === 'Bearer ' + key).length;

test('admin failures: first five are 401 then 429 with Retry-After and secret-free warning', async () => {
  await withProxy({}, async ({ proxy }) => {
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await metricsAuth(proxy, BAD_TOKEN)).status, 401);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await metricsAuth(proxy, BAD_TOKEN, { 'x-forwarded-for': '192.0.2.' + attempt });
      assert.equal(response.status, 429);
      assert.ok(Number(response.headers.get('Retry-After')) > 0);
      assert.ok(Number(response.headers.get('Retry-After')) <= 60);
    }
    const logs = proxy.logs();
    assert.match(logs, /\[warn\] Admin authentication failures .*"ip":"[^"]+","failures":5/);
    assert.ok(!logs.includes(BAD_TOKEN.slice(0, 8)));
    assert.ok(!logs.includes(ADMIN_TOKEN.slice(0, 8)));
  });
});

test('correct admin token bypasses active backoff and resets all failures', async () => {
  await withProxy({}, async ({ proxy }) => {
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await metricsAuth(proxy, BAD_TOKEN)).status, 401);
    assert.equal((await metricsAuth(proxy, BAD_TOKEN)).status, 429);
    assert.equal((await metricsAuth(proxy, ADMIN_TOKEN)).status, 200);
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await metricsAuth(proxy, BAD_TOKEN)).status, 401);
    assert.equal((await metricsAuth(proxy, BAD_TOKEN)).status, 429);
    const response = await proxy.get('/admin/api/metrics', { headers: { Authorization: 'Bearer ' + ADMIN_TOKEN } });
    await response.text();
    assert.equal(response.status, 200);
    assert.equal((await metricsAuth(proxy, BAD_TOKEN)).status, 401);
  });
});

for (const length of [11, 31, 32, 48]) {
  test('admin startup strength warning at token length ' + length, async () => {
    const token = 'Z'.repeat(length);
    await withProxy({ CC_ADMIN_TOKEN: token }, async ({ proxy }) => {
      assert.equal((await metricsAuth(proxy, token)).status, 200);
      const logs = proxy.logs();
      assert.equal(logs.includes('SECURITY WARNING: weak admin token'), length < 32);
      if (length < 32) {
        assert.match(logs, new RegExp('\\[warn\\] SECURITY WARNING:.*long random token.*"length":' + length));
      }
      assert.ok(!logs.includes(token.slice(0, 8)));
    });
  });
}

function authHarness() {
  const source = readFileSync(new URL('../proxy.mjs', import.meta.url), 'utf8');
  let now = 1000000;
  const warnings = [];
  const context = vm.createContext({
    CFG: { adminToken: ADMIN_TOKEN },
    adminEnabled: () => true,
    timingSafeEqualStr: (expected, actual) => expected === actual,
    Date: { now: () => now },
    log: (...args) => warnings.push(args),
  });
  vm.runInContext(source.slice(source.indexOf('const ADMIN_AUTH_FAILURE_MAX ='), source.indexOf('\nfunction adminJSON(')), context);
  return {
    check(ip, token = BAD_TOKEN) { return context.checkAdminAuth({ socket: { remoteAddress: ip }, headers: { 'x-admin-token': token } }); },
    advance(ms) { now += ms; },
    entries() { return vm.runInContext('Array.from(adminAuthFailures.keys())', context); },
    warnings,
  };
}

test('admin backoff doubles from 60 seconds to a 15 minute cap and resets on success', () => {
  const harness = authHarness();
  for (let attempt = 0; attempt < 5; attempt++) assert.equal(harness.check('ip').retryAfter, 0);
  for (const seconds of [60, 120, 240, 480, 900, 900]) {
    assert.equal(harness.check('ip').retryAfter, seconds);
    harness.advance(seconds * 1000);
  }
  assert.equal(harness.check('ip', ADMIN_TOKEN).ok, true);
  assert.equal(harness.entries().length, 0);
  for (let attempt = 0; attempt < 5; attempt++) assert.equal(harness.check('ip').retryAfter, 0);
  assert.equal(harness.check('ip').retryAfter, 60);
  assert.ok(harness.warnings.every(([level, , data]) => level === 'warn' && Object.keys(data).sort().join(',') === 'failures,ip'));
});

test('admin failure state is IP isolated and bounded to 1024 LRU entries', () => {
  const harness = authHarness();
  for (let index = 0; index < 1024; index++) harness.check('ip-' + index);
  harness.check('ip-0');
  harness.check('ip-new');
  const entries = harness.entries();
  assert.equal(entries.length, 1024);
  assert.equal(entries.includes('ip-1'), false);
  assert.equal(entries.includes('ip-0'), true);
  for (let attempt = 0; attempt < 3; attempt++) harness.check('ip-0');
  assert.equal(harness.check('ip-0').retryAfter, 60);
  assert.equal(harness.check('ip-new').retryAfter, 0);
});

test('legacy capacity 16 evicts the oldest of 20 keys and repeats its initialization cost', async () => {
  await withProxy({ CC_KEY_STATE_MAX: '16', CC_KEY_INIT_PER_MIN: '0' }, async ({ proxy, mock }) => {
    for (let index = 0; index < 20; index++) assert.equal((await chat(proxy, 'user_capacity_' + index)).status, 200);
    assert.equal(fingerprintCount(mock, 'user_capacity_0'), 1);
    assert.equal((await chat(proxy, 'user_capacity_0')).status, 200);
    assert.equal(fingerprintCount(mock, 'user_capacity_0'), 2);
    assert.equal((await chat(proxy, 'user_capacity_19')).status, 200);
    assert.equal(fingerprintCount(mock, 'user_capacity_19'), 1);
  });
});

test('legacy eviction refreshes recency on cache hits rather than using FIFO', async () => {
  await withProxy({ CC_KEY_STATE_MAX: '16', CC_KEY_INIT_PER_MIN: '0' }, async ({ proxy, mock }) => {
    for (let index = 0; index < 16; index++) assert.equal((await chat(proxy, 'user_lru_' + index)).status, 200);
    assert.equal((await chat(proxy, 'user_lru_0')).status, 200);
    assert.equal((await chat(proxy, 'user_lru_16')).status, 200);
    assert.equal((await chat(proxy, 'user_lru_0')).status, 200);
    assert.equal(fingerprintCount(mock, 'user_lru_0'), 1);
    assert.equal((await chat(proxy, 'user_lru_1')).status, 200);
    assert.equal(fingerprintCount(mock, 'user_lru_1'), 2);
  });
});

test('legacy new-key limit is shared across endpoints but cached keys and pool tokens bypass it', async () => {
  await withProxy({ CC_KEY_STATE_MAX: '16', CC_KEY_INIT_PER_MIN: '3' }, async ({ proxy, mock }) => {
    const paths = ['/v1/chat/completions', '/v1/messages', '/v1/responses'];
    for (let index = 0; index < 3; index++) assert.equal((await chat(proxy, 'user_rate_' + index, paths[index])).status, 200);
    const upstreamCount = mock.seen.length;
    for (const path of paths) {
      const response = await chat(proxy, 'user_rate_denied', path);
      assert.equal(response.status, 429);
      assert.ok(Number(response.headers.get('Retry-After')) > 0);
    }
    assert.equal(mock.seen.length, upstreamCount);
    assert.match(proxy.logs(), /\[warn\] Legacy key initialization rate limit reached \{"count":3\}/);
    for (const path of paths) assert.equal((await chat(proxy, 'user_rate_0', path)).status, 200);
    assert.equal(fingerprintCount(mock, 'user_rate_0'), 1);
    await admin(proxy, 'accounts', { name: 'pool', apiKey: 'user_pool_bypass' });
    const { client } = await admin(proxy, 'clients', { name: 'pool-client' });
    for (const path of paths) assert.equal((await chat(proxy, client.token, path)).status, 200);
    assert.equal(fingerprintCount(mock, 'user_pool_bypass'), 1);
    assert.equal((await chat(proxy, 'user_rate_denied')).status, 429);
  });
});

test('legacy initialization uses a sliding minute and releases only expired slots', async () => {
  const source = readFileSync(new URL('../proxy.mjs', import.meta.url), 'utf8');
  let now = 1000000;
  const states = new Map();
  const timestamps = [];
  const replies = [];
  const context = vm.createContext({
    KEY_INIT_PER_MIN: 3,
    keyStateStore: states,
    keyInitTimes: timestamps,
    Date: { now: () => now },
    log: () => {},
    sendJSON: (_res, status) => replies.push(status),
    ensureInitialized: async key => states.set(key, {}),
  });
  const start = source.indexOf('async function initializeForRoute(');
  vm.runInContext(source.slice(start, source.indexOf('\n// 空闲淘汰', start)), context);
  const initialize = key => context.initializeForRoute({ mode: 'legacy', upstreamKey: key }, { setHeader() {} });
  assert.equal(await initialize('first'), true);
  now += 30000;
  assert.equal(await initialize('second'), true);
  now += 10000;
  assert.equal(await initialize('third'), true);
  now += 19999;
  assert.equal(await initialize('denied'), false);
  assert.equal(await initialize('first'), true);
  assert.equal(timestamps.length, 3);
  now++;
  assert.equal(await initialize('fourth'), true);
  assert.equal(await initialize('fifth'), false);
  assert.equal(timestamps.length, 3);
  assert.deepEqual(replies, [429, 429]);
});

test('legacy churn cannot evict a pool key or force repeated pool initialization', async () => {
  await withProxy({ CC_KEY_STATE_MAX: '16', CC_KEY_INIT_PER_MIN: '0' }, async ({ proxy, mock }) => {
    await admin(proxy, 'accounts', { name: 'pool', apiKey: 'user_pool_isolated' });
    const { client } = await admin(proxy, 'clients', { name: 'pool-client' });
    assert.equal((await chat(proxy, client.token)).status, 200);
    for (let index = 0; index < 20; index++) assert.equal((await chat(proxy, 'user_churn_' + index)).status, 200);
    assert.equal((await chat(proxy, client.token)).status, 200);
    assert.equal(fingerprintCount(mock, 'user_pool_isolated'), 1);
  });
});
