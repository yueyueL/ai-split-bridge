import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { summaryPrompt, composeHandoff } from '../extension/summary.js';
import { mockChrome, deferred } from './mock-chrome.js';
import { translations } from './translations.js';

const adapterSource = await readFile(new URL('../extension/adapters.js', import.meta.url), 'utf8');
const page = 'https://chatgpt.com/c/project';

async function setup(t, { peer = false, sync = {} } = {}) {
  const tabs = [{ id: 1, url: page }, ...(peer ? [{ id: 2, url: 'https://claude.ai/chat/next' }] : [])];
  const model = mockChrome(tabs, { sync });
  let listener;
  const event = { addListener() {} };
  Object.assign(model.api.tabs, Object.fromEntries(
    ['onUpdated', 'onMoved', 'onAttached', 'onDetached', 'onCreated', 'onRemoved', 'onActivated'].map(name => [name, event]),
  ));
  model.api.storage.onChanged = event;
  model.api.windows = { onRemoved: event };
  model.api.runtime = {
    id: 'test-extension', getURL: path => 'chrome-extension://test-extension/' + path,
    onMessage: { addListener(fn) { listener = fn; } },
  };
  globalThis.chrome = model.api;
  t.after(() => delete globalThis.chrome);
  await import(`../extension/background.js?summary=${Math.random()}`);
  const sender = { id: 'test-extension', frameId: 0, url: page, documentId: 'original-document', tab: { id: 1 } };
  return { model, request: message => new Promise(resolve => listener(message, sender, resolve)) };
}

function composer(t, model, existing = '') {
  const { window } = new JSDOM(`<form><textarea id="prompt-textarea"></textarea>
    <button type="button" data-testid="send-button">Send</button></form>`,
  { url: page, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => window.close());
  window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 40 }];
  window.eval(translations);
  window.eval(adapterSource);
  const editor = window.document.querySelector('textarea');
  editor.value = existing;
  const sent = [];
  window.document.querySelector('button').addEventListener('click', () => {
    sent.push(editor.value);
    editor.value = '';
  });
  const actions = { ASB_PREPARE: 'preflight', ASB_STAGE: 'stage', ASB_VALIDATE: 'validate',
    ASB_KEEP: 'keep', ASB_COMMIT: 'commit', ASB_CANCEL: 'cancel' };
  model.respond = async (_id, message) => {
    try { return await window.AISplitAdapters[actions[message.type]](message); }
    catch (error) { return { ok: false, error: error.message, retry: !!error.retry }; }
  };
  return { window, editor, sent };
}

test('a summary request is sent once to the clicked chat without a split or another chat', async t => {
  const { model, request } = await setup(t);
  const { sent } = composer(t, model);
  const result = await request({ type: 'ASB_SUMMARIZE', page, send: true, sourceId: 99 });
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(sent, [summaryPrompt('en')]);
  assert.match(sent[0], /quote essential final text, code, or values verbatim/i);
  assert.match(sent[0], /Do not edit any existing files or artifacts/);
  assert.deepEqual(model.messages().map(call => call.args[1].type), ['ASB_PREPARE', 'ASB_STAGE', 'ASB_VALIDATE', 'ASB_COMMIT', 'ASB_CANCEL']);
  assert.ok(model.messages().every(call => call.args[0] === 1 && call.args[2].documentId === 'original-document'));
});

test('a summary draft stays in the current composer and respects the interface language', async t => {
  const { model, request } = await setup(t, { sync: { language: 'zh-CN' } });
  const { window, editor, sent } = composer(t, model);
  window.document.querySelector('button').disabled = true;
  const result = await request({ type: 'ASB_SUMMARIZE', page, send: false });
  assert.equal(result.ok, true, result.error);
  assert.equal(editor.value, summaryPrompt('zh-CN'));
  assert.match(editor.value, /关键产出请保持原样/);
  assert.deepEqual(sent, []);
  assert.equal(model.messages('ASB_KEEP').length, 1);
});

test('summary protects an existing draft, an attachment, and a response in progress', async t => {
  const { model, request } = await setup(t);
  const { window, editor, sent } = composer(t, model, 'My draft with original wording');
  const summarize = () => request({ type: 'ASB_SUMMARIZE', send: true, page });
  assert.match((await summarize()).error, /already has a draft/);
  assert.equal(editor.value, 'My draft with original wording');
  editor.value = '';
  const preview = window.document.createElement('div');
  preview.dataset.testid = 'file-preview';
  editor.parentElement.append(preview);
  assert.match((await summarize()).error, /already has attachments/);
  assert.ok(preview.isConnected);
  preview.remove();
  const stop = window.document.createElement('button');
  stop.dataset.testid = 'stop-button';
  editor.parentElement.append(stop);
  assert.match((await summarize()).error, /still responding/);
  assert.deepEqual(sent, []);
  assert.equal(model.messages('ASB_STAGE').length, 0);
});

test('summary refuses a stale menu and protects a same-document navigation before staging', async t => {
  const { model, request } = await setup(t);
  const { window, editor, sent } = composer(t, model);
  assert.match((await request({ type: 'ASB_SUMMARIZE', send: true, page: page + '-old' })).error, /chat changed/);
  assert.equal(model.messages().length, 0);
  // A Chrome tab snapshot can briefly lag behind the SPA route. The adapter
  // checks the expected URL against the editor's live document as well.
  window.history.pushState({}, '', '/c/different');
  assert.match((await request({ type: 'ASB_SUMMARIZE', send: true, page })).error, /chat changed/);
  assert.equal(model.messages('ASB_STAGE').length, 0);
  assert.equal(editor.value, '');
  assert.deepEqual(sent, []);
});

test('a second summary request during staging cannot submit a duplicate', async t => {
  const { model, request } = await setup(t);
  const { sent } = composer(t, model);
  const response = model.respond;
  const staging = deferred();
  const resume = deferred();
  model.respond = async (id, message) => {
    if (message.type === 'ASB_STAGE') { staging.resolve(); await resume.promise; }
    return response(id, message);
  };
  const message = { type: 'ASB_SUMMARIZE', send: true, page };
  const pending = request(message);
  await staging.promise;
  try {
    assert.match((await request(message)).error, /Another bridge action is running/);
  } finally { resume.resolve(); }
  assert.equal((await pending).ok, true);
  assert.deepEqual(sent, [summaryPrompt('en')]);
});

test('context sharing forwards the exact selected content and files with a continuation request', async t => {
  const { model, request } = await setup(t, { peer: true, sync: { settings: { shareMode: 'draft', shareMessage: 'Critique {reply}' } } });
  model.respond = () => ({ ok: true });
  const content = 'Decision: v2.\n\n    exact_code({reply});\n\nhttps://example.test/docs';
  const files = [{ name: 'final.md', type: 'text/markdown', data: btoa('# Original') }];
  const result = await request({ type: 'ASB_SHARE', targetId: 2, kind: 'handoff', reply: content, files });
  assert.equal(result.ok, true, result.error);
  const [tab, payload] = model.messages('ASB_STAGE')[0].args;
  assert.equal(tab, 2);
  assert.equal(payload.text, composeHandoff({ assistant: 'ChatGPT', content }, 'en'));
  assert.ok(payload.text.endsWith(content));
  assert.doesNotMatch(payload.text, /Critique/);
  assert.deepEqual(payload.files, files);
  assert.equal(model.messages('ASB_KEEP').length, 1);
  assert.equal(model.messages('ASB_COMMIT').length, 0);
});
