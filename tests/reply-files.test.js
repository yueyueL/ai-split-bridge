import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { translations } from './translations.js';

const replySource = await readFile(new URL('../extension/reply-files.js', import.meta.url), 'utf8');
const captureSource = await readFile(new URL('../extension/download-capture.js', import.meta.url), 'utf8');

function setup(body, { capture = false } = {}) {
  const dom = new JSDOM(`<!doctype html><main data-message-id="reply-1">${body}</main>`, {
    url: 'https://claude.ai/chat/test', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  const document = window.document;
  const scope = document.querySelector('main');
  const read = blob => new Promise(resolve => {
    const reader = new window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsArrayBuffer(blob);
  });
  window.Blob.prototype.arrayBuffer ??= function () { return read(this); };
  let urls = 0, nativeClicks = 0;
  window.URL.createObjectURL = () => `blob:https://claude.ai/test-${++urls}`;
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = () => { nativeClicks++; };
  const originalClick = window.HTMLAnchorElement.prototype.click;
  const originalURL = window.URL.createObjectURL;
  window.eval(translations);
  if (capture) window.eval(captureSource);
  window.eval(replySource);
  return { dom, window, document, scope, api: window.AISplitReplyFiles, originalClick, originalURL, nativeClicks: () => nativeClicks };
}

const card = (title, format = 'MD', extra = '') => `<div data-testid="file-card-block" ${extra}>
  <button data-testid="file-card-open" aria-label="View ${title}"></button>
  <span>${format}</span><button title="Download ${title}" class="download">↓</button>
</div>`;

test('all Markdown file cards are listed, including distinct cards with the same title', t => {
  const f = setup(card('notes') + card('notes') + card('rubric.md'));
  t.after(() => f.dom.window.close());
  const files = f.api.list(f.scope);
  assert.deepEqual(Array.from(files, f => f.name), ['notes.md', 'notes.md', 'rubric.md']);
  assert.equal(new Set(files.map(f => f.key)).size, 3);
  assert.ok(files.every(f => f.kind === 'download'));
});

test('hidden file cards and ordinary Markdown citations are not included', t => {
  const f = setup(`<div style="display:none">${card('hidden')}</div>${card('visible')}<a href="https://example.org/readme.md">Readme citation</a>`);
  t.after(() => f.dom.window.close());
  assert.deepEqual(Array.from(f.api.list(f.scope), f => f.name), ['visible.md']);
});

test('a card with a native download link is not listed twice', t => {
  const f = setup('<div data-testid="file-card-block"><button data-testid="file-card-open" aria-label="View notes"></button><span>MD</span><a download="notes.md" href="blob:https://claude.ai/notes">Download</a></div>');
  t.after(() => f.dom.window.close());
  assert.equal(f.api.list(f.scope).length, 1);
});

test('several Markdown downloads are captured separately, keep UTF-8 bytes, and restore browser hooks', async t => {
  const f = setup(card('notes') + card('rubric'), { capture: true });
  t.after(() => f.dom.window.close());
  const bodies = ['# Notes\n\nRésumé — café\n', '# Rubric\n\n| A | B |\n|---|---|\n|1|2|\n'];
  f.scope.querySelectorAll('.download').forEach((button, i) => button.onclick = () => {
    const url = f.window.URL.createObjectURL(new f.window.Blob([bodies[i]], { type: 'application/octet-stream' }));
    const link = f.document.createElement('a');
    link.href = url; link.download = ['notes.md', 'rubric.md'][i];
    link.click(); link.click();
    f.window.URL.revokeObjectURL(url);
  });
  const files = await f.api.read(f.api.list(f.scope));
  assert.deepEqual(Array.from(files, f => [f.name, f.type, Buffer.from(f.data, 'base64').toString('utf8')]),
    [['notes.md', 'text/markdown', bodies[0]], ['rubric.md', 'text/markdown', bodies[1]]]);
  assert.equal(f.nativeClicks(), 0, 'file downloads are captured, not also saved by the browser');
  assert.equal(f.window.HTMLAnchorElement.prototype.click, f.originalClick);
  assert.equal(f.window.URL.createObjectURL, f.originalURL);
  assert.equal(f.document.querySelectorAll('[data-asb-file-capture]').length, 0);
});

test('equal-title files still refer to the selected controls after their cards are reordered', async t => {
  const f = setup(card('notes') + card('notes'), { capture: true });
  t.after(() => f.dom.window.close());
  const originals = [...f.scope.querySelectorAll('.download')];
  originals.forEach((button, i) => button.onclick = () => {
    const link = f.document.createElement('a');
    link.href = f.window.URL.createObjectURL(new f.window.Blob([`revision ${i + 1}`]));
    link.download = 'notes.md';link.click();
  });
  const selected = f.api.list(f.scope);
  f.scope.prepend(f.scope.lastElementChild);
  const copied = await f.api.read(selected);
  assert.deepEqual(Array.from(copied, f => Buffer.from(f.data, 'base64').toString()), ['revision 1', 'revision 2']);
});

test('a replaced ambiguous equal-title card fails instead of switching to another file', async t => {
  const f = setup(card('notes') + card('notes'));
  t.after(() => f.dom.window.close());
  const selected = f.api.list(f.scope);
  f.scope.innerHTML = card('notes') + card('notes');
  await assert.rejects(f.api.read(selected), /file is no longer in this reply/);
});

test('a changed conversation is rejected while reading a generated file', async t => {
  const f = setup(card('notes'));
  t.after(() => f.dom.window.close());
  f.document.addEventListener('asb-file-request', e => {
    const { id } = JSON.parse(e.detail);
    f.window.history.pushState({}, '', '/chat/another');
    f.document.dispatchEvent(new f.window.CustomEvent('asb-file-result', {
      detail: JSON.stringify({ id, file: { name: 'notes.md', data: btoa('# Notes') } }),
    }));
  });
  await assert.rejects(f.api.read(f.api.list(f.scope)), /reply changed while its file was being read/);
});

test('unrelated downloads pass through while a marked Markdown download is captured', async t => {
  const f = setup(card('notes'), { capture: true });
  t.after(() => f.dom.window.close());
  f.scope.querySelector('.download').onclick = () => {
    const other = f.document.createElement('a');other.href = 'https://example.org/report.pdf';other.download = 'report.pdf';other.click();
    const link = f.document.createElement('a');link.download = 'notes.md';
    link.href = f.window.URL.createObjectURL(new f.window.Blob(['# Chosen']));link.click();
  };
  const [file] = await f.api.read(f.api.list(f.scope));
  assert.equal(Buffer.from(file.data, 'base64').toString(), '# Chosen');
  assert.equal(f.nativeClicks(), 1);
});

// ---------- Interface language ----------
test('a file that cannot be shared is explained in Chinese when it is chosen', async t => {
  const f = setup(card('notes') + card('notes'));
  t.after(() => f.dom.window.close());
  f.window.AISplitI18n.use('zh-CN');
  const selected = f.api.list(f.scope);
  f.scope.innerHTML = card('notes') + card('notes');
  await assert.rejects(f.api.read(selected), { message: '没有发送任何内容。notes.md：这个文件已不在这条回复中。请重新打开“分享”。请手动下载并附加这个文件，或取消勾选生成的文件，只分享文字。' });
});

test('a download failure reported by the page is translated before it is shown', async t => {
  const f = setup(card('notes'));
  t.after(() => f.dom.window.close());
  f.window.AISplitI18n.use('zh-CN');
  f.document.addEventListener('asb-file-request', e => {
    const { id } = JSON.parse(e.detail);
    f.document.dispatchEvent(new f.window.CustomEvent('asb-file-result', { detail: JSON.stringify({ id, error: 'The file exceeds 20 MB.' }) }));
  });
  await assert.rejects(f.api.read(f.api.list(f.scope)), { message: '没有发送任何内容。notes.md：文件超过 20 MB。请手动下载并附加这个文件，或取消勾选生成的文件，只分享文字。' });
});
