import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { translations } from './translations.js';

const source = await readFile(new URL('../extension/download-capture.js', import.meta.url), 'utf8');

function fixture(t, html) {
  const dom = new JSDOM(`<!doctype html><main>${html}</main>`, {
    url: 'https://claude.ai/chat/example', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const { document } = window;
  window.Blob.prototype.arrayBuffer ??= function () {
    return new Promise(resolve => {
      const reader = new window.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsArrayBuffer(this);
    });
  };
  let urls = 0;
  const escaped = [];
  window.URL.createObjectURL = () => `blob:https://claude.ai/generated-${++urls}`;
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { escaped.push(this.download); };
  const nativeClick = window.HTMLAnchorElement.prototype.click;
  const nativeURL = window.URL.createObjectURL;
  window.eval(translations);
  window.eval(source);
  function download(name, text, duplicate = false) {
    const anchor = document.createElement('a');
    anchor.download = name;
    anchor.href = window.URL.createObjectURL(new window.Blob([text], { type: 'application/octet-stream' }));
    anchor.click();
    if (duplicate) anchor.click();
    window.URL.revokeObjectURL(anchor.href);
  }
  function request(control, name, matchName) {
    const id = `capture-${window.crypto.randomUUID()}`;
    control.setAttribute('data-asb-file-capture', id);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Download capture did not return a result.')), 1000);
      const receive = event => {
        const result = JSON.parse(event.detail);
        if (result.id !== id) return;
        clearTimeout(timeout);
        document.removeEventListener('asb-file-result', receive);
        control.removeAttribute('data-asb-file-capture');
        resolve(result);
      };
      document.addEventListener('asb-file-result', receive);
      document.dispatchEvent(new window.CustomEvent('asb-file-request', { detail: JSON.stringify({ id, name, matchName }) }));
    });
  }
  return { window, document, download, request, escaped, nativeClick, nativeURL };
}

test('Claude Download as MD menuitem captures its native Markdown export and restores hooks', async t => {
  const f = fixture(t, '<div role="menu"><div role="menuitem" tabindex="-1">Download as MD</div></div>');
  const menuitem = f.document.querySelector('[role="menuitem"]');
  let clicks = 0;
  menuitem.onclick = () => {
    clicks++;
    f.download('info1004_figure_style_kit.md', '# Figure style kit\n\nRésumé — café\n', true);
  };
  const result = await f.request(menuitem, 'Info1004 figure style kit.md', 'Info1004 figure style kit');
  assert.equal(result.error, undefined);
  assert.equal(clicks, 1);
  assert.equal(result.file.name, 'info1004_figure_style_kit.md');
  assert.equal(result.file.type, 'text/markdown');
  assert.equal(Buffer.from(result.file.data, 'base64').toString('utf8'), '# Figure style kit\n\nRésumé — café\n');
  assert.deepEqual(f.escaped, []);
  assert.equal(f.window.HTMLAnchorElement.prototype.click, f.nativeClick);
  assert.equal(f.window.URL.createObjectURL, f.nativeURL);
});

test('explicit custom-role download buttons preserve isolation from other named blob downloads', async t => {
  const f = fixture(t, '<span role="button" tabindex="0" aria-label="Download Events laboratory">Download</span>');
  const control = f.document.querySelector('[role="button"]');
  control.onclick = () => {
    // The blob was created during the capture window, but its different filename
    // still proves that it is not the requested file.
    f.download('unrelated.md', '# Wrong file');
    f.download('events_laboratory.md', '# Events laboratory');
  };
  const result = await f.request(control, 'Events laboratory.md', 'Events laboratory');
  assert.equal(result.error, undefined);
  assert.equal(result.file.name, 'events_laboratory.md');
  assert.equal(Buffer.from(result.file.data, 'base64').toString(), '# Events laboratory');
  assert.deepEqual(f.escaped, ['unrelated.md']);
  assert.equal(f.window.HTMLAnchorElement.prototype.click, f.nativeClick);
  assert.equal(f.window.URL.createObjectURL, f.nativeURL);
});

test('a marked noninteractive card is never clicked or allowed to install capture hooks', t => {
  const f = fixture(t, '<div data-asb-file-capture="container-request"><button>Open preview</button></div>');
  const card = f.document.querySelector('[data-asb-file-capture]');
  let clicks = 0;
  card.onclick = () => { clicks++; };
  f.document.dispatchEvent(new f.window.CustomEvent('asb-file-request', {
    detail: JSON.stringify({ id: 'container-request', name: 'notes.md' }),
  }));
  assert.equal(clicks, 0);
  assert.equal(f.window.HTMLAnchorElement.prototype.click, f.nativeClick);
  assert.equal(f.window.URL.createObjectURL, f.nativeURL);
});
