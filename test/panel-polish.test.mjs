import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { setup } from './helpers.mjs';

const ADMIN_TOKEN = 'adm_panel_polish';
let html;

before(async () => {
  const fixture = await setup({ env: { CC_ADMIN_TOKEN: ADMIN_TOKEN } });
  try {
    const response = await fixture.proxy.get('/admin');
    assert.equal(response.status, 200);
    html = await response.text();
  } finally { await fixture.close(); }
});

class PanelElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.nodeType = tagName === '#text' ? 3 : 1;
    this.children = [];
    this.className = '';
    this.style = {};
    this.listeners = new Map();
    this.value = '';
    this.classList = {
      add: name => { if (!this.classList.contains(name)) this.className = (this.className + ' ' + name).trim(); },
      remove: name => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(' '); },
      contains: name => this.className.split(/\s+/).includes(name),
    };
  }
  get textContent() { return this.nodeType === 3 ? this.text || '' : this.children.map(child => child.textContent).join(''); }
  set textContent(value) {
    this.children.forEach(child => { child.parentNode = null; });
    this.children = [];
    if (this.nodeType === 3) this.text = String(value);
    else if (String(value)) {
      const child = new PanelElement('#text');
      child.text = String(value);
      this.appendChild(child);
    }
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    assert.notEqual(index, -1);
    this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  get firstChild() { return this.children[0] || null; }
  setAttribute(name, value) { this[name] = String(value); }
  getAttribute(name) { return this[name]; }
  contains(child) { return this === child || this.children.some(node => node.contains(child)); }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  dispatch(name) {
    const event = { type: name, target: this };
    if (this['on' + name]) this['on' + name](event);
    for (const callback of this.listeners.get(name) || []) callback(event);
  }
}

function nodes(root, predicate) {
  return [root, ...root.children.flatMap(child => nodes(child, () => true))].filter(predicate);
}
function byClass(root, name) { return nodes(root, node => node.classList.contains(name)); }
function button(root, label) {
  const found = nodes(root, node => node.tagName === 'BUTTON' && node.textContent === label);
  assert.equal(found.length, 1, 'one button: ' + label);
  return found[0];
}
function inputFor(root, label) {
  const field = nodes(root, node => node.tagName === 'LABEL' && node.firstChild?.textContent === label)[0];
  assert.ok(field, 'field: ' + label);
  return nodes(field, node => /^(INPUT|SELECT|TEXTAREA)$/.test(node.tagName))[0];
}
function dataRows(root) {
  return nodes(root, node => node.tagName === 'TBODY')[0].children;
}
function account(id = 'a1', name = '账号一', weight = 1.9) {
  return { id, name, weight, enabled: true, apiKey: 'user_masked', maxInflight: 0, tags: [], notes: '' };
}
function metric(source = account()) {
  return { ...source, score: 0.242, inFlight: 0, ewmaTtftMs: 800,
    window: { n: 10, ok: 8, avgTtftMs: 900 }, totals: {},
    components: { success: 0.42, latency: 0.88, load: 0.95, quota: 1, weightFactor: 0.19, base: 0.62 } };
}
function usage(credits = {}) {
  return { id: 'a1', name: '账号一', ok: true, subscription: {}, fetchedAt: '2026-10-17T00:00:00Z',
    credits: { hasCreditsInfo: true, usagePercent: 0.2, ...credits } };
}

async function panel(data = {}, { finishAnimations = true } = {}) {
  const elements = Object.fromEntries(['view', 'stats', 'tabs', 'logout', 'app', 'toasts']
    .map(id => [id, new PanelElement('div')]));
  const body = new PanelElement('body');
  Object.values(elements).forEach(element => body.appendChild(element));
  const tabs = {};
  for (const name of ['accounts', 'clients', 'routing', 'metrics', 'usage']) {
    tabs[name] = new PanelElement('button');
    tabs[name].setAttribute('data-tab', name);
    elements.tabs.appendChild(tabs[name]);
  }
  const state = {
    accounts: [account()], clients: [{ id: 'c1', name: '客户端一', token: 'ccp_old', enabled: true, accountIds: null }],
    routing: { selection: 'weighted_random', windowSizeMs: 300000 },
    weightsPercent: { successRate: 50, latency: 30, load: 20, quota: 20 },
    metrics: { accounts: [metric()], cliProtocol: '1.53.1', startedAt: '2026-10-17T00:00:00Z' },
    usage: [usage()], ...data,
  };
  const requests = [];
  const intervals = new Map();
  const timeouts = new Map();
  let nextTimer = 0;
  let testCount = 0;
  const document = {
    body, hidden: false, activeElement: null,
    getElementById: id => elements[id] || nodes(body, node => node.id === id)[0] || null,
    createElement: tag => new PanelElement(tag),
    createTextNode: text => { const node = new PanelElement('#text'); node.textContent = text; return node; },
    querySelector: selector => selector === '.overlay' ? byClass(body, 'overlay')[0] || null : null,
    addEventListener() {},
  };
  const context = vm.createContext({
    document, window: new PanelElement('window'),
    sessionStorage: { getItem: () => ADMIN_TOKEN, setItem() {}, removeItem() {} },
    setInterval(callback, delay) { const id = ++nextTimer; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) { const id = ++nextTimer; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    MutationObserver: class { observe() {} },
    fetch: async (path, options) => {
      const method = options.method;
      requests.push({ path, method });
      let response;
      if (method === 'GET') {
        if (path === '/admin/api/accounts') response = { accounts: state.accounts };
        else if (path === '/admin/api/clients') response = { clients: state.clients };
        else if (path === '/admin/api/routing') response = { routing: state.routing, weightsPercent: state.weightsPercent };
        else if (path === '/admin/api/metrics') response = state.metrics;
        else if (path === '/admin/api/config') response = {};
        else if (path.startsWith('/admin/api/usage')) response = { usage: state.usage, fetchedAt: '2026-10-17T00:00:00Z' };
        else assert.fail('unexpected GET ' + path);
      } else if (path.endsWith('/test')) {
        response = { ok: true, status: 200, elapsedMs: ++testCount, modelCount: testCount };
      } else if (path.endsWith('/reset-metrics')) {
        state.metrics.accounts[0].score = 0.1;
        response = { ok: true };
      } else if (path.endsWith('/rotate')) {
        state.clients[0].token = 'ccp_rotated';
        response = { client: { ...state.clients[0] } };
      } else if (path === '/admin/api/routing') {
        Object.assign(state.routing, JSON.parse(options.body));
        response = { ok: true };
      } else {
        const collection = path.includes('/clients') ? 'clients' : 'accounts';
        const id = path.split('/')[4];
        const patch = options.body ? JSON.parse(options.body) : {};
        if (method === 'POST') {
          const created = { ...patch, id: collection === 'clients' ? 'c2' : 'a2', token: 'ccp_new' };
          state[collection].push(created);
          response = { client: created };
        } else if (method === 'PATCH') {
          Object.assign(state[collection].find(item => item.id === id), patch);
          response = { ok: true };
        } else if (method === 'DELETE') {
          state[collection] = state[collection].filter(item => item.id !== id);
          response = { ok: true };
        } else assert.fail('unexpected write ' + method + ' ' + path);
      }
      const text = JSON.stringify(response);
      return { ok: true, status: 200, text: async () => text };
    },
  });
  async function settle() {
    for (let round = 0; round < 3; round++) {
      await new Promise(resolve => setImmediate(resolve));
      for (const [id, timer] of [...timeouts]) {
        if (finishAnimations && timer.delay === 300) { timeouts.delete(id); timer.callback(); }
      }
    }
  }
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1], context);
  await settle();
  return { ...elements, body, document, state, requests, settle,
    async tab(name) { tabs[name].onclick(); await settle(); },
    async poll() {
      const timers = [...intervals.values()].filter(timer => timer.delay === 2000);
      assert.equal(timers.length, 1, 'exactly one two-second polling timer');
      timers[0].callback();
      await settle();
    },
  };
}

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = html.match(new RegExp(escaped + '\\{([^}]+)\\}'));
  assert.ok(rule, 'CSS rule: ' + selector);
  return rule[1];
}

test('panel polish 01: window columns render exceeded, reset, cap ratios and missing-window fallbacks', async () => {
  const resetAt = '2026-10-18T03:20:00Z';
  const harness = await panel({ usage: [
    usage({ windowLimits: { fiveHour: { used: 5.2, cap: 3, exceeded: true, resetAt }, weekly: { used: 8, cap: 10, exceeded: false, resetAt } } }),
    usage(), usage({ windowLimits: { fiveHour: { used: 0 }, weekly: { used: 0, cap: 0 } } }),
    { id: 'pending', pending: true }, { id: 'failed', ok: false, error: 'upstream unavailable' },
  ] });
  await harness.tab('usage');
  const headerRow = nodes(harness.view, node => node.tagName === 'THEAD')[0].firstChild;
  assert.deepEqual(headerRow.children.map(node => node.textContent),
    ['账号', '套餐', '状态', '剩余', '已用', '总额', '用量', '5 小时窗口', '每周窗口', '到期', '更新时间']);
  const rows = dataRows(harness.view);
  const fiveHour = rows[0].children[7];
  const weekly = rows[0].children[8];
  assert.match(fiveHour.textContent, /5\.20\/3/);
  assert.equal(byClass(fiveHour, 'b-red')[0].textContent, '已超限');
  assert.equal(byClass(fiveHour, 'b-red')[0].style.marginLeft, '6px');
  assert.ok(fiveHour.textContent.includes('重置于 ' + new Date(resetAt).toLocaleString()));
  assert.equal(nodes(fiveHour, node => node.tagName === 'I')[0].style.width, '100%');
  assert.equal(nodes(fiveHour, node => node.tagName === 'I')[0].className, 'bad');
  assert.equal(nodes(weekly, node => node.tagName === 'I')[0].style.width, '80%');
  assert.equal(nodes(weekly, node => node.tagName === 'I')[0].className, 'warn');
  assert.equal(byClass(weekly, 'badge').length, 0);
  for (const row of rows.slice(1, 3)) {
    for (const cell of row.children.slice(7, 9)) {
      assert.equal(cell.textContent, '—');
      assert.equal(nodes(cell, node => node.tagName === 'I').length, 0);
      assert.doesNotMatch(cell.textContent, /0\/0|0%/);
    }
  }
  assert.equal(rows[3].children[1].colSpan, headerRow.children.length);
  assert.equal(rows[4].children[1].colSpan, headerRow.children.length);
});

test('panel polish 02: real score components, blocked annotations and absent-components fallback', async () => {
  const harness = await panel();
  const expected = '评分构成：S 0.42 · L 0.88 · C 0.95 · Q 1.00 · 权重因子 0.19 · 基分 0.62';
  assert.equal(byClass(harness.view, 'score-components')[0].textContent, expected);
  for (const reason of ['cooling', 'windowExhausted', 'creditExhausted']) {
    harness.state.metrics.accounts[0] = { ...metric(), [reason]: true };
    await harness.poll();
    assert.equal(byClass(harness.view, 'score-components')[0].textContent, expected + ' · 评分归零（受阻）');
  }
  delete harness.state.metrics.accounts[0].components;
  await harness.poll();
  assert.equal(byClass(harness.view, 'score-components').length, 0);
  assert.doesNotMatch(harness.view.textContent, /评分构成/);
});

test('panel polish 03: rotate confirmation cancels without requests and confirms before invalidating token', async () => {
  const harness = await panel();
  await harness.tab('clients');
  harness.requests.length = 0;
  button(harness.view, '轮换').onclick();
  assert.equal(byClass(harness.body, 'overlay').length, 1);
  assert.equal(byClass(harness.body, 'modal').length, 1);
  assert.match(harness.body.textContent, /轮换后旧令牌立即失效，使用它的客户端需要更新令牌；此操作不可撤销/);
  assert.deepEqual(harness.requests, []);
  button(harness.body, '取消').onclick();
  await harness.settle();
  assert.deepEqual(harness.requests, []);
  assert.equal(harness.state.clients[0].token, 'ccp_old');
  button(harness.view, '轮换').onclick();
  button(harness.body, '确认轮换').onclick();
  await harness.settle();
  assert.equal(harness.requests.filter(request => request.method === 'POST' && request.path.endsWith('/rotate')).length, 1);
  assert.match(harness.view.textContent, /ccp_rotated/);
  assert.equal(byClass(harness.body, 'token-once')[0].textContent, 'ccp_rotated');
});

test('panel polish 04: reset confirmation cancels without requests and confirms once', async () => {
  const harness = await panel();
  harness.requests.length = 0;
  button(harness.view, '重置指标').onclick();
  assert.equal(byClass(harness.body, 'overlay').length, 1);
  assert.match(harness.body.textContent, /会清空该账号的成功率与延迟样本，评分会立即变化/);
  assert.deepEqual(harness.requests, []);
  button(harness.body, '取消').onclick();
  await harness.settle();
  assert.deepEqual(harness.requests, []);
  button(harness.view, '重置指标').onclick();
  button(harness.body, '确认重置').onclick();
  await harness.settle();
  assert.equal(harness.requests.filter(request => request.method === 'POST' && request.path.endsWith('/reset-metrics')).length, 1);
  assert.match(harness.view.textContent, /0\.100/);
});

test('panel polish 05: repeated account tests replace their result instead of appending', async () => {
  const harness = await panel();
  const host = byClass(harness.view, 'actions')[0];
  button(host, '测试').onclick();
  await harness.settle();
  assert.equal(nodes(host, node => node.className === 'key').length, 1);
  assert.match(host.textContent, /1 个模型/);
  button(host, '测试').onclick();
  assert.equal(nodes(host, node => node.className === 'key').length, 1);
  await harness.settle();
  assert.equal(nodes(host, node => node.className === 'key').length, 1);
  assert.match(host.textContent, /2 个模型/);
  assert.doesNotMatch(host.textContent, /1 个模型/);
  assert.equal(harness.requests.filter(request => request.path.endsWith('/test')).length, 2);
});

test('panel polish 06: metric labels remain unbroken at narrow widths', () => {
  assert.match(cssRule('.rows .k'), /white-space:nowrap/);
  assert.match(cssRule('.rows'), /grid-template-columns:max-content minmax\(0,1fr\)/);
});

test('panel polish 07: live traffic share uses maximum enabled weight and refreshes', async () => {
  const first = account();
  const second = account('a2', '账号二', 10);
  const disabled = { ...account('a3', '停用账号', 100), enabled: false };
  const harness = await panel({ accounts: [first, second], metrics: { accounts: [metric(first), metric(second), metric(disabled)] } });
  assert.match(harness.view.textContent, /实际份额 19\.0%/);
  const range = nodes(harness.view, node => node.type === 'range')[0];
  range.value = '5';
  range.oninput();
  assert.match(harness.view.textContent, /实际份额 50\.0%/);
  harness.state.accounts = [first];
  harness.state.metrics.accounts = [metric(first)];
  await harness.tab('accounts');
  assert.match(harness.view.textContent, /实际份额 100\.0%/);
  harness.state.metrics.accounts = [];
  await harness.poll();
  assert.match(harness.view.textContent, /实际份额 190\.0%/);
  harness.state.metrics.accounts = [metric(first), metric({ ...second, weight: 5 })];
  await harness.poll();
  assert.match(harness.view.textContent, /实际份额 38\.0%/);
});

test('panel polish 08: long card name has top-aligned badge, ellipsis and full title', async () => {
  const name = '超长账号名称'.repeat(30);
  const harness = await panel({ accounts: [account('a1', name)] });
  assert.match(cssRule('.card h3'), /display:flex/);
  assert.match(cssRule('.card h3'), /align-items:flex-start/);
  for (const rule of ['min-width:0', 'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap']) {
    assert.ok(cssRule('.card .account-title').includes(rule), rule);
  }
  assert.match(cssRule('.card h3 .badge'), /flex-shrink:0/);
  const title = byClass(harness.view, 'account-title')[0];
  assert.equal(title.title, name);
  assert.equal(title.textContent, name);
});

test('panel polish 09: timer only fetches metrics; tab switches fetch latest accounts, clients and routing', async () => {
  const harness = await panel();
  harness.requests.length = 0;
  await harness.poll();
  assert.deepEqual(harness.requests, [{ path: '/admin/api/metrics', method: 'GET' }]);
  harness.requests.length = 0;
  harness.document.hidden = true;
  await harness.poll();
  assert.deepEqual(harness.requests, []);
  harness.document.hidden = false;
  const range = nodes(harness.view, node => node.type === 'range')[0];
  harness.document.activeElement = range;
  await harness.poll();
  assert.deepEqual(harness.requests, []);
  harness.document.activeElement = null;
  harness.state.accounts[0].name = '最新账号';
  harness.state.clients[0].name = '最新客户端';
  harness.state.routing.windowSizeMs = 123456;
  harness.state.weightsPercent = { successRate: 20, latency: 50, load: 30, quota: 40 };
  for (const tab of ['clients', 'routing', 'accounts']) {
    harness.requests.length = 0;
    await harness.tab(tab);
    for (const resource of ['accounts', 'clients', 'routing']) {
      assert.ok(harness.requests.some(request => request.path === '/admin/api/' + resource), tab + ' refreshes ' + resource);
    }
    if (tab === 'clients') assert.match(harness.view.textContent, /最新客户端/);
    else if (tab === 'accounts') assert.match(harness.view.textContent, /最新账号/);
    else {
      assert.equal(inputFor(harness.view, '窗口 windowSizeMs').value, '123456');
      assert.equal(inputFor(harness.view, '成功率权重').value, '20');
    }
  }
});

test('panel polish 09 writes: account create, edit, toggle and delete immediately refresh', async () => {
  const harness = await panel();
  button(harness.view, '+ 新增账号').onclick();
  inputFor(harness.body, '名称').value = '新增账号验收';
  inputFor(harness.body, 'API Key（user_...）').value = 'user_new';
  button(harness.body, '创建').onclick();
  await harness.settle();
  assert.match(harness.view.textContent, /新增账号验收/);
  let card = byClass(harness.view, 'card')[1];
  button(card, '编辑').onclick();
  inputFor(harness.body, '名称').value = '编辑账号验收';
  button(harness.body, '保存').onclick();
  await harness.settle();
  card = byClass(harness.view, 'card')[1];
  assert.match(card.textContent, /编辑账号验收/);
  const checkbox = nodes(card, node => node.type === 'checkbox')[0];
  harness.document.activeElement = checkbox;
  checkbox.checked = false;
  checkbox.onchange();
  await harness.settle();
  card = byClass(harness.view, 'card')[1];
  assert.match(card.textContent, /已禁用/);
  button(card, '删除').onclick();
  button(harness.body, '确认删除').onclick();
  await harness.settle();
  assert.doesNotMatch(harness.view.textContent, /编辑账号验收/);
});

test('panel polish 09 writes: client create, edit and delete refresh even with one-time token overlay', async () => {
  const harness = await panel();
  await harness.tab('clients');
  button(harness.view, '+ 新建令牌').onclick();
  inputFor(harness.body, '名称').value = '新令牌验收';
  button(harness.body, '创建').onclick();
  await harness.settle();
  assert.match(harness.view.textContent, /新令牌验收/);
  assert.equal(byClass(harness.body, 'token-once')[0].textContent, 'ccp_new');
  button(harness.body, '我已保存').onclick();
  button(dataRows(harness.view)[1], '编辑').onclick();
  inputFor(harness.body, '名称').value = '编辑令牌验收';
  button(harness.body, '保存').onclick();
  await harness.settle();
  assert.match(harness.view.textContent, /编辑令牌验收/);
  button(dataRows(harness.view)[1], '删除').onclick();
  button(harness.body, '确认删除').onclick();
  await harness.settle();
  assert.doesNotMatch(harness.view.textContent, /编辑令牌验收/);
});

test('panel polish 09 writes: committed changes render during active tab animation and token overlay', async () => {
  const harness = await panel({}, { finishAnimations: false });
  const checkbox = nodes(harness.view, node => node.type === 'checkbox')[0];
  harness.document.activeElement = checkbox;
  checkbox.checked = false;
  checkbox.onchange();
  await harness.settle();
  assert.match(harness.view.textContent, /已禁用/);
  harness.document.activeElement = null;
  await harness.tab('clients');
  button(harness.view, '轮换').onclick();
  button(harness.body, '确认轮换').onclick();
  await harness.settle();
  assert.match(harness.view.textContent, /ccp_rotated/);
  assert.equal(byClass(harness.body, 'token-once')[0].textContent, 'ccp_rotated');
  button(harness.body, '我已保存').onclick();
  button(harness.view, '+ 新建令牌').onclick();
  inputFor(harness.body, '名称').value = '动画中创建';
  button(harness.body, '创建').onclick();
  await harness.settle();
  assert.match(harness.view.textContent, /动画中创建/);
  assert.equal(byClass(harness.body, 'token-once')[0].textContent, 'ccp_new');
});

test('panel polish 09 writes: routing save and manual usage refresh reload full data', async () => {
  const harness = await panel();
  await harness.tab('routing');
  inputFor(harness.view, '窗口 windowSizeMs').value = '123456';
  harness.requests.length = 0;
  const save = nodes(harness.view, node => node.tagName === 'BUTTON' && node.textContent.includes('保存'))[0];
  assert.ok(save);
  harness.document.activeElement = inputFor(harness.view, '窗口 windowSizeMs');
  save.onclick();
  await harness.settle();
  assert.equal(harness.state.routing.windowSizeMs, 123456);
  assert.ok(harness.requests.some(request => request.method === 'PUT' && request.path === '/admin/api/routing'));
  for (const resource of ['accounts', 'clients', 'routing']) {
    assert.ok(harness.requests.some(request => request.method === 'GET' && request.path === '/admin/api/' + resource));
  }
  harness.document.activeElement = null;
  await harness.tab('usage');
  harness.requests.length = 0;
  harness.state.accounts[0].name = '手动刷新账号';
  harness.state.usage[0].name = '手动刷新额度';
  button(harness.view, '刷新').onclick();
  await harness.settle();
  assert.match(harness.view.textContent, /手动刷新额度/);
  for (const resource of ['accounts', 'clients', 'routing']) {
    assert.ok(harness.requests.some(request => request.path === '/admin/api/' + resource));
  }
  assert.ok(harness.requests.some(request => request.path === '/admin/api/usage?refresh=1'));
});

test('panel polish 10: protocol and local startup time render only when provided', async () => {
  const harness = await panel();
  const stats = harness.stats;
  assert.match(stats.textContent, /协议1\.53\.1/);
  assert.ok(stats.textContent.includes('启动' + new Date(harness.state.metrics.startedAt).toLocaleString()));
  delete harness.state.metrics.cliProtocol;
  delete harness.state.metrics.startedAt;
  await harness.poll();
  assert.doesNotMatch(stats.textContent, /协议|启动|1\.0\.0/);
});

test('panel polish 11: unknown credits render dash without zero fill; real zero and thresholds remain distinct', async () => {
  const harness = await panel({ usage: [
    usage({ usagePercent: null }), usage({ hasCreditsInfo: false, usagePercent: 0 }), usage({ usagePercent: 0 }),
    usage({ usagePercent: 0.7 }), usage({ usagePercent: 0.9 }), usage({ usagePercent: 0.1 }),
  ] });
  await harness.tab('usage');
  const cells = dataRows(harness.view).map(row => row.children[6]);
  for (const cell of cells.slice(0, 2)) {
    assert.equal(cell.textContent, '—');
    assert.doesNotMatch(cell.textContent, /0\.0%/);
    assert.equal(nodes(cell, node => node.tagName === 'I').length, 0);
  }
  assert.match(cells[2].textContent, /0\.0%/);
  assert.equal(nodes(cells[2], node => node.tagName === 'I')[0].style.width, '0%');
  assert.equal(byClass(cells[2], 'usage-track').length, 1);
  assert.match(cssRule('.bar.usage-track'), /background:var\(--border-color\)/);
  assert.match(cssRule('.bar.usage-track'), /border:1px solid var\(--text-tertiary\)/);
  assert.equal(nodes(cells[3], node => node.tagName === 'I')[0].className, 'warn');
  assert.equal(nodes(cells[4], node => node.tagName === 'I')[0].className, 'bad');
  assert.equal(nodes(cells[5], node => node.tagName === 'I')[0].className, '');
});

test('panel polish 12: table account names retain full title while using bounded ellipsis', async () => {
  const name = '表格超长账号'.repeat(30);
  const harness = await panel({ usage: [{ ...usage(), name }], metrics: { accounts: [metric(account('a1', name))] } });
  const rule = cssRule('.account-name .table-value');
  assert.match(rule, /max-width:\d+px/);
  for (const property of ['overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap']) assert.ok(rule.includes(property));
  for (const tab of ['usage', 'metrics']) {
    await harness.tab(tab);
    const cell = dataRows(harness.view)[0].children[0];
    assert.ok(cell.classList.contains('account-name'));
    assert.equal(cell.title, name);
    assert.equal(cell.textContent, name);
    assert.equal(byClass(cell, 'table-value').length, 1);
  }
});
