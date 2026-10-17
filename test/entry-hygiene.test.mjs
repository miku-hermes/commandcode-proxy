import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import vm from 'node:vm';
import { setup } from './helpers.mjs';

const ADMIN_TOKEN = 'entry_hygiene_admin';
const ADMIN = { 'x-admin-token': ADMIN_TOKEN };
const CHAT = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const ROUTES = [
  ['/v1/chat/completions', CHAT],
  ['/v1/messages', { ...CHAT, max_tokens: 32 }],
  ['/v1/responses', { model: 'm', input: 'hi' }],
];

async function waitFor(check, message) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await sleep(15);
  }
  assert.fail(message);
}

async function admin(proxy, method, path, body) {
  const response = await fetch(proxy.base + '/admin/api/' + path, {
    method, headers: { ...ADMIN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, method === 'POST' ? 201 : 200, await response.clone().text());
  return response.json();
}

function usageReply(req, res) {
  let body;
  if (req.url.startsWith('/alpha/whoami')) body = { org: { id: 'hygiene_org' } };
  else if (req.url.startsWith('/alpha/billing/credits')) {
    body = { credits: { planId: 'individual-go', monthlyCredits: 100 } };
  } else if (req.url.startsWith('/alpha/billing/subscriptions')) {
    body = { data: { planId: 'individual-go', status: 'active',
      currentPeriodStart: new Date(Date.now() - 3600000).toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString() } };
  } else if (req.url.startsWith('/alpha/usage/summary')) body = { totalCost: 0 };
  else return false;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

async function addPool(proxy, count) {
  const accounts = [];
  for (let index = 0; index < count; index++) {
    const apiKey = 'user_hygiene_pool_' + index;
    const { account } = await admin(proxy, 'POST', 'accounts', { name: apiKey, apiKey });
    accounts.push({ ...account, apiKey });
  }
  const { client } = await admin(proxy, 'POST', 'clients', { name: 'hygiene-client' });
  return { accounts, headers: { Authorization: 'Bearer ' + client.token } };
}

function pendingClient(proxy, path, body, headers) {
  let receivedResponse = false;
  const request = http.request(proxy.base + path, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
  }, response => { receivedResponse = true; response.resume(); });
  request.on('error', () => {});
  request.end(JSON.stringify(body));
  return { request, receivedResponse: () => receivedResponse };
}

test('hygiene 09: LOG_FILE and console identify keys only by SHA-256', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ccp-hygiene-log-'));
  const logFile = join(directory, 'proxy.log');
  const key = 'user_abcdefgh_private_hygiene_key';
  const fixture = await setup({ env: { LOG_FILE: logFile } });
  try {
    const response = await fixture.proxy.post('/v1/chat/completions', CHAT, { Authorization: 'Bearer ' + key });
    assert.equal(response.status, 200);
    await response.text();
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 8);
    const file = readFileSync(logFile, 'utf8');
    await waitFor(() => fixture.proxy.logs().includes(hash), 'console must contain the key hash');
    for (const output of [file, fixture.proxy.logs()]) {
      assert.ok(!output.includes(key.slice(0, 8)), 'no plaintext key prefix at either log destination');
      const record = output.split('\n').find(line => line.includes('Fingerprint derived for key'));
      assert.ok(record?.includes('"keyHash":"' + hash + '"'), 'fingerprint record must retain a lookup hash');
      assert.ok(!output.includes('keyPrefix'), 'field name must not suggest plaintext');
    }
  } finally { await fixture.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('hygiene 10: actual dispatcher 500 hides a null-body TypeError and logs its request id', async () => {
  const fixture = await setup();
  try {
    const response = await fixture.proxy.post('/v1/messages', 'null', { 'x-api-key': 'user_hygiene_null' });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body.error, { message: 'Internal error', type: 'internal_error' });
    assert.match(body.request_id, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(JSON.stringify(body), /Cannot read|properties|is not an object|evaluating|null|stream|proxy\.mjs/);
    await waitFor(() => fixture.proxy.logs().includes(body.request_id), 'dispatcher must log the response request id');
    const record = fixture.proxy.logs().split('\n').find(line => line.includes(body.request_id));
    assert.match(record, /Data API error/);
    // 引擎无关：V8 说 "Cannot read properties of null (reading 'stream')"，
    // JSC(bun) 说 "null is not an object (evaluating 'anthropicReq.stream')" —— 两边的共同关键信息是 null 与 stream
    assert.match(record, /null/);
    assert.match(record, /stream/);
    assert.match(record, /\/v1\/messages/);
    assert.equal(fixture.mock.generateCount(), 0);
  } finally { await fixture.close(); }
});

for (const stage of ['initialization', 'generate']) {
  for (const stream of [false, true]) {
    test('hygiene 11: messages abort before first byte cancels ' + stage + ' (stream=' + stream + ')', async () => {
      let upstreamResponse;
      let upstreamClosed = false;
      const slowPath = stage === 'initialization' ? '/alpha/fingerprint/record' : '/alpha/generate';
      const fixture = await setup({
        env: { CC_ADMIN_TOKEN: ADMIN_TOKEN, CC_USAGE_REFRESH_MS: '600000' },
        onRequest(req, res) {
          if (usageReply(req, res)) return true;
          if (req.url !== slowPath) return false;
          upstreamResponse = res;
          res.on('close', () => { upstreamClosed = true; });
          return true;
        },
      });
      let client;
      try {
        const { accounts, headers } = await addPool(fixture.proxy, 1);
        const snapshot = async () => (await admin(fixture.proxy, 'GET', 'metrics')).accounts
          .find(account => account.id === accounts[0].id);
        const before = await snapshot();
        client = pendingClient(fixture.proxy, '/v1/messages', { ...CHAT, max_tokens: 32, stream }, headers);
        await waitFor(() => upstreamResponse, 'slow upstream must receive the request before client abort');
        assert.equal(client.receivedResponse(), false, 'abort must precede the first response byte');
        assert.equal((await snapshot()).inFlight, 1);
        client.request.destroy();
        await waitFor(() => upstreamClosed, 'proxy must abort the unfinished upstream connection');
        assert.equal(upstreamResponse.writableFinished, false);
        const after = await waitFor(async () => {
          const metrics = await snapshot();
          return metrics.inFlight === 0 && metrics.totals.requests > before.totals.requests && metrics;
        }, 'aborted request must release the account lease');
        assert.equal(after.totals.requests, before.totals.requests + 1);
        assert.equal(after.totals.fail, before.totals.fail);
        assert.equal(after.totals.ok, before.totals.ok);
        assert.equal(after.totals.neutral, before.totals.neutral);
        assert.equal(after.consecutiveFailures, before.consecutiveFailures);
        assert.equal(after.lastError, before.lastError);
        assert.equal(after.cooling, false);
        await waitFor(() => fixture.proxy.logs().includes('Request cancelled (client disconnected before CC response)'),
          'handler must take its aborted outcome path');
        if (stage === 'initialization') assert.equal(fixture.mock.generateCount(), 0);
      } finally { client?.request.destroy(); await fixture.close(); }
    });
  }
}

for (const [path, body] of ROUTES) {
  test('hygiene 12: failover abort does not penalize the new account: ' + path, async () => {
    let firstKey;
    let secondKey;
    let slowResponse;
    let upstreamClosed = false;
    const fixture = await setup({
      env: { CC_ADMIN_TOKEN: ADMIN_TOKEN, CC_USAGE_REFRESH_MS: '600000' },
      onRequest(req, res) {
        if (usageReply(req, res)) return true;
        if (req.url !== '/alpha/generate') return false;
        const key = req.headers.authorization.replace('Bearer ', '');
        if (!firstKey) {
          firstKey = key;
          res.writeHead(402, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'insufficient credits', code: 'insufficient_credits' } }));
        } else {
          secondKey = key;
          slowResponse = res;
          res.on('close', () => { upstreamClosed = true; });
        }
        return true;
      },
    });
    let client;
    try {
      const { accounts, headers } = await addPool(fixture.proxy, 2);
      const metrics = async () => (await admin(fixture.proxy, 'GET', 'metrics')).accounts;
      const baseline = await metrics();
      client = pendingClient(fixture.proxy, path, body, headers);
      await waitFor(() => slowResponse, 'credit exhaustion must trigger a replay on the second account');
      assert.notEqual(secondKey, firstKey);
      assert.equal(client.receivedResponse(), false);
      const secondId = accounts.find(account => account.apiKey === secondKey).id;
      const firstId = accounts.find(account => account.apiKey === firstKey).id;
      const before = (await metrics()).find(account => account.id === secondId);
      assert.equal(before.inFlight, 1);
      assert.equal(before.totals.fail, baseline.find(account => account.id === secondId).totals.fail);
      client.request.destroy();
      await waitFor(() => upstreamClosed, 'failover replay must cancel the upstream connection');
      assert.equal(slowResponse.writableFinished, false);
      const after = await waitFor(async () => {
        const account = (await metrics()).find(item => item.id === secondId);
        return account.inFlight === 0 && account.totals.requests > before.totals.requests && account;
      }, 'replayed account must release its lease');
      assert.equal(after.totals.fail, before.totals.fail, 'client abort must not add a 502 failure to the new account');
      assert.equal(after.consecutiveFailures, before.consecutiveFailures);
      assert.equal(after.cooling, before.cooling);
      assert.equal(after.lastError, before.lastError);
      assert.equal(after.totals.ok, before.totals.ok);
      assert.equal(after.totals.neutral, before.totals.neutral);
      const exhausted = (await metrics()).find(account => account.id === firstId);
      assert.equal(exhausted.creditExhausted, true);
      assert.equal(exhausted.totals.fail, 1, 'real credit failure must still be charged to the first account');
      assert.equal(fixture.mock.generateCount(), 2);
    } finally { client?.request.destroy(); await fixture.close(); }
  });
}

class PanelElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.textContent = '';
    this.className = '';
    this.listeners = new Map();
    this.classList = {
      add: name => { if (!this.classList.contains(name)) this.className = (this.className + ' ' + name).trim(); },
      remove: name => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name),
    };
  }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
  get firstChild() { return this.children[0]; }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  dispatch(name) { for (const callback of this.listeners.get(name) || []) callback({ type: name, target: this }); }
  getAttribute(name) { return this[name]; }
  contains(child) { return this === child || this.children.some(node => node.contains(child)); }
}

async function panelHarness(html, scrollWidth, clientWidth) {
  const elements = Object.fromEntries(['view', 'stats', 'tabs', 'logout', 'app', 'toasts']
    .map(id => [id, new PanelElement('div')]));
  const stats = elements.stats;
  stats.className = 'stats';
  stats.scrollLeft = 0;
  Object.defineProperties(stats, {
    scrollWidth: { value: scrollWidth, writable: true },
    clientWidth: { value: clientWidth, writable: true },
  });
  const window = new PanelElement('window');
  let poll;
  let fetchCount = 0;
  const context = vm.createContext({
    window,
    document: {
      getElementById: id => elements[id], createElement: tag => new PanelElement(tag),
      querySelector: () => null, addEventListener() {}, body: new PanelElement('body'),
    },
    sessionStorage: { getItem: () => ADMIN_TOKEN },
    setInterval(callback) { poll = callback; }, clearInterval() {}, setTimeout() {},
    MutationObserver: class { observe() {} },
    fetch: async () => { fetchCount++; return { ok: true, status: 200, text: async () => '{}' }; },
  });
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(script[1], context);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetchCount, 5, 'boot must execute the real data refresh');
  assert.ok(stats.children.length >= 7, 'real renderStats must populate the status bar');
  return { stats, window, async refresh() {
    const before = fetchCount;
    poll();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fetchCount, before + 1, 'polling refreshes exactly the metrics endpoint');
  } };
}

test('hygiene 13: overflow hint follows render, scroll, resize and polling without changing desktop CSS', async () => {
  const fixture = await setup({ env: { CC_ADMIN_TOKEN: ADMIN_TOKEN } });
  try {
    const response = await fixture.proxy.get('/admin');
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /header#bar \.stats\.has-more\{mask-image:linear-gradient\(90deg,#000 calc\(100% - 24px\),transparent\)/);
    assert.match(html, /-webkit-mask-image:linear-gradient\(90deg,#000 calc\(100% - 24px\),transparent\)/);
    assert.match(html, /overflow-x:auto;scrollbar-width:none/);
    assert.match(html, /\.stats::-webkit-scrollbar\{display:none\}/);
    const overflowing = await panelHarness(html, 900, 600);
    const { stats, window } = overflowing;
    assert.equal(stats.classList.contains('has-more'), true, 'overflowing initial render must show the hint');
    stats.scrollLeft = 300;
    stats.dispatch('scroll');
    assert.equal(stats.classList.contains('has-more'), false, 'right edge must clear the hint');
    stats.scrollLeft = 120;
    stats.dispatch('scroll');
    assert.equal(stats.classList.contains('has-more'), true, 'scrolling back into the middle restores the hint');
    stats.scrollLeft = 0;
    stats.dispatch('scroll');
    assert.equal(stats.classList.contains('has-more'), true);
    stats.clientWidth = 900;
    window.dispatch('resize');
    assert.equal(stats.classList.contains('has-more'), false, 'resize to non-overflow must clear the hint');
    stats.clientWidth = 600;
    window.dispatch('resize');
    assert.equal(stats.classList.contains('has-more'), true, 'resize back to overflow restores the hint');
    stats.scrollWidth = 600;
    await overflowing.refresh();
    assert.equal(stats.classList.contains('has-more'), false, 'polling content shrink clears the hint');
    stats.scrollWidth = 900;
    await overflowing.refresh();
    assert.equal(stats.classList.contains('has-more'), true, 'polling content growth restores the hint');
    const fitting = await panelHarness(html, 600, 600);
    assert.equal(fitting.stats.className, 'stats', 'non-overflow render must not add any class');
    await fitting.refresh();
    assert.equal(fitting.stats.className, 'stats');
    const desktop = await panelHarness(html, 900, 1200);
    assert.equal(desktop.stats.className, 'stats', 'desktop without overflow must remain unchanged');
  } finally { await fixture.close(); }
});
