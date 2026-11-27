import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { translations } from './translations.js';

const adapter = await readFile(new URL('../extension/adapters.js', import.meta.url), 'utf8');
const reading = await readFile(new URL('../extension/reading-turns.js', import.meta.url), 'utf8');

// Nodes and attributes used by Gemini's ChatTranscript and ModelResponseContentView.
const prompt = text => `<section data-test-id="user-query"><div data-testid="user-prompt-bubble">
  <div data-testid="user-prompt-content">${text}</div><button>Expand</button></div>
  <div data-testid="user-turn-actions"><button data-testid="user-turn-copy-button" aria-label="复制"></button>
  <button data-testid="user-turn-edit-button" aria-label="修改"></button></div></section>`;
const reply = (text, id, status = 'settled') => `<section data-test-id="model-response" data-turn-status="${status}">
  <div data-testid="chat-thought-card">Thinking notes</div><div data-model-response-turn-id="${id}">
  <div data-testid="collapsible-response-content">${text}</div>
  <div data-hide-from-message-actions>Debug or memory panel</div></div>
  <div role="toolbar" data-testid="chat-response-action-bar"><div>
    <button data-testid="response-copy-button" aria-label="复制回答"></button>
    <button data-testid="response-more-button" aria-label="更多"></button></div></div></section>`;

function setup(t, markup) {
  const window = new JSDOM(`<main>${markup}<form><rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea><button type="button" aria-label="Send message"></button></form></main>`,
    { url: 'https://gemini.google.com/u/1/app/example', runScripts: 'outside-only', pretendToBeVisual: true }).window;
  t.after(() => window.close());
  window.HTMLElement.prototype.getClientRects = function () { return this.style.display === 'contents' ? [] : [{}]; };
  window.document.execCommand = (_cmd, _ui, text) => {
    const node = window.document.querySelector('.ql-editor');
    node.textContent = text;
    node.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
    return true;
  };
  window.eval(translations);
  window.eval(adapter);
  return { window, doc: window.document, api: window.AISplitAdapters };
}

test('section-based Gemini turns support sharing both speakers, selection, native toolbars, bookmarks and compare', async t => {
  const { api, doc, window } = setup(t, `<div data-testid="latest-turn-exchange">${prompt('First question?')}${reply('<p>The <a href="https://example.com/note">reference</a> matters.</p>', 'r1')}</div>
    <aside>${prompt('Unrelated preview')}${reply('Outside this chat', 'unrelated')}</aside>`);
  const items = Array.from(api.messageElements());
  assert.deepEqual(items.map(turn => turn.role), ['user', 'assistant']);
  const [user, answer] = items.map(turn => turn.element);
  assert.equal((await api.readMessage(user)).text, 'First question?');
  const answerText = 'The reference (https://example.com/note) matters.';
  assert.equal((await api.readReply(answer)).text, answerText);
  assert.equal((await api.readResponse()).text, answerText);
  const snapshot = api.readCompareAnswer();
  assert.equal(snapshot.text, answerText);
  assert.equal(api.compareStatus().turn, snapshot.turn);
  assert.equal(api.checkCompareAnswer(snapshot).ok, true);
  assert.equal(api.promptAnchors()[0].parent, doc.querySelector('[data-testid="user-turn-actions"]'));
  const actions = doc.querySelector('[data-testid="response-copy-button"]').parentElement;
  assert.equal(api.replyAnchors()[0].parent, actions);
  assert.equal(api.replyAnchors()[0].before, actions.querySelector('[data-testid="response-more-button"]'));
  const range = doc.createRange();
  range.selectNodeContents(doc.querySelector('a'));
  window.getSelection().addRange(range);
  const selected = await api.readReply(answer);
  assert.equal(selected.text, 'reference');
  assert.equal(selected.partial, true);
  assert.equal((await api.readMessages([answer, user])).text, 'You:\nFirst question?\n\n---\n\nGemini:\n' + answerText);
  window.eval(reading);
  const records = window.AISplitReadingTurns.render({ hidden: [], bookmarks: [] });
  assert.equal(records.length, 2);
  assert.equal(records[1].label, 'The reference matters.');
});

test('Gemini separates thinking and streaming from answers while preserving older settled turns', async t => {
  const { api, doc } = setup(t, `<user-query>First?</user-query><model-response><message-content>Earlier</message-content></model-response>
    ${prompt('Second question?')}${reply('A partial answer', 'new', 'streaming')}`);
  assert.deepEqual(Array.from(api.messageElements(), m => m.role), ['user', 'assistant', 'user', 'assistant']);
  const recent = api.messageElements().at(-1).element;
  assert.equal(api.compareStatus().ready, false);
  assert.equal((await api.readReply(doc.querySelector('model-response'))).text, 'Earlier');
  await assert.rejects(api.readReply(recent), /still responding/);
  doc.querySelector('[data-turn-status]').setAttribute('data-turn-status', 'settled');
  assert.equal(api.readCompareAnswer().text, 'A partial answer');
  doc.querySelector('[data-model-response-turn-id]').remove();
  assert.equal(api.compareStatus().ready, false);
  await assert.rejects(api.readResponse(), /no text/);
  doc.querySelector('[data-test-id="model-response"]').remove();
  await assert.rejects(api.readResponse(), /latest prompt/);
});

test('a review in Gemini binds to its submitted section and completed critique after a native render', async t => {
  const { api, doc } = setup(t, prompt('Question?') + reply('Initial answer.', 'original'));
  const review = { reviewId: 'round-1', peerId: 2 };
  const req = { requestId: 'review', text: 'Critique the competing answer.', answer: api.readCompareAnswer(), review };
  api.preflight(req);
  await api.stage(req);
  await api.validate(req);
  api.commit(req);
  const form = doc.querySelector('form');
  const old = doc.querySelector('[data-test-id="model-response"]');
  old.replaceWith(old.cloneNode(true));
  form.insertAdjacentHTML('beforebegin', `<div id="3f42">${prompt(req.text)}${reply('Verify the estimate.', 'critique')}</div>`);
  const result = api.reviewResult({ ...review, read: true });
  assert.equal(result.ready, true);
  assert.equal(result.original, 'Initial answer.');
  assert.equal(result.text, 'Verify the estimate.');
  const submitted = doc.querySelector('[id="3f42"] [data-test-id="user-query"]');
  submitted.replaceWith(submitted.cloneNode(true));
  assert.equal(api.reviewResult({ ...review, read: true }).text, result.text);
});
