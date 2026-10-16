import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../proxy.mjs', import.meta.url), 'utf8');

function splitMobileSource(input) {
  const mobileBlocks = [];
  const outsideBlocks = [];
  let cursor = 0;
  for (const match of input.matchAll(/@media\s*\(max-width:\s*640px\)\s*\{/g)) {
    outsideBlocks.push(input.slice(cursor, match.index));
    let depth = 1;
    let end = match.index + match[0].length;
    const start = end;
    while (depth && end < input.length) {
      if (input[end] === '{') depth += 1;
      if (input[end] === '}') depth -= 1;
      end += 1;
    }
    mobileBlocks.push(input.slice(start, end - 1));
    cursor = end;
  }
  outsideBlocks.push(input.slice(cursor));
  return { mobileCss: mobileBlocks.join('\n'), outsideMobile: outsideBlocks.join('') };
}

const { mobileCss, outsideMobile } = splitMobileSource(source);
const mobileRules = [...mobileCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(match => ({ selectors: match[1].trim().split(',').map(selector => selector.trim()), body: match[2] }));

function declarations(selector) {
  return Object.fromEntries(mobileRules.filter(rule => rule.selectors.includes(selector))
    .flatMap(rule => rule.body.split(';').filter(Boolean).map(declaration => {
      const separator = declaration.indexOf(':');
      return [declaration.slice(0, separator).trim(), declaration.slice(separator + 1).trim()];
    })));
}

test('移动顶栏：状态胶囊单行横向滚动，不保留 220px 最小宽度', () => {
  const stats = declarations('header#bar .stats');
  assert.equal(stats['flex-wrap'], 'nowrap');
  assert.equal(stats['overflow-x'], 'auto');
  assert.equal(stats['min-width'], '0');
  assert.equal(stats['max-width'], '100%');
  assert.equal(stats['scrollbar-width'], 'none');
  assert.equal(declarations('header#bar .stats::-webkit-scrollbar').display, 'none');
  assert.equal(declarations('header#bar .stat').flex, '0 0 auto');
  const statsRules = mobileRules.filter(rule => rule.selectors.some(selector => /\.stats(?:$|[:\s])/.test(selector)));
  for (const rule of statsRules) {
    assert.doesNotMatch(rule.body, /min-width\s*:\s*[1-9]\d*px/);
    assert.doesNotMatch(rule.body, /flex-wrap\s*:\s*wrap(?:\s*[;} ]|$)/);
    assert.doesNotMatch(rule.body, /(?:^|;)\s*flex\s*:\s*1(?:\s*;|$)/);
  }
});

test('移动顶栏：品牌与右侧按钮同排，状态区独占第二排', () => {
  const header = declarations('header#bar');
  assert.equal(header.display, 'grid');
  assert.equal(header['grid-template-columns'], 'auto minmax(0,1fr) auto auto');
  assert.equal(header['grid-template-areas'], '"lights brand theme logout" "stats stats stats stats"');
  for (const [selector, area] of [
    ['header#bar .lights', 'lights'], ['header#bar .brand', 'brand'],
    ['header#bar .theme-toggle', 'theme'], ['header#bar #logout', 'logout'],
    ['header#bar .stats', 'stats'],
  ]) {
    assert.equal(declarations(selector)['grid-area'], area);
  }
  assert.equal(declarations('header#bar .spacer').display, 'none');
});

test('移动触控：tab、主题、登出及 tiny 按钮最小高度至少 40px', () => {
  for (const selector of ['.tab', 'header#bar .theme-toggle', '.btn', '.btn.tiny']) {
    const height = declarations(selector)['min-height'];
    assert.match(height ?? '', /^\d+(?:\.\d+)?px$/, selector + ' needs a pixel min-height');
    assert.ok(Number.parseFloat(height) >= 40, selector + ' must be at least 40px tall');
  }
  assert.ok(Number.parseFloat(declarations('header#bar .theme-toggle')['min-width']) >= 40);
});

test('移动 tab 栏：单行滚动，文字不压缩，不重写选中态', () => {
  const tabs = declarations('nav#tabs');
  assert.equal(tabs['flex-wrap'], 'nowrap');
  assert.equal(tabs['overflow-x'], 'auto');
  assert.equal(declarations('.tab').flex, '0 0 auto');
  assert.equal(declarations('.tab')['white-space'], 'nowrap');
  assert.equal(mobileRules.some(rule => rule.selectors.includes('.tab.active')), false);
});

test('窄屏隔离：新增布局仅在 640px 媒体查询内，桌面布局与新增规则生效', async () => {
  for (const signature of [
    'grid-template-areas:"lights brand theme logout" "stats stats stats stats"',
    'grid-area:stats', 'scrollbar-width:none', 'min-height:40px',
  ]) {
    assert.ok(mobileCss.includes(signature), 'mobile media query must contain ' + signature);
    assert.ok(!outsideMobile.includes(signature), 'must not affect desktop: ' + signature);
  }
  for (const signature of ['flex-wrap:nowrap', 'overflow-x:auto', 'scrollbar-width:none', '.stats::-webkit-scrollbar{display:none}']) {
    assert.ok(mobileCss.includes(signature), 'mobile media query must contain ' + signature);
  }
  for (const signature of ['flex-wrap:nowrap', 'scrollbar-width:none']) {
    assert.ok(!outsideMobile.includes(signature), 'must not affect desktop: ' + signature);
  }
  const desktopCss = [...outsideMobile.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)]
    .map(match => match[1]).join('\n');
  const desktopRules = [...desktopCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(match => ({ selectors: match[1].trim().split(',').map(selector => selector.trim()), body: match[2] }));
  const savedMobileRules = mobileRules.splice(0, mobileRules.length, ...desktopRules);
  try {
    for (const selector of ['.stats', 'header#bar .stats', 'nav#tabs']) {
      const desktop = declarations(selector);
      for (const [property, value] of [['flex-wrap', 'nowrap'], ['overflow-x', 'auto'], ['scrollbar-width', 'none']]) {
        assert.notEqual(desktop[property], value, 'must not affect desktop: ' + selector + ' ' + property);
      }
    }
    assert.notEqual(declarations('nav#tabs')['flex-wrap'], 'nowrap');
    assert.equal(declarations('.rows .k')['white-space'], 'nowrap');
    assert.equal(declarations('.card h3')['align-items'], 'flex-start');
    assert.equal(declarations('.account-name .table-value')['text-overflow'], 'ellipsis');
  } finally {
    mobileRules.splice(0, mobileRules.length, ...savedMobileRules);
  }

  const { default: vm } = await import('node:vm');
  class PanelElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.textContent = '';
      this.className = '';
      this.listeners = new Map();
      this.classList = {
        contains: name => this.className.split(/\s+/).includes(name),
        add: name => { if (!this.classList.contains(name)) this.className = (this.className + ' ' + name).trim(); },
        remove: name => { this.className = this.className.split(/\s+/).filter(value => value !== name).join(' '); },
      };
    }
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
    get firstChild() { return this.children[0]; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    getAttribute(name) { return this[name]; }
    contains(child) { return this === child || this.children.some(node => node.contains(child)); }
  }
  const elements = Object.fromEntries(['view', 'stats', 'tabs', 'logout', 'app', 'toasts']
    .map(id => [id, new PanelElement('div')]));
  const stats = elements.stats;
  stats.className = 'stats';
  stats.clientWidth = 1280;
  stats.scrollWidth = 1280;
  stats.scrollLeft = 0;
  const requests = [];
  let poll;
  const context = vm.createContext({
    INIT_WEIGHTS: {},
    window: new PanelElement('window'),
    document: {
      getElementById: id => elements[id], createElement: tag => new PanelElement(tag),
      querySelector: () => null, addEventListener() {}, body: new PanelElement('body'),
    },
    sessionStorage: { getItem: () => 'adm_desktop_contract' },
    setInterval(callback) { poll = callback; }, clearInterval() {}, setTimeout() {},
    MutationObserver: class { observe() {} },
    fetch: async path => {
      requests.push(path);
      return { ok: true, status: 200, text: async () => '{}' };
    },
  });
  const html = source.slice(source.indexOf('const html = `<!doctype html>'));
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, 'execute the real panel script');
  for (const script of scripts) vm.runInContext(script[1], context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 5, 'boot must execute the real data refresh');
  assert.equal(stats.classList.contains('has-more'), false, 'non-overflowing desktop must not show the hint');
  assert.ok(stats.children.filter(node => node.classList.contains('stat')).length >= 7, 'render at least seven real status capsules');
  stats.scrollWidth = 2000;
  poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stats.classList.contains('has-more'), true, 'overflow must enable the hint after rendering');
  stats.scrollWidth = 1280;
  poll();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stats.classList.contains('has-more'), false, 'removing overflow must clear the hint after rendering');
});
