import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { setup } from './helpers.mjs';

const ADMIN_TOKEN = 'adm_panel_test';
const ADMIN = { 'x-admin-token': ADMIN_TOKEN };
const DEFAULT_PERCENT = { successRate: 50, latency: 30, load: 20, quota: 20 };

async function withSetup(fn, routing) {
  const cwd = routing === undefined ? undefined : mkdtempSync(join(tmpdir(), 'ccp-panel-'));
  if (cwd) writeFileSync(join(cwd, 'accounts.json'), JSON.stringify({ routing }));
  const harness = await setup({ cwd, env: { CC_ADMIN_TOKEN: ADMIN_TOKEN } });
  try { return await fn(harness.proxy); }
  finally {
    await harness.close();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }
}

async function readPanel(proxy, expectedWeights, expectedPercent) {
  const response = await proxy.get('/admin/api/routing', { headers: ADMIN });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.routing.weights, expectedWeights);
  const page = await proxy.get('/admin');
  assert.equal(page.status, 200);
  const html = await page.text();
  const injection = html.match(/\bvar INIT_WEIGHTS\s*=\s*(\{[^;]+\});/);
  assert.ok(injection, 'HTML must inject INIT_WEIGHTS JSON');
  assert.deepEqual(JSON.parse(injection[1]), expectedPercent);
  assert.deepEqual(data.weightsPercent, expectedPercent);
  return { html, data };
}

async function putWeights(proxy, weights) {
  const response = await fetch(proxy.base + '/admin/api/routing', {
    method: 'PUT',
    headers: { ...ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ weights }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).routing.weights, {
    ...weights, latency: Math.max(0, weights.latency), quota: Math.min(1000, Math.max(0, weights.quota)),
  });
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
  set value(value) {
    const number = Number(value);
    this.inputValue = this.type === 'range'
      ? String(Math.min(Number(this.max), Math.max(Number(this.min), Math.round(number))))
      : String(value);
  }
  get value() { return this.inputValue || ''; }
}

async function renderPanel(html, data) {
  const elements = Object.fromEntries(['view', 'stats', 'tabs', 'logout', 'app', 'toasts']
    .map(id => [id, new PanelElement('div')]));
  const tab = new PanelElement('button');
  tab['data-tab'] = 'routing';
  elements.tabs.appendChild(tab);
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
    fetch: async (path, options) => {
      requests.push({ path, options });
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify(path.endsWith('/routing') ? data : path.endsWith('/metrics') ? {
          accounts: [{ name: 'preview', enabled: true, weight: 1,
            components: { success: 0.8, latency: 0.4, load: 0.6 } }],
        } : {}),
      };
    },
  });
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(script[1], context);
  }
  await new Promise(resolve => setImmediate(resolve));
  tab.onclick();
  const nodes = [];
  function collect(node) { nodes.push(node); node.children.forEach(collect); }
  collect(elements.view);
  return { nodes, requests };
}

test('路由权重：HTML 初值、实际滑块、归一化与预览同为百分比，保存仍为分数', async () => {
  await withSetup(async proxy => {
    const weights = { successRate: 0.2, latency: 0.5, load: 0.3, quota: 0.2 };
    const percent = { successRate: 20, latency: 50, load: 30, quota: 20 };
    await putWeights(proxy, weights);
    const { html, data } = await readPanel(proxy, weights, percent);
    const { nodes, requests } = await renderPanel(html, data);
    const sliders = nodes.filter(node => node.type === 'range');
    const quota = nodes.find(node => node.children.some(child => child.textContent === '额度权重 quota'))
      .children.find(node => node.tagName === 'INPUT');
    assert.deepEqual([...sliders, quota].map(node => Number(node.value)), Object.values(percent));
    assert.deepEqual([...sliders.map(node => node.parentNode.children[2].textContent), String(quota.value)], ['20', '50', '30', '20']);
    assert.ok(nodes.some(node => node.textContent === '归一化权重：成功率 16.7% · 延迟 41.7% · 负载 25.0% · 额度 16.7%'));
    assert.ok(nodes.some(node => node.tagName === 'TD' && node.textContent === '0.617'));
    nodes.find(node => node.tagName === 'BUTTON' && node.textContent === '保存路由配置').onclick();
    const saved = requests.find(request => request.options.method === 'PUT');
    assert.ok(saved, 'save button must submit routing');
    const body = JSON.parse(saved.options.body);
    assert.deepEqual(body.weights, weights);
    await putWeights(proxy, body.weights);
    await readPanel(proxy, weights, percent);
  });
});

for (const [name, weights, expectedWeights, percent] of [
  ['上边界', { successRate: 1, latency: 0, load: 0, quota: 0 }, { successRate: 1, latency: 0, load: 0, quota: 0 },
    { successRate: 100, latency: 0, load: 0, quota: 0 }],
  ['越界 clamp', { successRate: 1.4, latency: -1, load: 0.3, quota: 1001 }, { successRate: 1.4, latency: 0, load: 0.3, quota: 1000 },
    { successRate: 100, latency: 0, load: 30, quota: 100 }],
  ['取整', { successRate: 0.206, latency: 0.494, load: 0.3, quota: 0.206 }, { successRate: 0.206, latency: 0.494, load: 0.3, quota: 0.206 },
    { successRate: 21, latency: 49, load: 30, quota: 21 }],
]) {
  test('路由权重百分比：' + name, async () => {
    await withSetup(async proxy => {
      await putWeights(proxy, weights);
      await readPanel(proxy, expectedWeights, percent);
    });
  });
}

for (const [name, routing] of [
  ['缺失 weights', {}],
  ['非数字 weights', { weights: { successRate: 'invalid', latency: 'invalid', load: 'invalid', quota: 'invalid' } }],
]) {
  test('路由权重百分比：' + name + ' 使用默认值', async () => {
    await withSetup(proxy => readPanel(proxy,
      { successRate: 0.5, latency: 0.3, load: 0.2, quota: 0.2 }, DEFAULT_PERCENT), routing);
  });
}
