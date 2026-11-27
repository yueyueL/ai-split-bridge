import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as settingsModule from '../extension/settings.js';
import { translations } from './translations.js';

const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
const script = (await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8'))
  .replace(/^import (.+) from '\.\/settings\.js';/m, 'const $1 = globalThis.testSettings;');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let n = 0; n < 100; n++) { if (check()) return; await delay(10); }
  assert.fail('Popup did not reach the expected state.');
}

async function popup(t, storage) {
  const dom = new JSDOM(html, { url: 'https://fixture.test/popup.html', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.testSettings = settingsModule;
  window.chrome = { storage: { sync: storage }, runtime: { sendMessage: async () => ({ ok: true, tabs: [], canManageSplit: false }) } };
  window.eval(translations);
  window.eval(script);
  const $ = selector => window.document.querySelector(selector);
  await until(() => !$('#share-kind').disabled || $('#saved').textContent.startsWith('Could not load'));
  return {
    $, window,
    choose: value => { $('#share-kind').value = value; $('#share-kind').dispatchEvent(new window.Event('change')); },
    type: value => { $('#share-message').value = value; $('#share-message').dispatchEvent(new window.Event('input')); },
  };
}

test('popup saves separate templates through rapid changes, delivery-mode changes, and reopening', async t => {
  const data = { settings: { shareMessage: 'Existing reply: {reply}' } };
  const storage = {
    async get(key) { await delay(10); return structuredClone({ [key]: data[key] }); },
    async set(value) { await delay(20); Object.assign(data, structuredClone(value)); },
  };
  const view = await popup(t, storage);
  assert.equal(view.$('#share-message').value, 'Existing reply: {reply}');
  view.choose('conversation');
  assert.match(view.$('#share-message').value, /Please continue from this context/);
  assert.equal(view.$('#content-placeholder').textContent, '{content}');
  view.type('From {assistant}:\n{content}\nOnly identify missing requirements.');
  view.choose('prompt'); // Flush the conversation edit without waiting for autosave.
  view.type('My question: {content}\nAnswer in plain English.');
  view.$('#send-now').checked = false;
  view.$('#send-now').dispatchEvent(new view.window.Event('change'));
  await until(() => view.$('#saved').textContent === 'Saved');
  assert.equal(data.settings.shareMode, 'draft');
  assert.equal(data.settings.shareMessage, 'Existing reply: {reply}');
  assert.equal(data.settings.conversationMessage, 'From {assistant}:\n{content}\nOnly identify missing requirements.');
  assert.equal(data.settings.promptMessage, 'My question: {content}\nAnswer in plain English.');

  const reopened = await popup(t, storage);
  reopened.choose('conversation');
  assert.equal(reopened.$('#share-message').value, data.settings.conversationMessage);
  reopened.$('#reset-message').click();
  await until(() => data.settings.conversationMessage === settingsModule.DEFAULT_CONVERSATION_MESSAGE);
  assert.equal(data.settings.shareMessage, 'Existing reply: {reply}', 'reset changes only the selected template');
  assert.equal(data.settings.promptMessage, 'My question: {content}\nAnswer in plain English.');
});

test('popup inserts the selected-text placeholder and saves on close; blank restores that template', async t => {
  const data = {};
  const storage = {
    async get() { return structuredClone(data); },
    async set(value) { Object.assign(data, structuredClone(value)); },
  };
  const view = await popup(t, storage);
  view.choose('conversation');
  view.type('Review: ');
  view.$('#share-message').setSelectionRange(8, 8);
  view.$('#content-placeholder').click();
  view.window.dispatchEvent(new view.window.Event('pagehide'));
  await until(() => data.settings?.conversationMessage === 'Review: {content}');
  assert.equal(view.$('#content-placeholder').dataset.insert, '{content}');
  view.choose('prompt');
  view.type('  ');
  view.$('#share-message').dispatchEvent(new view.window.Event('blur'));
  await until(() => data.settings.promptMessage === settingsModule.DEFAULT_PROMPT_MESSAGE);
  assert.equal(view.$('#share-message').value, settingsModule.DEFAULT_PROMPT_MESSAGE);
  assert.equal(data.settings.conversationMessage, 'Review: {content}');
});

test('popup keeps settings controls disabled when saved settings cannot be read', async t => {
  const view = await popup(t, { async get() { throw new Error('Storage unavailable'); } });
  assert.equal(view.$('#share-kind').disabled, true);
  assert.equal(view.$('#share-message').disabled, true);
  assert.match(view.$('#saved').textContent, /Storage unavailable/);
});

test('Compare has an editable template that persists and resets independently of sharing', async t => {
  const older = {
    shareMode: 'draft', shareMessage: 'Critique {reply}',
    promptMessage: 'Answer {content}', conversationMessage: 'Continue from {content}',
  };
  const data = { settings: { ...older } };
  const storage = {
    async get(key) { return structuredClone({ [key]: data[key] }); },
    async set(values) { Object.assign(data, structuredClone(values)); },
  };
  const view = await popup(t, storage);
  assert.equal(view.$('#share-kind option[value="comparison"]').textContent, 'Compare');
  view.choose('comparison');
  assert.equal(view.$('#share-message').labels[0].textContent, 'Comparison instructions');
  assert.equal(view.$('#share-message').value, settingsModule.DEFAULT_COMPARISON_MESSAGE);
  assert.ok(view.$('#assistant-placeholder').hidden);
  assert.equal(view.$('#content-placeholder').dataset.insert, '{answers}');
  assert.equal(view.$('#send-now').checked, false);

  const instruction = 'Which disagreement would change the decision?';
  view.type(instruction + '\n');
  const end = view.$('#share-message').value.length;
  view.$('#share-message').setSelectionRange(end, end);
  view.$('#content-placeholder').click();
  view.choose('reply');
  assert.equal(view.$('#share-message').value, older.shareMessage);
  assert.equal(view.$('#assistant-placeholder').hidden, false);
  assert.equal(view.$('#content-placeholder').dataset.insert, '{reply}');
  await until(() => view.$('#saved').textContent === 'Saved');

  const reopened = await popup(t, storage);
  reopened.choose('comparison');
  assert.equal(reopened.$('#share-message').value, instruction + '\n{answers}');
  reopened.$('#reset-message').click();
  await until(() => reopened.$('#saved').textContent === 'Saved');
  const reset = await popup(t, storage);
  reset.choose('comparison');
  assert.equal(reset.$('#share-message').value, settingsModule.DEFAULT_COMPARISON_MESSAGE);
  assert.equal(reset.$('#send-now').checked, false);
  for (const [kind, key] of [['reply', 'shareMessage'], ['prompt', 'promptMessage'], ['conversation', 'conversationMessage']]) {
    reset.choose(kind);
    assert.equal(reset.$('#share-message').value, older[key]);
  }
});

test('cross-review shares one optional instruction and retains each mode’s independent edits', async t => {
  const data = { settings: { shareMode: 'draft', shareMessage: 'Review {reply}', comparisonMessage: 'Compare {answers}' } };
  const storage = {
    async get(key) { return key == null ? structuredClone(data) : { [key]: structuredClone(data[key]) }; },
    async set(values) { Object.assign(data, structuredClone(values)); },
  };
  const editor = '#share-message';
  const modes = { critique: 'Explain the weakest premise.', errors: '核实每个数字。', improvements: 'Prioritize practical changes.' };
  const guidance = 'Review as a first-year tutor. State uncertainties.';
  const view = await popup(t, storage);
  const options = view.$('optgroup[label="Cross-review"]').querySelectorAll('option');
  assert.deepEqual(Array.from(options, option => option.textContent),
    ['All review modes', 'Critique', 'Find errors', 'Suggest improvements']);
  view.choose('reviewCommon');
  assert.equal(view.$(editor).value, '');
  assert.equal(view.$(editor).labels[0].textContent, 'Instructions for all cross-reviews');
  assert.match(view.$('#template-hint').textContent, /both chats.*all three/);
  assert.equal(view.$(editor).getAttribute('aria-describedby'), 'template-hint');
  view.type(guidance);
  for (const [mode, text] of Object.entries(modes)) {
    view.choose(mode);
    assert.equal(view.$(editor).value, settingsModule.REVIEW_TEMPLATES[mode].default);
    assert.equal(view.$(editor).labels[0].textContent, 'Cross-review instructions');
    assert.match(view.$('#template-hint').textContent, /other assistant’s answer/);
    assert.ok(view.$('#assistant-placeholder').hidden && view.$('#content-placeholder').hidden);
    view.type(text);
  }
  view.window.dispatchEvent(new view.window.Event('pagehide'));
  await until(() => view.$('#saved').textContent === 'Saved');

  const reopened = await popup(t, storage);
  for (const [mode, text] of Object.entries({ ...modes, reviewCommon: guidance })) {
    reopened.choose(mode);
    assert.equal(reopened.$(editor).value, text);
  }
  reopened.choose('errors');
  reopened.$('#reset-message').click();
  await until(() => data.settings.errorsMessage === settingsModule.REVIEW_TEMPLATES.errors.default);
  reopened.choose('reviewCommon');
  assert.equal(reopened.$(editor).value, guidance);
  reopened.type('   ');
  reopened.$(editor).dispatchEvent(new reopened.window.Event('blur'));
  await until(() => data.settings.reviewGuidance === '');
  assert.equal(reopened.$(editor).value, '');
  reopened.type(guidance);
  reopened.$('#reset-message').click();
  await until(() => reopened.$('#saved').textContent === 'Saved');

  const reset = await popup(t, storage);
  for (const [mode, text] of Object.entries({
    ...modes, errors: settingsModule.REVIEW_TEMPLATES.errors.default, reviewCommon: '',
    comparison: 'Compare {answers}', reply: 'Review {reply}',
  })) {
    reset.choose(mode);
    assert.equal(reset.$(editor).value, text);
  }
  assert.equal(reset.$('#send-now').checked, false);
  assert.equal(reset.$('#assistant-placeholder').hidden, false);
  assert.equal(reset.$('#content-placeholder').hidden, false);
  assert.equal(reset.$('#template-hint').textContent, 'Insert');
});

// ---------- Interface language ----------
function memory(data = {}) {
  return {
    data,
    async get(key) { return key == null ? structuredClone(data) : { [key]: structuredClone(data[key]) }; },
    async set(value) { Object.assign(data, structuredClone(value)); },
  };
}
const shown = (view, selector) => view.$(selector).textContent;
function pickLanguage(view, value) {
  view.$('#language').value = value;
  view.$('#language').dispatchEvent(new view.window.Event('change'));
}
const englishFooter = '“Send both” sits beside each chat’s Send button. “Share with…” sits beside Copy. Use “Select messages…” in the composer’s arrow menu to share several messages together.'.replace(/[“”]/g, '');

test('the popup opens in English and switches to Chinese and back as soon as a language is chosen', async t => {
  const storage = memory();
  const view = await popup(t, storage);
  assert.equal(view.$('#language').value, 'auto');
  assert.equal(shown(view, '#pair'), 'Create split');
  assert.equal(shown(view, '#message-label'), 'Message with the shared reply');
  assert.equal(shown(view, 'footer'), englishFooter);

  pickLanguage(view, 'zh-CN');
  assert.equal(view.window.document.documentElement.lang, 'zh-CN');
  assert.equal(shown(view, '#pair'), '创建分屏');
  assert.equal(shown(view, '#share-kind option[value="reply"]'), '回复');
  assert.equal(view.$('#share-kind optgroup').label, '互评');
  assert.equal(shown(view, '#message-label'), '分享回复时附带的消息');
  assert.equal(shown(view, '#mode-detail'), '立即发送分享的消息、对比和互评。');
  assert.equal(view.$('#assistant-placeholder').title, '助手的名称，例如 ChatGPT');
  assert.deepEqual([...view.window.document.querySelectorAll('footer b')].map(node => node.textContent), ['同时发送', '分享到…', '选择消息…']);
  assert.equal(view.$('#share-message').value, settingsModule.defaultMessages('zh-CN').shareMessage);
  assert.equal(shown(view, '#language option[value="zh-CN"]'), '简体中文');
  await until(() => storage.data.language === 'zh-CN');
  await until(() => shown(view, '#capability') === '右键点击 AI 聊天标签页，选择“分屏视图”来配对。');

  pickLanguage(view, 'en');
  assert.equal(view.window.document.documentElement.lang, 'en');
  assert.equal(shown(view, '#pair'), 'Create split');
  assert.equal(shown(view, 'footer'), englishFooter);
  assert.equal(view.window.document.querySelectorAll('footer b').length, 3);
  assert.equal(view.$('#share-message').value, settingsModule.DEFAULT_SHARE_MESSAGE);
  await until(() => storage.data.language === 'en');
  await until(() => shown(view, '#capability') === 'Right-click an AI chat tab and choose Split View to pair it.');
});

test('a saved language is used when the popup opens, and a customized message is left as written', async t => {
  const storage = memory({ language: 'zh-CN', settings: { shareMessage: 'Existing reply: {reply}' } });
  const view = await popup(t, storage);
  assert.equal(view.$('#language').value, 'zh-CN');
  assert.equal(shown(view, '#pair'), '创建分屏');
  assert.equal(view.$('#share-message').value, 'Existing reply: {reply}');
  view.choose('prompt');
  assert.equal(shown(view, '#message-label'), '分享提问时附带的消息');
  assert.equal(view.$('#share-message').value, settingsModule.defaultMessages('zh-CN').promptMessage);
  view.choose('reviewCommon');
  assert.equal(view.$('#share-message').placeholder, '例如：每条批评都要给出依据。');

  view.choose('reply');
  view.$('#reset-message').click();
  await until(() => shown(view, '#saved') === '已保存');
  assert.equal(storage.data.settings.shareMessage, settingsModule.defaultMessages('zh-CN').shareMessage);
  pickLanguage(view, 'en');
  assert.equal(view.$('#share-message').value, settingsModule.DEFAULT_SHARE_MESSAGE, 'a reset message follows the language again');
  view.choose('prompt');
  assert.equal(view.$('#share-message').value, settingsModule.DEFAULT_PROMPT_MESSAGE);
});
