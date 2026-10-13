import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class PanelElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.childNodes = [];
    this.attributes = {};
  }
  get children() { return this.childNodes.filter(child => child.tagName); }
  get firstChild() { return this.childNodes[0]; }
  get textContent() { return this.childNodes.map(child => child.textContent).join(''); }
  set textContent(value) {
    this.childNodes = value === '' ? [] : [{ textContent: String(value), parentNode: this }];
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  removeChild(child) {
    this.childNodes.splice(this.childNodes.indexOf(child), 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
}

function panelHelpers() {
  const source = readFileSync(new URL('../proxy.mjs', import.meta.url), 'utf8');
  const helpers = source.slice(source.indexOf('function el(tag,cls,text)'), source.indexOf('function fmtDur(ms)'));
  const context = vm.createContext({ document: { createElement: tag => new PanelElement(tag) } });
  vm.runInContext(helpers, context);
  return context;
}

test('表格封装：按表头自动生成标签，保留值节点与按钮，空单元格不添加容器', () => {
  const { el, append, tableWrap } = panelHelpers();
  const table = el('table');
  const head = el('thead');
  const headerRow = el('tr');
  for (const label of [' 名称 ', '状态', '新增列', '操作', '空值']) append(headerRow, el('th', null, label));
  append(table, append(head, headerRow));
  const body = el('tbody');
  const row = el('tr');
  const badge = el('span', 'badge b-green', '启用');
  const button = el('button', 'btn tiny', '删除');
  const click = () => 'deleted';
  button.onclick = click;
  append(row, el('td', null, '中转'), append(el('td'), badge), el('td', null, '自动映射'),
    append(el('td'), append(el('div', 'actions'), button)), el('td'));
  append(table, append(body, row));
  const wrap = tableWrap(table, true);
  assert.equal(wrap.className, 'table-wrap plain');
  assert.equal(wrap.firstChild, table);
  assert.deepEqual(row.children.map(cell => cell.getAttribute('data-label')), ['名称', '状态', '新增列', '操作', '空值']);
  assert.deepEqual(row.children.map(cell => cell.textContent), ['中转', '启用', '自动映射', '删除', '']);
  assert.equal(row.children[1].firstChild.firstChild, badge);
  assert.equal(row.children[3].firstChild.firstChild.firstChild, button);
  assert.equal(button.onclick, click);
  assert.equal(row.children[4].firstChild, undefined);
});

test('表格封装：无表头安全跳过，colSpan 按实际列映射，缺少 setAttribute 不报错', () => {
  const { el, append, tableWrap } = panelHelpers();
  const table = el('table');
  const body = el('tbody');
  const row = el('tr');
  const account = el('td', null, '中转');
  const failure = el('td', null, '读取失败');
  failure.colSpan = 2;
  const last = el('td', null, '末列');
  append(table, append(body, append(row, account, failure, last)));
  tableWrap(table);
  assert.equal(account.getAttribute('data-label'), null);
  assert.equal(account.firstChild.textContent, '中转');
  const head = el('thead');
  const headerRow = el('tr');
  for (const label of ['账号', '套餐', '状态', '更新时间']) append(headerRow, el('th', null, label));
  append(table, append(head, headerRow));
  tableWrap(table);
  assert.deepEqual(row.children.map(cell => cell.getAttribute('data-label')), ['账号', '套餐', '更新时间']);
  const minimal = el('td', null, '无属性接口');
  minimal.setAttribute = undefined;
  append(body, append(el('tr'), minimal));
  assert.doesNotThrow(() => tableWrap(table));
});
