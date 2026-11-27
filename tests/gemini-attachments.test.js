import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { translations } from './translations.js';

const source = await readFile(new URL('../extension/adapters.js', import.meta.url), 'utf8');
const pdfs = ['first.pdf', 'second.pdf'].map((name, index) => ({
  name, type: 'application/pdf', data: btoa('%PDF-test-' + index), lastModified: 1,
}));

function setup(t, angular = false) {
  const editorMarkup = angular
    ? '<rich-textarea><div contenteditable="true" class="ql-editor"></div></rich-textarea>'
    : '<div contenteditable="true" data-test-id="prompt-input" data-lexical-editor="true" role="textbox"></div>';
  const composerTag = angular ? 'input-area-v2' : 'form';
  const dom = new JSDOM(`<main><aside><input type="file" multiple></aside><user-query id="history"></user-query>
    <${composerTag}><ul aria-label="附加的文件"><li><button>添加虚拟形象</button></li></ul>
    <div class="text-input-field">${editorMarkup}<button type="button" data-test-id="send-button" aria-label="发送"></button></div>
    </${composerTag}></main>`, { url: 'https://gemini.google.com/u/2/app/conversation', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const win = dom.window, doc = win.document;
  const editor = doc.querySelector('[contenteditable]'), list = doc.querySelector('ul'), picker = doc.querySelector('input');
  win.HTMLElement.prototype.getClientRects = () => [{ width: 12, height: 12 }];
  win.document.execCommand = (_cmd, _show, value) => { editor.textContent = value; return true; };
  win.DataTransfer = class { files = []; items = { add: file => this.files.push(file) }; };
  win.ClipboardEvent = class extends win.Event {
    constructor(type, options) { super(type, options); this.clipboardData = options.clipboardData; }
  };
  win.Blob.prototype.arrayBuffer = function() {
    return new Promise(resolve => {
      const reader = new win.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsArrayBuffer(this);
    });
  };
  const received = [];
  let pickerChanges = 0, sends = 0;
  doc.querySelector('[data-test-id="send-button"]').onclick = () => { sends++; };
  Object.defineProperty(picker, 'files', { writable: true, value: [] });
  picker.onchange = () => { pickerChanges++; };
  function tile(name) {
    const row = doc.createElement('li');
    const card = doc.createElement('div');
    card.tabIndex = 0;
    const label = doc.createElement('span');
    label.textContent = name;
    const action = doc.createElement('span');
    action.style.opacity = '0';
    const remove = doc.createElement('button');
    remove.setAttribute('aria-label', '移除“' + name + '”');
    remove.onclick = () => row.remove();
    action.append(remove);
    card.append(label, action);
    row.append(card);
    return row;
  }
  editor.addEventListener('paste', event => {
    for (const file of event.clipboardData.files) {
      received.push(file.name);
      list.append(tile(file.name));
    }
    event.preventDefault();
  });
  win.eval(translations);
  win.eval(source);
  return { adapter: win.AISplitAdapters, doc, editor, list, received, tile, sends: () => sends, pickerChanges: () => pickerChanges,
    paste(files) {
      const transfer = new win.DataTransfer();
      for (const { name, type, data } of files) transfer.items.add(new win.File([atob(data)], name, { type }));
      editor.dispatchEvent(new win.ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    } };
}

test('Gemini counts the active attachment tray, keeps hidden remove controls and excludes files in previous turns', async t => {
  const f = setup(t, true);
  f.doc.querySelector('#history').innerHTML = '<uploader-file-preview>history.pdf</uploader-file-preview>';
  f.paste(pdfs);
  const initial = await f.adapter.readPrompt();
  assert.deepEqual(Array.from(initial.files, file => [file.name, file.data]), pdfs.map(file => [file.name, file.data]));
  f.list.querySelector('button[aria-label]').click();
  assert.deepEqual(Array.from((await f.adapter.readPrompt()).files, file => file.name), ['second.pdf']);
  f.list.querySelector('button[aria-label]').click();
  assert.deepEqual(Array.from((await f.adapter.readPrompt()).notCopied), []);
});

test('Gemini receives two PDFs once through the active React editor, waits for processing and keeps the byte copies with a draft', async t => {
  const f = setup(t);
  const request = { requestId: 'two-files', text: 'Compare the files.', attachments: 2 };
  f.adapter.preflight(request);
  await f.adapter.stage({ ...request, files: pdfs });
  assert.deepEqual(f.received, pdfs.map(file => file.name));
  assert.equal(f.pickerChanges(), 0, 'an unrelated file picker must not receive chat attachments');
  const progress = f.doc.createElement('span');
  progress.setAttribute('role', 'progressbar');
  f.list.lastElementChild.append(progress);
  assert.throws(() => f.adapter.commit(request), /still processing/);
  progress.remove();
  await f.adapter.validate(request);
  f.adapter.keep(request);
  const prompt = await f.adapter.readPrompt();
  assert.deepEqual(Array.from(prompt.files, file => [file.name, file.data]), pdfs.map(file => [file.name, file.data]));
  assert.equal(f.sends(), 0);
});

test('Gemini rejects a file-level alert and cleans up Chinese attachment cards on rollback', async t => {
  const f = setup(t);
  const request = { requestId: 'rejected-file', text: '', attachments: 1 };
  f.adapter.preflight(request);
  await f.adapter.stage({ ...request, files: pdfs.slice(0, 1) });
  const error = f.doc.createElement('span');
  error.setAttribute('role', 'alert');
  error.textContent = '上传失败';
  f.list.lastElementChild.append(error);
  await assert.rejects(f.adapter.validate(request), /rejected an attachment/);
  assert.throws(() => f.adapter.commit(request), /rejected an attachment/);
  assert.equal((await f.adapter.cancel(request)).leftAttachments, 0);
  assert.equal(f.list.querySelectorAll('button[aria-label]').length, 0);
  assert.equal(f.list.children.length, 1, 'the other tool in the same tray remains available');
  assert.equal(f.sends(), 0);
});

test('localized Gemini file cards block an occupied destination and pick only their matching source file', async t => {
  const f = setup(t);
  f.list.setAttribute('aria-label', 'Angehängte Dateien');
  f.paste(pdfs);
  const actions = [...f.list.querySelectorAll('button[aria-label]')];
  actions.forEach((button, index) => button.setAttribute('aria-label', pdfs[index].name + ' entfernen'));
  assert.throws(() => f.adapter.preflight({ requestId: 'occupied-de', text: 'A shared message' }), /already has attachments or selected items/);
  actions[0].click();
  assert.deepEqual(Array.from((await f.adapter.readPrompt()).files, file => file.name), ['second.pdf']);
  // A locale whose action wording is unknown can still be verified from
  // the semantic card and exact rendered filename. Opaque cards stay put.
  f.list.setAttribute('aria-label', 'Bijgevoegde bestanden');
  actions[1].setAttribute('aria-label', 'second.pdf verwijderen');
  assert.deepEqual(Array.from((await f.adapter.readPrompt()).files, file => file.name), ['second.pdf']);
  actions[1].closest('li').querySelector('span').textContent = 'se…df';
  const unresolved = await f.adapter.readPrompt();
  assert.equal(unresolved.files.length, 0);
  assert.match(unresolved.notCopied[0], /without a verified local file/);
  assert.throws(() => f.adapter.preflight({ requestId: 'occupied-nl', text: 'Do not touch it' }), /already has attachments or selected items/);
  assert.equal(f.sends(), 0);
});

test('a named style selected in a Gemini attachment tray is preserved and reported if its source cannot be copied', async t => {
  const f = setup(t);
  f.list.setAttribute('aria-label', 'Fichiers joints');
  const namedTemplate = f.tile('Aquarelle');
  namedTemplate.querySelector('button').setAttribute('aria-label', 'Supprimer Aquarelle');
  f.list.append(namedTemplate);
  const result = await f.adapter.readPrompt();
  assert.equal(result.files.length, 0);
  assert.match(result.notCopied[0], /without a verified local file/);
  assert.throws(() => f.adapter.preflight({ requestId: 'keep-template', text: 'Share this.' }), /selected items/);
  assert.ok(namedTemplate.isConnected);
});

test('Gemini generated files use their own download controls, including a button-only file, and exclude ordinary links', async t => {
  const dom = new JSDOM('<article></article>', { url: 'https://gemini.google.com/app/demo', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom, doc = window.document, reply = doc.querySelector('article');
  reply.innerHTML = [
    '<section data-test-id="generated-file-chip"><div data-test-id="file-name">outline.md</div><a data-test-id="download-button" download href="https://example.com/content/opaque">下载</a></section>',
    '<section data-test-id="generated-file-chip"><div data-test-id="file-name">rubric.pdf</div><button data-test-id="download-button">下载</button><button data-test-id="open-button">打开</button></section>',
    '<a href="https://example.com/citation.pdf">Source</a>',
  ].join('');
  window.eval(translations);
  window.eval(await readFile(new URL('../extension/reply-files.js', import.meta.url), 'utf8'));
  window.eval(await readFile(new URL('../extension/download-capture.js', import.meta.url), 'utf8'));
  window.fetch = async () => new Response('synthetic test download', { headers: { 'content-type': 'application/octet-stream' } });
  window.Blob.prototype.arrayBuffer = function () {
    return new Promise(resolve => { const r = new window.FileReader(); r.onload = () => resolve(r.result); r.readAsArrayBuffer(this); });
  };
  window.URL.createObjectURL = () => 'blob:https://gemini.google.com/local-pdf';
  const preview = reply.querySelector('[data-test-id="open-button"]');
  let previewClicks = 0;
  preview.onclick = () => { previewClicks++; };
  reply.querySelector('button[data-test-id="download-button"]').onclick = () => {
    const a = doc.createElement('a');
    a.href = window.URL.createObjectURL(new window.Blob(['synthetic PDF']));
    a.download = 'rubric.pdf';
    a.click();
  };
  const api = window.AISplitReplyFiles;
  const files = api.list(reply);
  assert.deepEqual(Array.from(files, entry => entry.name), ['outline.md', 'rubric.pdf']);
  const copies = await api.read(files);
  assert.deepEqual(Array.from(copies, file => [file.name, atob(file.data)]),
    [['outline.md', 'synthetic test download'], ['rubric.pdf', 'synthetic PDF']]);
  assert.equal(previewClicks, 0);
});
