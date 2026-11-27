import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/i18n.js', import.meta.url), 'utf8');

// Each test gets its own copy, as each popup, tab and service worker does.
function load() {
  const scope = {};
  scope.globalThis = scope;
  vm.runInNewContext(source, scope);
  return scope.AISplitI18n;
}

// A small model of chrome.storage.sync and chrome.i18n.
function browser({ stored = {}, ui = 'en-US' } = {}) {
  const listeners = [];
  return {
    api: {
      i18n: { getUILanguage: () => ui },
      storage: {
        sync: { async get(key) { return key in stored ? { [key]: stored[key] } : {}; } },
        onChanged: { addListener(fn) { listeners.push(fn); } },
      },
    },
    change(language, area = 'sync') {
      for (const fn of listeners) fn({ language: { newValue: language } }, area);
    },
  };
}

test('English text is returned as written, with named values filled in', () => {
  const { t } = load();
  assert.equal(t('Send both'), 'Send both');
  assert.equal(t('Sent to {name}, now on the {side}.', { name: 'Claude', side: 'right' }), 'Sent to Claude, now on the right.');
});

test('a registered language translates known text and leaves unknown text in English', () => {
  const i18n = load();
  i18n.register('zh-CN', { 'Send both': '同时发送', 'Draft added to {name}.': '草稿已添加到 {name}。' });
  i18n.use('zh-CN');
  assert.equal(i18n.language, 'zh-CN');
  assert.equal(i18n.t('Send both'), '同时发送');
  assert.equal(i18n.t('Draft added to {name}.', { name: 'Gemini' }), '草稿已添加到 Gemini。');
  assert.equal(i18n.t('Not translated yet'), 'Not translated yet');
  i18n.use('en');
  assert.equal(i18n.t('Send both'), 'Send both');
});

test('values are inserted once, and braces without a matching value are kept', () => {
  const { t } = load();
  assert.equal(t('{name} said {reply}', { name: '{reply}', reply: 'hello' }), '{reply} said hello');
  assert.equal(t('Insert {assistant} or {reply}', { reply: 'text' }), 'Insert {assistant} or text');
  assert.equal(t('Keep {reply} as typed'), 'Keep {reply} as typed');
});

test('an unsupported language is ignored', () => {
  const i18n = load();
  i18n.use('fr');
  assert.equal(i18n.language, 'en');
});

test('the automatic choice follows the browser language, and an explicit choice wins', () => {
  const { resolve } = load();
  assert.equal(resolve('auto', 'zh-CN'), 'zh-CN');
  assert.equal(resolve(undefined, 'zh-TW'), 'zh-CN');
  assert.equal(resolve('auto', 'en-US'), 'en');
  assert.equal(resolve('auto', ''), 'en');
  assert.equal(resolve('something else', 'ja'), 'en');
  assert.equal(resolve('en', 'zh-CN'), 'en');
  assert.equal(resolve('zh-CN', 'en-US'), 'zh-CN');
});

test('names are joined in the current language', () => {
  const i18n = load();
  i18n.register('zh-CN', { ' and ': ' 和 ', ', ': '、' });
  assert.equal(i18n.list(['Claude']), 'Claude');
  assert.equal(i18n.list(['Claude', 'Gemini']), 'Claude and Gemini');
  assert.equal(i18n.list(['ChatGPT', 'Claude', 'Gemini']), 'ChatGPT, Claude and Gemini');
  i18n.use('zh-CN');
  assert.equal(i18n.list(['Claude', 'Gemini']), 'Claude 和 Gemini');
  assert.equal(i18n.list(['ChatGPT', 'Claude', 'Gemini']), 'ChatGPT、Claude 和 Gemini');
});

test('following the saved choice applies it now and again whenever it changes', async () => {
  const i18n = load();
  i18n.register('zh-CN', { 'Send both': '同时发送' });
  const chrome = browser({ stored: { language: 'zh-CN' } });
  const seen = [];
  await i18n.follow(chrome.api, language => seen.push(language));
  assert.equal(i18n.t('Send both'), '同时发送');
  assert.equal(i18n.choice, 'zh-CN');

  chrome.change('en');
  assert.equal(i18n.t('Send both'), 'Send both');
  chrome.change('en');
  chrome.change('zh-CN', 'local');
  assert.equal(i18n.language, 'en', 'only the synced setting counts');
  chrome.change(undefined);
  assert.equal(i18n.choice, 'auto');
  assert.deepEqual(seen, ['zh-CN', 'en'], 'listeners hear each real change once');
});

test('with nothing saved the browser language decides', async () => {
  const chinese = load();
  await chinese.follow(browser({ ui: 'zh-CN' }).api);
  assert.equal(chinese.language, 'zh-CN');
  assert.equal(chinese.choice, 'auto');

  const english = load();
  await english.follow(browser({ ui: 'en-GB' }).api);
  assert.equal(english.language, 'en');
});

test('English stays in use when the saved choice cannot be read', async () => {
  const i18n = load();
  await i18n.follow({ storage: { sync: { async get() { throw new Error('Storage is unavailable.'); } } } });
  assert.equal(i18n.language, 'en');
  await i18n.follow({});
  assert.equal(i18n.language, 'en');
});

test('a choice made in the popup applies at once and tells every listener', async () => {
  const i18n = load();
  const seen = [];
  i18n.onChange(language => seen.push(`reading:${language}`));
  await i18n.follow(browser({ ui: 'zh-CN' }).api, language => seen.push(`popup:${language}`));
  assert.equal(i18n.language, 'zh-CN');

  assert.equal(i18n.choose('en'), true);
  assert.equal(i18n.language, 'en');
  assert.equal(i18n.choice, 'en');
  assert.equal(i18n.choose('en'), false, 'choosing the same language again changes nothing');
  assert.equal(i18n.choose('auto'), true);
  assert.equal(i18n.language, 'zh-CN', 'automatic goes back to the browser language');
  assert.deepEqual(seen, ['reading:zh-CN', 'popup:zh-CN', 'reading:en', 'popup:en', 'reading:zh-CN', 'popup:zh-CN']);
});
