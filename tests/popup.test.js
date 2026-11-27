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

async function popup(t, storage, sendMessage = async () => ({ ok: true, tabs: [], canManageSplit: false })) {
  const dom = new JSDOM(html, { url: 'https://fixture.test/popup.html', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.testSettings = settingsModule;
  window.chrome = { storage: { sync: storage }, runtime: { sendMessage } };
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
  assert.equal(view.$('#share-message').value, settingsModule.DEFAULT_CONVERSATION_MESSAGE);
  view.choose('conversation');
  assert.match(view.$('#share-message').value, /Please continue from this context/);
  assert.equal(view.$('#content-placeholder').textContent, '{content}');
  view.type('From {assistant}:\n{content}\nOnly identify missing requirements.');
  view.choose('comparison'); // Flush the conversation edit without waiting for autosave.
  view.type('My comparison: {answers}\nAnswer in plain English.');
  view.$('#send-now').checked = false;
  view.$('#send-now').dispatchEvent(new view.window.Event('change'));
  await until(() => view.$('#saved').textContent === 'Saved');
  assert.equal(data.settings.shareMode, 'draft');
  assert.equal(data.settings.shareMessage, 'Existing reply: {reply}');
  assert.equal(data.settings.conversationMessage, 'From {assistant}:\n{content}\nOnly identify missing requirements.');
  assert.equal(data.settings.comparisonMessage, 'My comparison: {answers}\nAnswer in plain English.');

  const reopened = await popup(t, storage);
  reopened.choose('conversation');
  assert.equal(reopened.$('#share-message').value, data.settings.conversationMessage);
  reopened.$('#reset-message').click();
  await until(() => data.settings.conversationMessage === settingsModule.DEFAULT_CONVERSATION_MESSAGE);
  assert.equal(data.settings.shareMessage, 'Existing reply: {reply}', 'reset changes only the selected template');
  assert.equal(data.settings.comparisonMessage, 'My comparison: {answers}\nAnswer in plain English.');
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
  view.choose('comparison');
  view.type('  ');
  view.$('#share-message').dispatchEvent(new view.window.Event('blur'));
  await until(() => view.$('#saved').textContent === 'Saved');
  assert.equal(data.settings.comparisonMessage, settingsModule.DEFAULT_COMPARISON_MESSAGE);
  assert.equal(view.$('#share-message').value, settingsModule.DEFAULT_COMPARISON_MESSAGE);
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
  view.choose('conversation');
  assert.equal(view.$('#share-message').value, older.conversationMessage);
  assert.equal(view.$('#assistant-placeholder').hidden, false);
  assert.equal(view.$('#content-placeholder').dataset.insert, '{content}');
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
  for (const key of ['shareMessage', 'promptMessage', 'conversationMessage']) assert.equal(data.settings[key], older[key]);
});

test('common review guidance is separate from built-in action prompts', async t => {
  const data = { settings: { shareMode: 'draft', errorsMessage: 'Check arithmetic.' } };
  const storage = memory(data);
  const view = await popup(t, storage);
  view.choose('reviewCommon');
  assert.equal(view.$('#share-message').value, '');
  assert.equal(view.$('#share-message').labels[0].textContent, 'Instructions for all cross-reviews');
  assert.equal(view.$('#share-message').getAttribute('aria-describedby'), 'template-hint');
  assert.equal(view.$('#assistant-placeholder').hidden, true);
  assert.equal(view.$('#content-placeholder').hidden, true);
  view.type('Explain any assumptions.');
  view.window.dispatchEvent(new view.window.Event('pagehide'));
  await until(() => data.settings.reviewGuidance === 'Explain any assumptions.');
  const reopened = await popup(t, storage);
  reopened.choose('reviewCommon');
  assert.equal(reopened.$('#share-message').value, 'Explain any assumptions.');
  reopened.$('#reset-message').click();
  await until(() => data.settings.reviewGuidance === '');
  assert.equal(data.settings.errorsMessage, 'Check arithmetic.');
  assert.equal(data.settings.shareMode, 'draft');
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
const englishFooter = 'In Split View, click the other assistant’s name beside Copy to share a message and its supported files. Use the arrow to choose or add an action, change chats, or leave files out.';

test('the popup opens in English and switches to Chinese and back as soon as a language is chosen', async t => {
  const storage = memory();
  const view = await popup(t, storage);
  assert.equal(view.$('#language').value, 'auto');
  assert.equal(shown(view, '#pair'), 'Create split');
  assert.equal(shown(view, '#message-label'), 'Message with selected messages');
  assert.equal(shown(view, 'footer'), englishFooter);

  pickLanguage(view, 'zh-CN');
  assert.equal(view.window.document.documentElement.lang, 'zh-CN');
  assert.equal(shown(view, '#pair'), '创建分屏');
  assert.equal(shown(view, '#share-kind option[value="conversation"]'), '所选消息');
  assert.equal(shown(view, '#message-label'), '分享所选消息时附带的消息');
  assert.equal(shown(view, '#mode-detail'), '立即发送分享的消息、对比和互评。');
  assert.equal(view.$('#assistant-placeholder').title, '助手的名称，例如 ChatGPT');
  assert.match(shown(view, 'footer'), /点小箭头可选择或添加动作、更换聊天/);
  assert.equal(shown(view, 'footer b'), '复制');
  assert.equal(shown(view, '#template-settings summary'), '消息模板');
  assert.equal(view.$('#share-message').value, settingsModule.defaultMessages('zh-CN').conversationMessage);
  assert.equal(shown(view, '#language option[value="zh-CN"]'), '简体中文');
  await until(() => storage.data.language === 'zh-CN');
  await until(() => shown(view, '#capability') === '右键点击 AI 聊天标签页，选择“分屏视图”来配对。');

  pickLanguage(view, 'en');
  assert.equal(view.window.document.documentElement.lang, 'en');
  assert.equal(shown(view, '#pair'), 'Create split');
  assert.equal(shown(view, 'footer'), englishFooter);
  assert.equal(shown(view, '#template-settings summary'), 'Message templates');
  assert.equal(view.$('#share-message').value, settingsModule.DEFAULT_CONVERSATION_MESSAGE);
  await until(() => storage.data.language === 'en');
  await until(() => shown(view, '#capability') === 'Right-click an AI chat tab and choose Split View to pair it.');
});

test('a saved language is used when the popup opens, and a customized message is left as written', async t => {
  const storage = memory({ language: 'zh-CN', settings: { conversationMessage: 'Context: {content}' } });
  const view = await popup(t, storage);
  assert.equal(view.$('#language').value, 'zh-CN');
  assert.equal(shown(view, '#pair'), '创建分屏');
  assert.equal(view.$('#share-message').value, 'Context: {content}');
  view.choose('comparison');
  assert.equal(shown(view, '#message-label'), '对比指令');
  assert.equal(view.$('#share-message').value, settingsModule.defaultMessages('zh-CN').comparisonMessage);
  view.choose('reviewCommon');
  assert.equal(view.$('#share-message').placeholder, '例如：每条批评都要给出依据。');

  view.choose('conversation');
  view.$('#reset-message').click();
  await until(() => shown(view, '#saved') === '已保存');
  assert.equal(storage.data.settings.conversationMessage, settingsModule.defaultMessages('zh-CN').conversationMessage);
  pickLanguage(view, 'en');
  assert.equal(view.$('#share-message').value, settingsModule.DEFAULT_CONVERSATION_MESSAGE, 'a reset message follows the language again');
  view.choose('comparison');
  assert.equal(view.$('#share-message').value, settingsModule.DEFAULT_COMPARISON_MESSAGE);
});

// ---------- Opening an assistant from the Split View form ----------
function browserWith(tabs, { peer = null, reply = { ok: true, message: 'Split View ready.' }, lastPair = null, canManageSplit = true } = {}) {
  const sent = [];
  const browser = {
    sent, lastPair,
    async sendMessage(message) {
      if (message.type === 'ASB_LIST') return { ok: true, tabs, activeId: tabs[0]?.id, canManageSplit, peer, lastPair: browser.lastPair };
      sent.push(structuredClone(message));
      return reply;
    },
  };
  return browser;
}
const options = (view, selector) => Array.from(view.$(selector).options, option => [option.value, option.textContent]);
const submitPair = view => view.$('#pair-form').dispatchEvent(new view.window.Event('submit', { cancelable: true }));

test('each side of a new split can be an open chat or an assistant to open', async t => {
  const browser = browserWith([{ id: 7, name: 'Claude', title: 'Trip plan', index: 0 }]);
  const view = await popup(t, memory(), browser.sendMessage);
  await until(() => !view.$('#pair-section').hidden);
  assert.deepEqual(options(view, '#right'), [
    ['', 'Choose a chat…'], ['7', 'Claude · Trip plan'],
    ['new:chatgpt', 'New ChatGPT chat'], ['new:claude', 'New Claude chat'], ['new:gemini', 'New Gemini chat'], ['new:grok', 'New Grok chat'],
  ]);
  assert.equal(view.$('#right optgroup').label, 'Open a new chat');
  assert.equal(view.$('#left').value, '7', 'the open chat is offered on the left');
  assert.equal(view.$('#right').value, '');
  assert.equal(view.$('#pair').disabled, false, 'one open chat is enough');

  submitPair(view);
  await until(() => shown(view, '#status') === 'Choose a chat for each side.');
  assert.deepEqual(browser.sent, [], 'nothing is asked for until both sides are chosen');

  view.$('#right').value = 'new:gemini';
  submitPair(view);
  assert.equal(shown(view, '#status'), 'Opening the chat and creating the split…');
  await until(() => shown(view, '#status') === 'Split View ready.');
  assert.deepEqual(browser.sent, [{ type: 'ASB_PAIR', leftId: 7, rightProvider: 'gemini' }]);
});

test('with no AI chat open, two assistants can be chosen and opened together', async t => {
  const browser = browserWith([]);
  const view = await popup(t, memory({ language: 'zh-CN' }), browser.sendMessage);
  await until(() => !view.$('#pair-section').hidden && view.$('#left').options.length > 1);
  assert.deepEqual(options(view, '#left'), [
    ['', '选择一个聊天…'], ['new:chatgpt', '新的 ChatGPT 聊天'], ['new:claude', '新的 Claude 聊天'], ['new:gemini', '新的 Gemini 聊天'], ['new:grok', '新的 Grok 聊天'],
  ]);
  assert.equal(view.$('#left optgroup').label, '新开一个聊天');
  assert.equal(view.$('#pair').disabled, false);
  view.$('#left').value = 'new:claude';
  view.$('#right').value = 'new:gemini';
  submitPair(view);
  assert.equal(shown(view, '#status'), '正在打开聊天并创建分屏…');
  await until(() => browser.sent.length === 1);
  assert.deepEqual(browser.sent, [{ type: 'ASB_PAIR', leftProvider: 'claude', rightProvider: 'gemini' }]);
});

test('two open chats are still paired by their tabs, and a choice survives the list refreshing', async t => {
  const browser = browserWith([{ id: 3, name: 'ChatGPT', title: 'One', index: 0 }, { id: 4, name: 'Claude', title: 'Two', index: 1 }]);
  const view = await popup(t, memory(), browser.sendMessage);
  await until(() => view.$('#left').value === '3');
  assert.equal(view.$('#right').value, '4');
  view.$('#right').value = 'new:grok';
  pickLanguage(view, 'zh-CN');
  await until(() => shown(view, '#right option[value="new:grok"]') === '新的 Grok 聊天');
  assert.equal(view.$('#right').value, 'new:grok', 'redrawing the list keeps what was chosen');
  view.$('#right').value = '4';
  submitPair(view);
  await until(() => browser.sent.length === 1);
  assert.deepEqual(browser.sent, [{ type: 'ASB_PAIR', leftId: 3, rightId: 4 }]);
});

// ---------- One click for the last pair ----------
test('the last pair of assistants can be opened again with one click', async t => {
  const browser = browserWith([], { lastPair: { left: 'gemini', right: 'claude' } });
  const view = await popup(t, memory(), browser.sendMessage);
  await until(() => !view.$('#pair-last').hidden);
  assert.equal(shown(view, '#pair-last'), 'Open Gemini + Claude');
  assert.match(view.$('#pair-last').title, /^Gemini on the left and Claude on the right, as last time\./);
  view.$('#pair-last').click();
  assert.equal(shown(view, '#status'), 'Opening the chat and creating the split…');
  await until(() => shown(view, '#status') === 'Split View ready.');
  assert.deepEqual(browser.sent, [{ type: 'ASB_PAIR_LAST' }]);

  pickLanguage(view, 'zh-CN');
  await until(() => shown(view, '#pair-last') === '打开 Gemini + Claude');
  assert.match(view.$('#pair-last').title, /^和上次一样，Gemini 在左侧、Claude 在右侧。/);
});

test('the one-click button appears once a pair has been made, and only where splits can be created', async t => {
  const browser = browserWith([{ id: 3, name: 'ChatGPT', title: 'One', index: 0 }]);
  const view = await popup(t, memory(), browser.sendMessage);
  await until(() => !view.$('#pair-section').hidden);
  assert.equal(view.$('#pair-last').hidden, true, 'nothing is remembered yet');
  view.$('#right').value = 'new:grok';
  browser.lastPair = { left: 'chatgpt', right: 'grok' };
  submitPair(view);
  await until(() => !view.$('#pair-last').hidden);
  assert.equal(shown(view, '#pair-last'), 'Open ChatGPT + Grok');

  for (const browser of [
    browserWith([], { lastPair: { left: 'gemini', right: 'claude' }, canManageSplit: false }),
    browserWith([], { lastPair: { left: 'gemini', right: 'perplexity' } }),
  ]) {
    const other = await popup(t, memory(), browser.sendMessage);
    await until(() => other.$('#left').options.length > 1);
    assert.equal(other.$('#pair-last').hidden, true);
  }
});
