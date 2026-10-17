import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import vm from 'node:vm';
import { setup } from './helpers.mjs';

const ADMIN_TOKEN = 'adm_metrics_protocol_test';
const ADMIN = { 'x-admin-token': ADMIN_TOKEN };
const MEMORY_MESSAGE = 'Request body limit implies high per-request worst-case memory';

async function withProxy(fn, env = {}) {
  const fixture = await setup({ env: { CC_ADMIN_TOKEN: ADMIN_TOKEN, ...env } });
  try { return await fn(fixture.proxy); }
  finally { await fixture.close(); }
}

async function readMetrics(proxy) {
  const response = await proxy.get('/admin/api/metrics', { headers: ADMIN });
  assert.equal(response.status, 200);
  return response.json();
}

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
  contains(child) { return this === child || this.children.some(node => node.contains(child)); }
}

async function renderStats(proxy, metrics) {
  const response = await proxy.get('/admin');
  assert.equal(response.status, 200);
  const html = await response.text();
  const elements = Object.fromEntries(['view', 'stats', 'tabs', 'logout', 'app', 'toasts']
    .map(id => [id, new PanelElement('div')]));
  const requests = [];
  const context = vm.createContext({
    document: {
      getElementById: id => elements[id],
      createElement: tag => new PanelElement(tag),
      querySelector: () => null,
      addEventListener() {},
      body: new PanelElement('body'),
    },
    sessionStorage: { getItem: () => ADMIN_TOKEN },
    setInterval() {}, clearInterval() {}, setTimeout() {},
    MutationObserver: class { observe() {} },
    fetch: async path => {
      requests.push(path);
      return { ok: true, status: 200,
        text: async () => JSON.stringify(path.endsWith('/metrics') ? metrics : {}),
      };
    },
  });
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(script[1], context);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(requests.includes('/admin/api/metrics'));
  assert.ok(elements.stats.children.some(node => node.children[0]?.textContent === '运行'),
    'the real panel script must complete its top-bar render');
  assert.equal(elements.toasts.children.length, 0, 'panel rendering must not swallow an error');
  return elements.stats.children;
}

async function memoryLog(proxy) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const line = proxy.logs().split('\n').find(entry => entry.includes(MEMORY_MESSAGE));
    if (line) {
      const match = line.match(/\[(warn|info)\] /);
      assert.ok(match, 'memory notice must have a recognized level');
      return { line, level: match[1], payload: JSON.parse(line.slice(line.indexOf('{'))) };
    }
    await sleep(25);
  }
  assert.fail('startup memory notice was not logged: ' + proxy.logs());
}

test('metrics protocol 1: authenticated metrics includes cliProtocol 1.53.1', async () => {
  await withProxy(async proxy => {
    const metrics = await readMetrics(proxy);
    assert.ok(Object.hasOwn(metrics, 'cliProtocol'));
    assert.equal(metrics.cliProtocol, '1.53.1');
  });
});

test('metrics protocol 2: real metrics renders the protocol capsule with 1.53.1', async () => {
  await withProxy(async proxy => {
    const capsules = await renderStats(proxy, await readMetrics(proxy));
    const protocol = capsules.filter(node => node.children[0]?.textContent === '协议');
    assert.equal(protocol.length, 1, 'top bar must contain exactly one protocol capsule');
    assert.equal(protocol[0].className, 'stat');
    assert.equal(protocol[0].children[1].textContent, '1.53.1');
  });
});

test('metrics protocol 3: absent cliProtocol does not render a protocol capsule', async () => {
  await withProxy(async proxy => {
    const metrics = await readMetrics(proxy);
    delete metrics.cliProtocol;
    assert.equal(Object.hasOwn(metrics, 'cliProtocol'), false);
    const capsules = await renderStats(proxy, metrics);
    assert.equal(capsules.some(node => node.children[0]?.textContent === '协议'), false);
    assert.equal(capsules.some(node => node.children.some(child => child.textContent.includes('undefined'))), false);
  });
});

test('body memory 4: unset CC_MAX_INFLIGHT keeps the startup notice at warn', async () => {
  await withProxy(async proxy => {
    const { level, payload } = await memoryLog(proxy);
    assert.equal(level, 'warn');
    assert.equal(payload.maxInflight, 32);
    assert.equal(payload.maxBodyMB, 100);
    assert.equal(payload.worstCaseRSSPerRequestMB, 550);
  });
});

test('body memory 5: explicit CC_MAX_INFLIGHT=32 downgrades the startup notice to info', async () => {
  await withProxy(async proxy => {
    const { level, payload } = await memoryLog(proxy);
    assert.equal(level, 'info');
    assert.equal(payload.maxInflight, 32);
    assert.equal(payload.worstCaseRSSPerRequestMB, 550);
  }, { CC_MAX_INFLIGHT: '32' });
});

test('body memory 6: hint forbids lowering the body cap and directs concurrency limits', async () => {
  await withProxy(async proxy => {
    const { payload } = await memoryLog(proxy);
    assert.match(payload.hint, /不要/);
    assert.match(payload.hint, /CC_MAX_BODY_MB/);
    assert.match(payload.hint, /合法.*多模态长会话/);
    assert.match(payload.hint, /issue #7/);
    assert.match(payload.hint, /CC_MAX_INFLIGHT/);
    assert.match(payload.hint, /limit_conn/);
    assert.doesNotMatch(payload.hint, /lower CC_MAX_BODY_MB/i);
  });
});

test('body memory 7: empty or invalid explicit concurrency values do not silence warn', async () => {
  for (const value of ['', ' ', '-1', 'invalid', '32junk', '1.5', 'Infinity']) {
    await withProxy(async proxy => {
      const { level } = await memoryLog(proxy);
      assert.equal(level, 'warn', 'invalid CC_MAX_INFLIGHT=' + JSON.stringify(value));
    }, { CC_MAX_INFLIGHT: value });
  }
});

test('body memory 8: explicit zero is info but retains the separate unlimited-risk warning', async () => {
  await withProxy(async proxy => {
    const { level, payload } = await memoryLog(proxy);
    assert.equal(level, 'info');
    assert.equal(payload.maxInflight, 0);
    assert.match(proxy.logs(), /\[warn\] CC_MAX_INFLIGHT=0 disables the concurrency limit/);
  }, { CC_MAX_INFLIGHT: '0' });
});
