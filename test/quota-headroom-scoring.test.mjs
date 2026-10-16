import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setup } from './helpers.mjs';

const ADMIN_TOKEN = 'quota_headroom_test';
const ADMIN = { 'x-admin-token': ADMIN_TOKEN };
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

async function admin(proxy, method, path, body) {
  const response = await fetch(proxy.base + '/admin/api/' + path, {
    method,
    headers: { ...ADMIN, 'Content-Type': 'application/json' },
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

async function withPool(percentages, run) {
  const state = new Map(percentages.map((used, index) => [
    'user_quota_' + index, { used, failed: used === null },
  ]));
  const harness = await setup({
    env: { CC_ADMIN_TOKEN: ADMIN_TOKEN, CC_USAGE_REFRESH_MS: '60000' },
    onRequest(req, res) {
      const key = req.headers.authorization?.replace('Bearer ', '');
      const account = state.get(key);
      if (req.url.startsWith('/alpha/whoami')) {
        return account.failed
          ? json(res, { error: 'quota unavailable' }, 503)
          : json(res, { org: { id: key } });
      }
      if (req.url.startsWith('/alpha/billing/credits')) {
        return json(res, { credits: { planId: 'individual-go', monthlyCredits: (1 - account.used) * 10 } });
      }
      if (req.url.startsWith('/alpha/billing/subscriptions')) {
        return json(res, { data: { planId: 'individual-go', status: 'active' } });
      }
      return false;
    },
  });
  try {
    const accounts = [];
    for (const [apiKey, snapshot] of state) {
      const { account } = await admin(harness.proxy, 'POST', 'accounts', { name: apiKey, apiKey, weight: 1 });
      accounts.push(account);
      if (snapshot.used !== null) {
        const { usage: result } = await admin(harness.proxy, 'GET', 'accounts/' + account.id + '/usage?refresh=1');
        assert.equal(result.ok, true);
        assert.ok(Math.abs(result.credits.usagePercent - snapshot.used) < 1e-12);
      }
    }
    const metrics = async () => (await admin(harness.proxy, 'GET', 'metrics')).accounts;
    const routing = body => admin(harness.proxy, 'PUT', 'routing', body);
    await run({ ...harness, state, accounts, metrics, routing });
  } finally {
    await harness.close();
  }
}

test('quota 1: 95% used yields a significantly lower score than 20% used', async () => {
  await withPool([0.95, 0.2], async ({ metrics }) => {
    const [low, high] = await metrics();
    assert.ok(high.score > low.score * 1.15);
    assert.ok(Math.abs(low.components.quota - 0.25) < 1e-12);
    assert.equal(high.components.quota, 1);
    assert.equal(low.components.usagePercent, 0.95);
    assert.ok(Math.abs(low.components.remaining - 0.05) < 1e-12);
  });
});

test('quota 2: accounts above the floor have exactly equal scores', async () => {
  await withPool([0.5, 0.2], async ({ metrics }) => {
    const [first, second] = await metrics();
    assert.equal(first.score, second.score);
    assert.equal(first.components.quota, 1);
    assert.equal(second.components.quota, 1);
  });
});

test('quota 3: unknown usage is not penalized', async () => {
  await withPool([null, 0], async ({ metrics }) => {
    const [unknown, full] = await metrics();
    assert.equal(unknown.components.usagePercent, null);
    assert.equal(unknown.components.remaining, null);
    assert.equal(unknown.components.quota, 1);
    assert.equal(unknown.score, full.score);
  });
});

test('quota 4: zero quota weight restores the original scores bit for bit, with four-way normalization', async () => {
  await withPool([0.95, 0.2], async ({ proxy, routing, metrics }) => {
    const { routing: defaults } = await admin(proxy, 'GET', 'routing');
    const legacyWeights = { ...defaults.weights, quota: 0 };
    await routing({ ...defaults, weights: legacyWeights });
    const baseline = await metrics();
    const legacySum = legacyWeights.successRate + legacyWeights.latency + legacyWeights.load;
    for (const item of baseline) {
      const components = item.components;
      const legacy = (legacyWeights.successRate / legacySum * components.success
        + legacyWeights.latency / legacySum * components.latency
        + legacyWeights.load / legacySum * components.load) * components.weightFactor;
      assert.equal(item.score, legacy);
    }
    await routing(defaults);
    const enabled = await metrics();
    enabled.forEach((item, index) => {
      const expected = (baseline[index].score * legacySum
        + defaults.weights.quota * item.components.quota * item.components.weightFactor)
        / (legacySum + defaults.weights.quota);
      assert.ok(Math.abs(item.score - expected) < 1e-12, 'quota weight must be included in wsum');
    });
    await routing({ ...defaults, weights: legacyWeights });
    assert.deepEqual((await metrics()).map(item => item.score), baseline.map(item => item.score));
  });
});

test('quota 5: exact floor, empty balance and floor=1 boundaries', async () => {
  await withPool([0.75, 1], async ({ routing, metrics }) => {
    await routing({ quotaFloor: 0.25 });
    const [boundary, empty] = await metrics();
    assert.equal(boundary.components.remaining, 0.25);
    assert.equal(boundary.components.quota, 1);
    assert.equal(empty.components.remaining, 0);
    assert.equal(empty.components.quota, 0);
    await routing({ quotaFloor: 1 });
    for (const item of await metrics()) assert.equal(item.components.quota, item.components.remaining);
  });
});

test('quota 6: weighted_random gives the healthy balance at least 70% of requests', async () => {
  await withPool([0.95, 0.1], async ({ proxy, mock, routing, metrics }) => {
    await routing({ selection: 'weighted_random', weights: { successRate: 0, latency: 0, load: 0, quota: 1 } });
    const { client } = await admin(proxy, 'POST', 'clients', { name: 'quota-random' });
    const total = 800;
    for (let index = 0; index < total; index++) {
      const response = await proxy.post('/v1/chat/completions', CHAT, { Authorization: 'Bearer ' + client.token });
      assert.equal(response.status, 200, await response.text());
    }
    const generated = mock.seen.filter(request => request.url === '/alpha/generate');
    const healthyHits = generated.filter(request => request.headers.authorization === 'Bearer user_quota_1').length;
    assert.equal(generated.length, total);
    assert.ok(healthyHits >= total * 0.7, 'healthy account hits: ' + healthyHits + '/' + total);
    assert.ok(healthyHits < total, 'low balance account must remain eligible');
    assert.equal((await metrics()).reduce((sum, account) => sum + account.totals.ok, 0), total);
  });
});

test('quota 7: a sole account at 99% used remains selectable', async () => {
  await withPool([0.99], async ({ proxy, metrics }) => {
    const { client } = await admin(proxy, 'POST', 'clients', { name: 'quota-single' });
    const response = await proxy.post('/v1/chat/completions', CHAT, { Authorization: 'Bearer ' + client.token });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'hello');
    const [account] = await metrics();
    assert.ok(account.score > 0);
    assert.equal(account.creditExhausted, false);
    assert.equal(account.windowExhausted, false);
    assert.equal(account.totals.ok, 1);
  });
});

test('quota 8: routing round-trip persists quota settings and changes metrics', async () => {
  await withPool([0.95, null], async ({ proxy, routing, metrics }) => {
    const before = await metrics();
    const { routing: current } = await admin(proxy, 'GET', 'routing');
    const desired = { ...current, quotaFloor: 0.5, quotaUnknownScore: 0.4, weights: { ...current.weights, quota: 2.5 } };
    const saved = await routing(desired);
    const read = await admin(proxy, 'GET', 'routing');
    for (const result of [saved, read]) {
      assert.equal(result.routing.quotaFloor, desired.quotaFloor);
      assert.equal(result.routing.quotaUnknownScore, desired.quotaUnknownScore);
      assert.equal(result.routing.weights.quota, desired.weights.quota);
    }
    const [known, unknown] = await metrics();
    assert.ok(Math.abs(known.components.quota - 0.1) < 1e-12);
    assert.equal(unknown.components.quota, 0.4);
    assert.notEqual(known.score, before[0].score);
    assert.notEqual(unknown.score, before[1].score);
  });
});

test('quota 9: failed usage refresh retains the last known quota', async () => {
  await withPool([0.95], async ({ proxy, accounts, state, metrics }) => {
    const [before] = await metrics();
    state.get('user_quota_0').failed = true;
    const { usage: failed } = await admin(proxy, 'GET', 'accounts/' + accounts[0].id + '/usage?refresh=1');
    assert.equal(failed.ok, false);
    assert.equal(failed.error, 'upstream_503');
    const [after] = await metrics();
    assert.equal(after.components.usagePercent, 0.95);
    assert.equal(after.components.quota, before.components.quota);
    assert.equal(after.score, before.score);
  });
});

test('quota: metric reset preserves the usage snapshot', async () => {
  await withPool([0.95], async ({ proxy, accounts, metrics }) => {
    const [before] = await metrics();
    await admin(proxy, 'POST', 'accounts/' + accounts[0].id + '/reset-metrics');
    const [after] = await metrics();
    assert.equal(after.components.usagePercent, before.components.usagePercent);
    assert.equal(after.components.remaining, before.components.remaining);
    assert.equal(after.components.quota, before.components.quota);
  });
});

test('quota: configuration clamps and floor=0 remain finite', async () => {
  await withPool([0.95, null], async ({ routing, metrics }) => {
    const upper = await routing({ quotaFloor: 9, quotaUnknownScore: -1, weights: { quota: 1001 } });
    assert.equal(upper.routing.quotaFloor, 1);
    assert.equal(upper.routing.quotaUnknownScore, 0);
    assert.equal(upper.routing.weights.quota, 1000);
    const lower = await routing({ quotaFloor: -1, quotaUnknownScore: 2, weights: { successRate: 2, quota: -1 } });
    assert.equal(lower.routing.quotaFloor, 0);
    assert.equal(lower.routing.quotaUnknownScore, 1);
    assert.equal(lower.routing.weights.quota, 0);
    await routing({ quotaFloor: 0 });
    for (const item of await metrics()) {
      assert.equal(item.components.quota, 0);
      assert.ok(Number.isFinite(item.score));
    }
    const quotaOnly = await routing({ weights: { successRate: 0, latency: 0, load: 0, quota: 1 } });
    assert.equal(quotaOnly.routing.weights.quota, 1);
  });
});

class PanelElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.textContent = '';
    this.classList = { add() {}, remove() {} };
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
  get firstChild() { return this.children[0]; }
  addEventListener() {}
  getAttribute(name) { return this[name]; }
}

test('quota: panel renders additional components, previews quota and saves all three settings', async () => {
  await withPool([0.95], async ({ proxy }) => {
    const data = {};
    for (const path of ['routing', 'metrics', 'accounts', 'clients']) data[path] = await admin(proxy, 'GET', path);
    const html = await (await proxy.get('/admin')).text();
    const elements = Object.fromEntries(['view', 'stats', 'tabs', 'logout', 'app', 'toasts']
      .map(id => [id, new PanelElement('div')]));
    const tab = new PanelElement('button');
    tab['data-tab'] = 'routing';
    elements.tabs.appendChild(tab);
    const requests = [];
    const context = vm.createContext({
      document: {
        getElementById: id => elements[id], createElement: tag => new PanelElement(tag),
        querySelector: () => null, addEventListener() {}, body: new PanelElement('body'),
      },
      sessionStorage: { getItem: () => ADMIN_TOKEN },
      setInterval() {}, clearInterval() {}, setTimeout() {},
      MutationObserver: class { observe() {} },
      fetch: async (path, options) => {
        requests.push({ path, options });
        return { ok: true, status: 200, text: async () => JSON.stringify(data[path.split('/').pop()] || {}) };
      },
    });
    for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1], context);
    await new Promise(resolve => setImmediate(resolve));
    tab.onclick();
    const nodes = [];
    function collect(node) { nodes.push(node); node.children.forEach(collect); }
    collect(elements.view);
    assert.ok(nodes.some(node => node.textContent === '额度Q / 剩余'));
    assert.ok(nodes.some(node => node.textContent === '0.250 / 5.0%'));
    const quotaInput = nodes.find(node => node.children.some(child => child.textContent === '额度权重 quota'))
      .children.find(child => child.tagName === 'INPUT');
    assert.equal(Number(quotaInput.value), 20);
    assert.equal(Number(quotaInput.min), 0);
    assert.equal(Number(quotaInput.max), 100);
    assert.equal(Number(quotaInput.step), 0.01);
    for (const [label, value] of [
      ['额度权重 quota', 33.33], ['额度衰减阈值 quotaFloor', 0.4], ['额度未知分 quotaUnknownScore', 0.7],
    ]) {
      const field = nodes.find(node => node.children.some(child => child.textContent === label));
      assert.ok(field, label);
      field.children.find(child => child.tagName === 'INPUT').value = value;
    }
    nodes.find(node => node.textContent === '保存路由配置').onclick();
    const saved = requests.find(request => request.options.method === 'PUT');
    assert.ok(saved);
    const payload = JSON.parse(saved.options.body);
    assert.equal(payload.weights.quota, 0.3333);
    assert.equal(payload.quotaFloor, 0.4);
    assert.equal(payload.quotaUnknownScore, 0.7);
    const stored = await admin(proxy, 'PUT', 'routing', payload);
    assert.equal(stored.routing.weights.quota, payload.weights.quota);
    assert.equal(stored.routing.quotaFloor, payload.quotaFloor);
    assert.equal(stored.routing.quotaUnknownScore, payload.quotaUnknownScore);
    data.routing = await admin(proxy, 'GET', 'routing');
    const savedHtml = await (await proxy.get('/admin')).text();
    for (const script of savedHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1], context);
    await new Promise(resolve => setImmediate(resolve));
    tab.onclick();
    nodes.length = 0;
    collect(elements.view);
    const restoredQuotaInput = nodes.find(node => node.children.some(child => child.textContent === '额度权重 quota'))
      .children.find(child => child.tagName === 'INPUT');
    assert.equal(Number(restoredQuotaInput.value), 33.33);
  });
});
