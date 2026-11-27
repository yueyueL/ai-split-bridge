import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { translations } from './translations.js';

const replySource = await readFile(new URL('../extension/reply-files.js', import.meta.url), 'utf8');
const captureSource = await readFile(new URL('../extension/download-capture.js', import.meta.url), 'utf8');

function setup(body, { capture = false, host = 'claude.ai' } = {}) {
  const dom = new JSDOM(`<!doctype html><main data-message-id="reply-1">${body}</main>`, {
    url: `https://${host}/chat/test`, runScripts: 'outside-only', pretendToBeVisual: true,
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

const promptShapes = {
  'chatgpt.com': ['<div data-testid="attachment-preview"><button aria-label="Open preview of project.pdf"></button>', '</div>'],
  'claude.ai': ['<div data-testid="file-thumbnail"><span data-testid="file-name">project.pdf</span>', '</div>'],
  'gemini.google.com': ['<user-query-file-preview><gem-attachment><span>project.pdf</span></gem-attachment>', '</user-query-file-preview>'],
  'grok.com': ['<div data-testid="file-pill" data-filename="project.pdf">', '</div>'],
};

for (const [host, [startCard, endCard]] of Object.entries(promptShapes)) {
  test(host + ' shares the selected historical upload bytes, leaves links as text, and strips file cards from the quote', async t => {
    const download = '<a href="/native-download" download="project.pdf">Download</a>';
    const f = setup(`<article id="other">${startCard}${download}${endCard}</article>
      <article id="selected">${startCard}${download}${endCard}<p>Summarize this. <a href="https://example.com/paper.pdf">See paper</a></p></article>`,
      { capture: true, host });
    t.after(() => f.dom.window.close());
    const scope = f.scope.querySelector('#selected');
    const readURLs = [];
    f.window.fetch = async url => {
      readURLs.push(url);
      return new Response(Uint8Array.of(0, 255, 37), { headers: { 'Content-Type': 'application/pdf' } });
    };
    const selected = f.api.listPrompt(scope);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].name, 'project.pdf');
    assert.equal(selected[0].nameKnown, true);
    assert.equal(selected[0].kind, 'download');
    assert.ok(scope.contains(selected[0].element));
    const [file] = await f.api.read(selected);
    assert.deepEqual([file.name, file.type, file.data], ['project.pdf', 'application/pdf', 'AP8l']);
    assert.deepEqual(readURLs, [`https://${host}/native-download`]);
    assert.equal(f.nativeClicks(), 0);
    const clone = scope.cloneNode(true);
    f.api.stripPromptFiles(clone);
    assert.equal(clone.textContent.trim(), 'Summarize this. See paper');
    assert.equal(clone.querySelector('a').getAttribute('href'), 'https://example.com/paper.pdf');
    assert.ok(scope.contains(selected[0].element));
  });
}

test('opaque cards are listed and fail before capture, including truncated Gemini tiles and preview-only images', async t => {
  const f = setup(`<div tabindex="0"><span>PDF</span><span>trunca…ed.pdf</span></div>
    <img src="/thumbnail?size=96" alt="Uploaded image">
    <div data-cds-attachment data-filename="report.pdf"><a download href="https://example.com/tracking.pdf">Download</a></div>
    <p><button aria-label="Open preview of citation.pdf">citation.pdf</button></p>
    <form><div data-testid="attachment-preview">Draft.pdf</div></form>
    <div data-testid="assistant-message"><div data-testid="file-thumbnail">answer.pdf</div></div>
    <div hidden data-testid="file-thumbnail">invisible.pdf</div>`, { host: 'gemini.google.com' });
  t.after(() => f.dom.window.close());
  let requests = 0;
  f.document.addEventListener('asb-file-request', () => { requests++; });
  const selected = f.api.listPrompt(f.scope);
  assert.equal(selected.length, 3);
  assert.ok(selected.every(file => file.kind === 'unavailable'));
  assert.deepEqual(Array.from(selected).map(({ name, nameKnown }) => [name, nameKnown]).sort(),
    [['trunca…ed.pdf', false], ['Attached file', false], ['report.pdf', true]].sort());
  await assert.rejects(f.api.read(selected), /does not expose the original attachment/);
  assert.equal(requests, 0);
});

test('preview label and download click target can be siblings, duplicate filenames keep distinct bytes', async t => {
  const card = '<div><button aria-label="Open preview of résumé.md">Open</button><button title="Download file">↓</button></div>';
  const f = setup(card + card, { capture: true, host: 'chatgpt.com' });
  t.after(() => f.dom.window.close());
  const selected = f.api.listPrompt(f.scope);
  assert.equal(selected.length, 2);
  assert.notEqual(selected[0].key, selected[1].key);
  selected.forEach((file, i) => {
    file.element.onclick = () => {
      const link = f.document.createElement('a');
      link.download = 'résumé.md';
      link.href = f.window.URL.createObjectURL(new f.window.Blob([`file ${i + 1}`]));
      link.click();
    };
  });
  f.scope.prepend(f.scope.lastElementChild);
  assert.deepEqual(Array.from(await f.api.read(selected), file => Buffer.from(file.data, 'base64').toString()), ['file 1', 'file 2']);
  selected[0].card.replaceWith(selected[0].card.cloneNode(true));
  await assert.rejects(f.api.read([selected[0]]), /prompt attachment changed/);
});

test('the same card cannot silently switch its download URL or be moved to a different chat', async t => {
  const f = setup('<div data-testid="file-pill"><a href="/old" download="data.csv">Download</a></div>');
  t.after(() => f.dom.window.close());
  let attempts = 0;
  f.document.addEventListener('asb-file-request', () => { attempts++; });
  const selected = f.api.listPrompt(f.scope);
  selected[0].element.href = '/replacement';
  await assert.rejects(f.api.read(selected), /prompt attachment changed/);
  selected[0].element.href = '/old';
  f.window.history.pushState({}, '', '/chat/another');
  await assert.rejects(f.api.read(selected), /prompt attachment changed/);
  assert.equal(attempts, 0);
});

test('local and historical file downloads share the same count and byte limits', async t => {
  const f = setup('<div data-testid="file-pill"><a href="/download" download="target.pdf">Download</a></div>');
  t.after(() => f.dom.window.close());
  const local = { kind: 'local-prompt', promptAttachment: true, name: 'big.md' };
  const [remote] = f.api.listPrompt(f.scope);
  const payload = 'A'.repeat(Math.ceil(17 * 1024 * 1024 / 3) * 4);
  let downloads = 0, reads = 0;
  f.document.addEventListener('asb-file-request', e => {
    downloads++;
    const { id } = JSON.parse(e.detail);
    f.document.dispatchEvent(new f.window.CustomEvent('asb-file-result', { detail: JSON.stringify({ id, file: { name: 'target.pdf', data: payload } }) }));
  });
  const readLocal = async () => { reads++; return { name: local.name, data: payload }; };
  await assert.rejects(f.api.read(Array(11).fill(local), readLocal), /up to 10 files/);
  assert.equal(reads, 0);
  await assert.rejects(f.api.read([local], () => ({ name: local.name, data: 'A'.repeat(28 * 1024 * 1024) })), /exceeds 20 MB/);
  assert.equal(downloads, 0);
  await assert.rejects(f.api.read([local, remote], readLocal), /32 MB total limit/);
  assert.equal(downloads, 1);
  assert.equal(reads, 1);
});

test('a recycled turn ID invalidates both native historical downloads and chosen originals', async t => {
  const f = setup('<article data-turn-key="first"><section><div data-testid="file-pill"><a download="diagram.png" href="/files/original">Download</a></div></section></article>');
  t.after(() => f.dom.window.close());
  const scope = f.scope.querySelector('section');
  const [file] = f.api.listPrompt(scope);
  const chosen = { ...file, kind: 'local-prompt' };
  assert.equal(f.api.isCurrentPromptFile(chosen), true);
  scope.parentElement.dataset.turnKey = 'second';
  assert.equal(f.api.isCurrentPromptFile(file), false);
  assert.equal(f.api.isCurrentPromptFile(chosen), false);
  await assert.rejects(f.api.read([file]), /prompt attachment changed/);
});

test('standalone original download preserves a provider file while a prose link with the same name stays text', async t => {
  const f = setup('<a download="original.png" href="/backend-api/files/123/content">original.png</a><p><a download="original.png" href="/backend-api/files/321/content">Other diagram</a></p>', { host: 'chatgpt.com' });
  t.after(() => f.dom.window.close());
  assert.equal(f.api.listPrompt(f.scope).length, 1);
  const clone = f.scope.cloneNode(true);
  f.api.stripPromptFiles(clone);
  assert.equal(clone.textContent.trim(), 'Other diagram');
});
