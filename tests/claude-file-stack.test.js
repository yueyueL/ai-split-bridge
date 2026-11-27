import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { translations } from './translations.js';

const sources = await Promise.all(['download-capture', 'reply-files', 'adapters'].map(name =>
  readFile(new URL(`../extension/${name}.js`, import.meta.url), 'utf8')));

// Sanitized structure from Claude's mixed expanded/compact output stack. The
// first Markdown card exports through its viewer; the others have hover actions.
const documents = [
  { title: 'Style kit', format: 'Document · MD', filename: 'style_kit.md', bytes: Buffer.from('# Style kit\n\nUse violet boundaries — café.\n') },
  { title: 'Events laboratory', format: 'Document · MD', filename: 'events_laboratory.md', bytes: Buffer.from('# Events laboratory\n\nMap the parcel flow.\n') },
  { title: 'Events laboratory tutor guide', format: 'Document · MD', filename: 'events_laboratory_tutor_guide.md', bytes: Buffer.from('# Tutor guide\n\nCheck the trust boundaries.\n') },
  { title: 'Dfd starter', format: 'DRAWIO', filename: 'dfd_starter.drawio', bytes: Buffer.from('<mxfile><diagram name="Starter"/></mxfile>') },
  { title: 'Topic2 lab pack', format: 'ZIP', filename: 'topic2_lab_pack.zip', bytes: Buffer.from([80, 75, 3, 4, 0, 255, 128, 1]) },
];

function setup(t) {
  const card = (file, index) => index === 0
    ? `<div data-testid="file-card-block" data-sheet-kind="markdown">
        <button data-testid="file-card-open" aria-label="View ${file.title}"><span>${file.title}</span></button>
        <span>${file.format}</span></div>`
    : `<div data-testid="file-card-block" data-file-row-card>
        <span data-cds="CardLink" role="button" tabindex="0" data-testid="file-card-open" aria-label="View ${file.title}">
          <span>${file.title}</span><span>${file.format}</span></span>
        <div class="hover-controls" style="opacity:0"><button aria-label="Download ${file.title}" data-download-index="${index}">↓</button>
          <button aria-label="More options">⋯</button></div></div>`;
  const dom = new JSDOM(`<!doctype html><main>
    <section data-turn-key="files-turn"><div data-testid="assistant-message">
      <div class="font-claude-response"><p>Here are the revised lab materials.</p>
        <p>Keep the assessment time unchanged. <a href="https://example.org/source">Source</a></p></div>
      <div data-testid="file-card-stack">${documents.map(card).join('')}<button id="download-all">Download all</button></div>
    </div><div class="reply-actions"><button aria-label="Copy"></button><button aria-label="Give positive feedback"></button></div></section>
    <fieldset><div class="ProseMirror" contenteditable="true" role="textbox" aria-label="Write your prompt to Claude">Keep my unsent draft</div>
      <button id="send" aria-label="Send message"></button></fieldset></main>`, {
    url: 'https://claude.ai/chat/file-stack', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom, { document } = window;
  window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 40 }];
  window.Blob.prototype.arrayBuffer ??= function () {
    return new Promise(resolve => {
      const reader = new window.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsArrayBuffer(this);
    });
  };
  let urlIndex = 0, sendClicks = 0, downloadAllClicks = 0, afterDownload;
  const downloaded = [], escaped = [], opened = [], captures = [];
  window.URL.createObjectURL = () => `blob:https://claude.ai/fixture-${++urlIndex}`;
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { escaped.push(this.download); };
  const originalURL = window.URL.createObjectURL, originalClick = window.HTMLAnchorElement.prototype.click;
  function download(index) {
    const file = documents[index];
    downloaded.push(file.filename);
    const link = document.createElement('a');
    link.download = file.filename;
    link.href = window.URL.createObjectURL(new window.Blob([new Uint8Array(file.bytes)], { type: 'application/octet-stream' }));
    link.click();
    window.URL.revokeObjectURL(link.href);
    afterDownload?.(index);
  }
  function openViewer(title = documents[0].title) {
    opened.push(title);
    document.querySelectorAll('[data-testid="file-card-open"]').forEach(opener => {
      opener.setAttribute('aria-pressed', String(opener.getAttribute('aria-label') === `View ${title}`));
    });
    document.querySelector('[data-testid="chat-side-pane"]')?.remove();
    document.querySelector('#export-menu')?.remove();
    const pane = document.createElement('aside');
    pane.dataset.testid = 'chat-side-pane';
    pane.innerHTML = `<div role="toolbar" aria-label="${title} · MD controls"><h2>${title} · MD</h2>
      <button aria-label="More options" aria-haspopup="menu" aria-controls="export-menu" aria-expanded="false">⋯</button>
      <button aria-label="Close">×</button></div><pre>Viewer content for ${title}</pre>`;
    document.body.append(pane);
    const url = new URL(window.location.href);
    url.searchParams.set('artifact', title.toLowerCase().replaceAll(' ', '-'));
    window.history.replaceState({}, '', url);
    pane.querySelector('[aria-label="Close"]').onclick = () => {
      document.querySelector('#export-menu')?.remove();
      pane.remove();
      document.querySelector(`[data-testid="file-card-open"][aria-label="View ${title}"]`)?.setAttribute('aria-pressed', 'false');
      const next = new URL(window.location.href);
      next.searchParams.delete('artifact');
      window.history.replaceState({}, '', next);
    };
    const more = pane.querySelector('[aria-label="More options"]');
    more.onclick = () => {
      if (document.querySelector('#export-menu')) { document.querySelector('#export-menu').remove(); more.setAttribute('aria-expanded', 'false'); return; }
      const menu = document.createElement('div');
      menu.id = 'export-menu';
      menu.setAttribute('role', 'menu');
      menu.innerHTML = '<div role="menuitem" tabindex="-1">Download as MD</div>';
      document.body.append(menu);
      more.setAttribute('aria-expanded', 'true');
      menu.firstElementChild.onclick = () => {
        if (title !== documents[0].title) throw new Error('Exported the wrong viewer');
        download(0);
        menu.remove();
        more.setAttribute('aria-expanded', 'false');
      };
    };
    return pane;
  }
  document.querySelector('[data-sheet-kind="markdown"] [data-testid="file-card-open"]').onclick = () => openViewer();
  document.querySelectorAll('[data-download-index]').forEach(button => { button.onclick = () => download(Number(button.dataset.downloadIndex)); });
  document.querySelector('#send').onclick = () => { sendClicks++; };
  document.querySelector('#download-all').onclick = () => { downloadAllClicks++; };
  document.addEventListener('asb-file-request', () => captures.push('request'));
  document.addEventListener('asb-file-result', () => captures.push('result'));
  window.eval(translations);
  sources.forEach(source => window.eval(source));
  return {
    window, document, adapter: window.AISplitAdapters, downloaded, escaped, opened, captures, openViewer,
    originalClick, originalURL, sendClicks: () => sendClicks, downloadAllClicks: () => downloadAllClicks,
    afterDownload: callback => { afterDownload = callback; },
  };
}

test('Claude mixed file stack shares all five files through native card and Markdown export controls', async t => {
  const f = setup(t);
  const reply = await f.adapter.readResponse();
  assert.equal(reply.files.length, 5, 'expanded Markdown plus all compact rows are discovered');
  assert.deepEqual(Array.from(reply.files, file => file.name), [
    'Style kit.md', 'Events laboratory.md', 'Events laboratory tutor guide.md', 'Dfd starter.drawio', 'Topic2 lab pack.zip',
  ]);
  assert.match(reply.text, /Here are the revised lab materials/);
  assert.match(reply.text, /Keep the assessment time unchanged/);
  assert.match(reply.text, /https:\/\/example.org\/source/);
  const copies = await f.adapter.readReplyFiles(reply.files);
  assert.deepEqual(Array.from(copies, file => file.name), documents.map(file => file.filename));
  copies.forEach((file, index) => assert.deepEqual(Buffer.from(file.data, 'base64'), documents[index].bytes));
  assert.deepEqual(f.downloaded, documents.map(file => file.filename));
  assert.deepEqual(f.captures, documents.flatMap(() => ['request', 'result']), 'each file completes before the next begins');
  assert.equal(f.downloadAllClicks(), 0);
  assert.equal(f.sendClicks(), 0);
  assert.deepEqual(f.escaped, []);
  assert.deepEqual(f.opened, ['Style kit']);
  assert.equal(f.document.querySelector('[data-testid="chat-side-pane"]'), null, 'close only the viewer opened for export');
  assert.equal(f.document.querySelector('#export-menu'), null);
  assert.equal(f.document.querySelector('[data-asb-file-capture]'), null);
  assert.equal(f.adapter.getDraft().text, 'Keep my unsent draft');
  assert.equal(f.window.HTMLAnchorElement.prototype.click, f.originalClick);
  assert.equal(f.window.URL.createObjectURL, f.originalURL);
});

test('sharing a Markdown artifact restores a different previously selected viewer', async t => {
  const f = setup(t);
  const previous = f.document.createElement('button');
  previous.dataset.testid = 'file-card-open';
  previous.setAttribute('aria-label', 'View Earlier note');
  previous.onclick = () => f.openViewer('Earlier note');
  f.document.body.append(previous);
  previous.click();
  const reply = await f.adapter.readResponse();
  const [copy] = await f.adapter.readReplyFiles([reply.files[0]]);
  assert.equal(copy.name, 'style_kit.md');
  assert.deepEqual(f.opened, ['Earlier note', 'Style kit', 'Earlier note']);
  assert.equal(f.document.querySelector('[data-testid="chat-side-pane"] [role="toolbar"]').getAttribute('aria-label'), 'Earlier note · MD controls');
  assert.equal(previous.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(f.escaped, []);
});

test('sharing the Markdown file already open leaves that viewer open', async t => {
  const f = setup(t);
  const pane = f.openViewer();
  const reply = await f.adapter.readResponse();
  await f.adapter.readReplyFiles([reply.files[0]]);
  assert.equal(f.document.querySelector('[data-testid="chat-side-pane"]'), pane);
  assert.deepEqual(f.opened, ['Style kit']);
  assert.equal(f.document.querySelector('#export-menu'), null);
});

test('an open same-title revision is not reused for a different selected source card', async t => {
  const f = setup(t);
  const source = f.document.querySelector('[data-sheet-kind="markdown"] [data-testid="file-card-open"]');
  const previous = f.document.createElement('button');
  previous.dataset.testid = 'file-card-open';
  previous.setAttribute('aria-label', 'View Style kit');
  f.document.body.append(previous);
  let sourceClicks = 0, previousClicks = 0, oldExports = 0;
  const openSource = source.onclick;
  source.onclick = () => {
    sourceClicks++;
    openSource();
    previous.setAttribute('aria-pressed', 'false');
    source.setAttribute('aria-pressed', 'true');
  };
  previous.onclick = () => {
    previousClicks++;
    const pane = f.openViewer('Style kit');
    source.setAttribute('aria-pressed', 'false');
    previous.setAttribute('aria-pressed', 'true');
    pane.querySelector('pre').textContent = 'An older revision with the same title';
    const more = pane.querySelector('[aria-label="More options"]');
    more.onclick = () => {
      const menu = f.document.createElement('div');
      menu.id = 'export-menu';
      menu.setAttribute('role', 'menu');
      menu.innerHTML = '<div role="menuitem">Download as MD</div>';
      f.document.body.append(menu);
      more.setAttribute('aria-expanded', 'true');
      menu.firstElementChild.onclick = () => {
        oldExports++;
        const link = f.document.createElement('a');
        link.download = 'style_kit.md';
        link.href = f.window.URL.createObjectURL(new f.window.Blob(['# Old revision']));
        link.click();
        menu.remove();
        more.setAttribute('aria-expanded', 'false');
      };
    };
  };
  previous.click();
  const reply = await f.adapter.readResponse();
  const [copy] = await f.adapter.readReplyFiles([reply.files[0]]);
  assert.equal(sourceClicks, 1, 'the source card must be opened despite the identical viewer title');
  assert.equal(oldExports, 0);
  assert.deepEqual(Buffer.from(copy.data, 'base64'), documents[0].bytes);
  assert.equal(previousClicks, 2, 'restore the previously open revision after capturing the selected one');
  assert.equal(previous.getAttribute('aria-pressed'), 'true');
  assert.equal(source.getAttribute('aria-pressed'), 'false');
  assert.equal(f.document.querySelector('[data-testid="chat-side-pane"] pre').textContent, 'An older revision with the same title');
  assert.deepEqual(f.escaped, []);
});

test('a user selecting a different viewer during export is not overwritten by cleanup', async t => {
  const f = setup(t);
  f.afterDownload(() => f.openViewer('User selection'));
  const reply = await f.adapter.readResponse();
  await f.adapter.readReplyFiles([reply.files[0]]);
  assert.deepEqual(f.opened, ['Style kit', 'User selection']);
  assert.equal(f.document.querySelector('[data-testid="chat-side-pane"] [role="toolbar"]').getAttribute('aria-label'), 'User selection · MD controls');
  assert.deepEqual(f.escaped, []);
});

test('navigating to another conversation while opening Markdown stops before downloading', async t => {
  const f = setup(t);
  const reply = await f.adapter.readResponse();
  const opener = f.document.querySelector('[data-sheet-kind="markdown"] [data-testid="file-card-open"]');
  opener.onclick = () => {
    f.openViewer();
    f.window.history.pushState({}, '', '/chat/another');
  };
  await assert.rejects(f.adapter.readReplyFiles([reply.files[0]]), /reply changed/);
  assert.deepEqual(f.downloaded, []);
  assert.deepEqual(f.captures, []);
  assert.ok(f.document.querySelector('[data-testid="chat-side-pane"]'), 'cleanup does not alter the newly navigated page');
});

test('an unrelated open menu is never used as the Markdown export menu', async t => {
  const f = setup(t);
  const pane = f.openViewer();
  const unrelated = f.document.createElement('div');
  unrelated.id = 'unrelated-menu';
  unrelated.setAttribute('role', 'menu');
  unrelated.innerHTML = '<div role="menuitem">Download as MD</div>';
  let clicked = 0;
  unrelated.firstElementChild.onclick = () => { clicked++; };
  f.document.body.append(unrelated);
  const reply = await f.adapter.readResponse();
  await assert.rejects(f.adapter.readReplyFiles([reply.files[0]]), /Close the open menu/);
  assert.equal(clicked, 0);
  assert.deepEqual(f.downloaded, []);
  assert.deepEqual(f.captures, []);
  assert.equal(f.document.querySelector('[data-testid="chat-side-pane"]'), pane);
  assert.ok(unrelated.isConnected, 'the extension must not dismiss an unrelated menu');
});

test('a different artifact opening instead of the selected Markdown file cannot be exported', async t => {
  const f = setup(t);
  const reply = await f.adapter.readResponse();
  const opener = f.document.querySelector('[data-sheet-kind="markdown"] [data-testid="file-card-open"]');
  opener.onclick = () => f.openViewer('Different artifact');
  // Advance the bounded viewer wait without spending eight real seconds on a
  // deliberately unresolvable UI state; the DOM still changes through clicks.
  let now = Date.now();
  f.window.Date.now = () => (now += 4001);
  await assert.rejects(f.adapter.readReplyFiles([reply.files[0]]), /selected Markdown file did not open/);
  assert.deepEqual(f.downloaded, []);
  assert.deepEqual(f.captures, []);
  assert.equal(f.document.querySelector('[data-testid="chat-side-pane"] [role="toolbar"]').getAttribute('aria-label'), 'Different artifact · MD controls');
  assert.equal(f.document.querySelector('#export-menu'), null);
});

test('a newly opened unrelated menu cannot replace the viewer’s aria-controls menu', async t => {
  const f = setup(t);
  const pane = f.openViewer();
  let unrelatedClicks = 0;
  pane.querySelector('[aria-label="More options"]').onclick = () => {
    const menu = f.document.createElement('div');
    menu.id = 'another-new-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = '<div role="menuitem">Download as MD</div>';
    menu.firstElementChild.onclick = () => {
      unrelatedClicks++;
      const link = f.document.createElement('a');
      link.download = 'style_kit.md';
      link.href = f.window.URL.createObjectURL(new f.window.Blob(['Unrelated menu output']));
      link.click();
    };
    f.document.body.append(menu);
  };
  const reply = await f.adapter.readResponse();
  let now = Date.now();
  f.window.Date.now = () => (now += 4001);
  await assert.rejects(f.adapter.readReplyFiles([reply.files[0]]), /did not offer Download as MD/);
  assert.equal(unrelatedClicks, 0);
  assert.deepEqual(f.captures, []);
  assert.ok(f.document.querySelector('#another-new-menu'), 'unrelated UI is preserved');
});
