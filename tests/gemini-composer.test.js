import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { translations } from './translations.js';

const adapter = await readFile(new URL('../extension/adapters.js', import.meta.url), 'utf8');
const quill = await readFile(new URL('./fixtures/gemini-quill-composer.html', import.meta.url), 'utf8');
// The form, prompt-input and distinct Send/Stop test IDs come from Gemini's ChatInput component.
const lexical = `<form><div role="textbox" aria-multiline="true" contenteditable="true"
  data-test-id="prompt-input" data-lexical-editor="true"><p><br></p></div>
  <div class="actions"><button type="button" aria-label="Spracheingabe">Mic</button>
  <button type="submit" data-test-id="send-button" aria-label="Nachricht senden">↑</button></div></form>`;

function setup(t, html) {
  const dom = new JSDOM(html, { url: 'https://gemini.google.com/u/2/app/test', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom, doc = window.document;
  window.HTMLElement.prototype.getClientRects = function () { return [this.getBoundingClientRect()]; };
  window.DataTransfer = class {
    constructor() { this.data = new Map(); }
    setData(type, value) { this.data.set(type, value); }
    getData(type) { return this.data.get(type) || ''; }
  };
  window.ClipboardEvent = class extends window.Event {
    constructor(type, init) { super(type, init); this.clipboardData = init.clipboardData; }
  };
  doc.execCommand = (_, _ui, value) => {
    const range = window.getSelection().getRangeAt(0);
    range.deleteContents();
    range.insertNode(doc.createTextNode(value));
    return true;
  };
  doc.addEventListener('submit', event => event.preventDefault());
  const lexicalEditor = doc.querySelector('[data-lexical-editor]');
  lexicalEditor?.addEventListener('paste', event => {
    event.preventDefault();
    const paragraphs = event.clipboardData.getData('text/plain').split('\n').map(line => {
      const p = doc.createElement('p');
      p.append(line ? doc.createTextNode(line) : doc.createElement('br'));
      return p;
    });
    lexicalEditor.replaceChildren(...paragraphs);
  });
  lexicalEditor?.addEventListener('beforeinput', event => {
    if (event.inputType === 'deleteContentBackward' && !window.getSelection().isCollapsed) lexicalEditor.replaceChildren();
  });
  window.eval(translations);
  window.eval(adapter);
  const clicks = [];
  doc.addEventListener('click', event => clicks.push(event.target));
  return { a: window.AISplitAdapters, doc, clicks };
}

for (const source of [false, true]) {
  test(`Gemini Lexical form can be the ${source ? 'source' : 'destination'} for Send both`, async t => {
    const { a, doc, clicks } = setup(t, '<main>' + lexical + '</main><aside><button aria-label="Send">Unrelated</button></aside>');
    const editor = doc.querySelector('[data-lexical-editor]');
    const send = doc.querySelector('[type=submit]');
    const request = { requestId: 'lexical', source, text: 'First line\n\nLast line' };
    if (source) editor.innerHTML = '<p><span data-lexical-text="true">First line</span></p><p><br></p><p>Last line</p>';
    assert.equal(a.ownsEditor(editor), true);
    assert.ok(doc.querySelector('form').contains(a.composerAnchor().parent));
    a.preflight(request);
    await a.stage(request);
    assert.equal(a.getDraft().text, request.text);
    await a.validate(request);
    assert.equal(clicks.length, 0);
    a.commit(request);
    assert.deepEqual(clicks, [send]);
  });
}

test('Gemini source waits for a localized Quill submit action to replace its microphone after typing', async t => {
  const { a, doc, clicks } = setup(t, quill);
  const editor = doc.querySelector('.ql-editor');
  editor.textContent = 'A fresh draft';
  const request = { requestId: 'angular', source: true, text: editor.textContent };
  const button = doc.getElementById('send'), host = button.parentElement;
  button.setAttribute('aria-label', 'Nachricht senden');
  button.innerHTML = '<mat-icon aria-hidden="true" data-mat-icon-name="arrow_upward"></mat-icon>';
  button.remove();
  a.preflight(request);
  await a.stage(request);
  const validate = a.validate(request);
  setTimeout(() => host.append(button), 50);
  await validate;
  a.commit(request);
  assert.deepEqual(clicks, [button]);
});

test('Gemini rechecks its own current submit control and refuses a stopped or ambiguous composer', async t => {
  const { a, doc, clicks } = setup(t, '<main>' + lexical + '<button aria-label="Send">Send feedback</button></main>');
  const request = { requestId: 'changing', source: false, text: 'Please check this.' };
  a.preflight(request);
  await a.stage(request);
  await a.validate(request);
  const send = doc.querySelector('[type=submit]');
  send.type = 'button';
  send.setAttribute('data-test-id', 'stop-button');
  send.setAttribute('aria-label', 'Antwort beenden');
  assert.throws(() => a.commit(request), /still responding/);
  send.remove();
  assert.throws(() => a.commit(request), /Cannot identify/);
  assert.equal(clicks.length, 0);
});

test('an inline Gemini announcement does not mask Send or offer one from its live region', async t => {
  const { a, doc, clicks } = setup(t, quill);
  const area = doc.querySelector('.text-input-field'), announce = doc.createElement('div');
  announce.setAttribute('role', 'log');
  announce.setAttribute('aria-live', 'polite');
  announce.innerHTML = '<button aria-label="Send">Outside composer actions</button>';
  area.append(announce);
  doc.querySelector('.ql-editor').textContent = 'Example';
  const request = { requestId: 'live-region', source: true, text: 'Example' };
  a.preflight(request);
  await a.stage(request);
  await a.validate(request);
  a.commit(request);
  assert.deepEqual(clicks, [doc.getElementById('send')]);
});

test('Lexical consumes a multiline Gemini draft in one paste, and cancellation removes exactly that draft', async t => {
  const { a, doc, clicks } = setup(t, lexical);
  const editor = doc.querySelector('[data-test-id="prompt-input"]'), pastes = [];
  editor.addEventListener('paste', event => pastes.push(event.clipboardData.getData('text/plain')));
  const req = { requestId: 'rollback', text: 'First\n\n第三段\nLast' };
  a.preflight(req);
  await a.stage(req);
  assert.deepEqual(pastes, [req.text]);
  assert.equal(a.getDraft().text, req.text);
  await a.cancel(req);
  assert.equal(a.getDraft().text, '');
  assert.equal(clicks.length, 0);
});

test('Gemini pending and streaming response states guard the composer before Stop mounts', t => {
  const turn = status => `<section data-test-id="model-response" data-turn-status="${status}">Reply</section>`;
  const { a, doc } = setup(t, '<main>' + turn('streaming') + turn('pending') + lexical + '</main><aside>' + turn('streaming') + '</aside>');
  const latest = doc.querySelector('main section:nth-child(2)');
  for (const state of ['pending', 'streaming', 'settled', 'failed']) {
    latest.dataset.turnStatus = state;
    assert.equal(a.busy(), state === 'pending' || state === 'streaming');
  }
});

test('Gemini recognizes Quill’s localized Stop and skips stale controls in a hidden pane', t => {
  const { a, doc } = setup(t, quill);
  const host = doc.querySelector('gem-icon-button'), btn = doc.getElementById('send');
  host.className = 'send-button stop';
  btn.setAttribute('aria-label', 'Antwort beenden');
  assert.equal(a.busy(), true);
  host.setAttribute('aria-hidden', 'true');
  assert.equal(a.busy(), false);
});

test('Gemini picks the visible composer during a transition and refuses two active composers', t => {
  const { a, doc } = setup(t, lexical + '<div aria-hidden="true">' + lexical + '</div>');
  assert.equal(a.getDraft().text, '');
  doc.querySelector('[aria-hidden]').removeAttribute('aria-hidden');
  assert.throws(() => a.getDraft(), /multiple matching/);
});
