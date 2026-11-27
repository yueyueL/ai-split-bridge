import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { providerFor } from '../extension/providers.js';
import { translations } from './translations.js';

const read = file => readFile(new URL('../extension/' + file, import.meta.url), 'utf8');
const [turnsScript, readingScript, html, popupScript] = await Promise.all(['reading-turns.js', 'reading.js', 'popup.html', 'popup-reading.js'].map(read));
const tick = () => new Promise(done => setTimeout(done, 0));
const popupUrl = 'chrome-extension://fixture/popup.html';

function harness(t) {
  const data = {}, updates = [];
  const local = {
    async get(keys) { return Object.fromEntries([].concat(keys).filter(k => k in data).map(k => [k, data[k]])); },
    async getKeys() { return Object.keys(data); },
    async set(values) {
      Object.assign(data, values);
      const delta = Object.fromEntries(Object.entries(values).map(([k, newValue]) => [k, { newValue }]));
      for (const fn of updates) fn(delta, 'local');
    },
    async remove(key) { delete data[key]; for (const fn of updates) fn({ [key]: {} }, 'local'); },
  };
  const chrome = { storage: { local, onChanged: { addListener: fn => updates.push(fn) } } };
  const page = async (path = '/c/a') => {
    const dom = new JSDOM('<main><article data-testid="conversation-turn-1"><div data-message-id="001" data-role="user">Private prompt</div></article><article data-testid="conversation-turn-2"><div data-message-id="002" data-role="assistant">Private answer</div></article></main>', {
      url: 'https://chatgpt.com' + path, runScripts: 'outside-only',
    });
    t.after(() => dom.window.close());
    const w = dom.window, d = w.document;
    let receive, wide, scrolled;
    w.chrome = { ...chrome, runtime: { id: 'fixture', getURL: () => popupUrl, onMessage: { addListener: fn => { receive = fn; } } } };
    w.HTMLElement.prototype.scrollIntoView = function () { scrolled = this; };
    w.AISplitAdapters = { provider: 'chatgpt', messageElements: () => [...d.querySelectorAll('[data-role]')].map(element => ({ element, role: element.dataset.role })) };
    w.AISplitReadingWidth = { setEnabled(b) { wide = b; }, refresh() {} };
    w.eval(translations);
    w.eval(turnsScript);
    w.eval(readingScript);
    await tick();
    const click = (i, action) => d.querySelectorAll('[data-asb-reading-ui]')[i].shadowRoot.querySelector('[data-action="' + action + '"]').click();
    function send(msg) { return new Promise(resolve => receive(msg, { id: 'fixture', url: popupUrl }, resolve)); }
    return { click, w, d, send, wide: () => wide, scrolled: () => scrolled };
  };
  return { data, local, chrome, page };
}

test('popup options enable page tools and clicking a bookmark reveals its reply in the active tab', async t => {
  const h = harness(t), p = await h.page();
  assert.equal(p.d.querySelector('[data-asb-reading-ui]'), null);
  assert.equal(p.wide(), false);
  let closed = false;
  async function openPopup() {
    const popup = new JSDOM(html, { url: popupUrl, runScripts: 'outside-only' });
    const w = popup.window, close = w.close.bind(w);
    t.after(close);
    w.chrome = { ...h.chrome, tabs: { async query() { return [{ id: 2, url: p.w.location.href }]; },
      async sendMessage(id, msg, options) { assert.equal(id, 2); assert.equal(options.frameId, 0); return p.send(msg); } } };
    w.close = () => { closed = true; close(); };
    w.providerFor = providerFor;
    w.eval(translations);
    w.eval(popupScript.replace(/^import .*\n/, ''));
    await tick();
    return w.document;
  }
  const d = await openPopup();
  d.querySelector('#readingWide').click();
  d.querySelector('#readingTools').click();
  await tick();
  assert.equal(p.wide(), true);
  p.click(1, 'bookmark');
  p.click(1, 'fold');
  await tick();
  assert.equal(p.d.querySelectorAll('[data-asb-reading-collapsed]').length, 1);
  assert.doesNotMatch(JSON.stringify(h.data), /Private answer|Private prompt/);
  const second = await h.page();
  assert.equal(second.d.querySelectorAll('[data-asb-reading-collapsed]').length, 1, 'fold survives a reload');
  // Reopen the popup. Each popup lists the currently focused pane.
  const reopened = await openPopup();
  const jump = reopened.querySelector('#reading-items button');
  assert.match(jump.textContent, /Private answer/);
  jump.click();
  await tick();
  assert.ok(closed);
  assert.equal(p.d.querySelector('[data-asb-reading-collapsed]'), null);
  assert.equal(second.d.querySelector('[data-asb-reading-collapsed]'), null, 'the other copy of the same chat updates');
  assert.match(p.scrolled().textContent, /Private answer/);
});

test('a stale popup cannot jump in a different chat and temporary chats keep markers off disk', async t => {
  const h = harness(t);
  await h.local.set({ readingTools: true });
  const p = await h.page();
  p.click(0, 'bookmark');
  const list = () => p.send({ type: 'ASB_READING_LIST' });
  const previous = await list();
  p.w.history.pushState({}, '', '/c/b');
  const changed = await list();
  assert.equal(changed.total, 0);
  const refused = await p.send({ type: 'ASB_READING_JUMP', page: previous.page, key: previous.items[0].key });
  assert.equal(refused.ok, false);
  await tick();
  const keys = Object.keys(h.data).sort();
  p.w.history.pushState({}, '', '/?temporary-chat=true');
  p.click(0, 'bookmark'); // The controller rejects the stale handler from chat b.
  assert.equal((await list()).total, 0);
  p.click(0, 'bookmark');
  assert.equal((await list()).total, 1);
  await tick();
  assert.deepEqual(Object.keys(h.data).sort(), keys);
  p.w.history.pushState({}, '', '/c/a');
  assert.equal((await list()).total, 1);
});

test('message tools and the popup’s bookmark list follow the chosen language', async t => {
  const h = harness(t);
  await h.local.set({ readingTools: true });
  const p = await h.page();
  const control = (i, action) => p.d.querySelectorAll('[data-asb-reading-ui]')[i].shadowRoot.querySelector(`[data-action="${action}"]`);
  assert.equal(control(0, 'fold').title, 'Hide prompt');
  assert.equal(control(1, 'bookmark').title, 'Bookmark reply');

  p.w.AISplitI18n.choose('zh-CN');
  assert.equal(control(0, 'fold').title, '隐藏提问');
  assert.equal(control(1, 'fold').textContent, '隐藏');
  assert.equal(control(1, 'bookmark').getAttribute('aria-label'), '为回复添加书签');
  p.click(1, 'bookmark');
  p.click(0, 'fold');
  await tick();
  assert.equal(control(1, 'bookmark').title, '移除书签');
  assert.equal(control(0, 'fold').textContent, '显示提问');

  const popup = new JSDOM(html, { url: popupUrl, runScripts: 'outside-only' });
  const w = popup.window;
  t.after(() => w.close());
  w.chrome = { ...h.chrome, tabs: { async query() { return [{ id: 2, url: p.w.location.href }]; }, async sendMessage(_id, message) { return p.send(message); } } };
  w.providerFor = providerFor;
  w.eval(translations);
  w.AISplitI18n.use('zh-CN');
  w.eval(popupScript.replace(/^import .*\n/, ''));
  await tick();
  await tick();
  assert.match(w.document.querySelector('#reading-items button').textContent, /^回复 · .*Private answer/);
  w.AISplitI18n.choose('en');
  await tick();
  await tick();
  assert.match(w.document.querySelector('#reading-items button').textContent, /^Reply · .*Private answer/);

  await h.local.remove('readingTools');
  const empty = new JSDOM(html, { url: popupUrl, runScripts: 'outside-only' });
  t.after(() => empty.window.close());
  empty.window.chrome = { ...h.chrome, tabs: { async query() { return [{ id: 3, url: 'https://example.com/' }]; } } };
  empty.window.providerFor = providerFor;
  empty.window.eval(translations);
  empty.window.AISplitI18n.use('zh-CN');
  empty.window.eval(popupScript.replace(/^import .*\n/, ''));
  await tick();
  empty.window.document.querySelector('#readingTools').click();
  await tick();
  await tick();
  assert.equal(empty.window.document.querySelector('#reading-detail').textContent, '打开一个 AI 聊天即可查看其中的书签。');
});
