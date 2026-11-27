import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as instructions from '../extension/instructions.js';
import { translations } from './translations.js';

const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
const script = (await readFile(new URL('../extension/popup-instructions.js', import.meta.url), 'utf8'))
  .replace(/^import (.+) from '\.\/instructions\.js';/m, 'const $1 = globalThis.testInstructions;');

async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('The instruction editor did not reach the expected state.');
}

async function setup(t, seed = []) {
  const dom = new JSDOM(html, { url: 'https://fixture.test/popup.html', runScripts: 'outside-only' });
  const { window } = dom;
  t.after(() => window.close());
  const { INSTRUCTIONS_KEY: key } = instructions;
  const storage = { data: structuredClone(seed) };
  window.chrome = { storage: { local: {
    async get(name) { return { [name]: structuredClone(storage.data) }; },
    async set(values) { storage.data = structuredClone(values[key]); },
  } } };
  window.testInstructions = instructions;
  window.eval(translations);
  window.eval(script);
  const $ = selector => window.document.querySelector(selector);
  $('#instruction-settings').open = true;
  await until(() => !$('#add-instruction').disabled);
  return {
    $, storage,
    buttons: () => Array.from(window.document.querySelectorAll('#instruction-list button')),
    async save(kind, title, text) {
      $('#instruction-kind').value = kind;
      $('#instruction-title').value = title;
      $('#instruction-text').value = text;
      $('#instruction-editor').requestSubmit();
      await until(() => $('#instruction-editor').hidden);
    },
  };
}

test('saved instructions can be added, reopened, renamed, moved and removed independently', async t => {
  const view = await setup(t);
  assert.equal(view.$('#instruction-title').maxLength, instructions.MAX_INSTRUCTION_TITLE);
  assert.equal(view.$('#instruction-text').maxLength, instructions.MAX_INSTRUCTION_TEXT);
  view.$('#add-instruction').click();
  await view.save('reply', 'Check sources', 'Verify references.\nFlag any unknowns.');
  const [first] = view.storage.data;
  view.$('#add-instruction').click();
  await view.save('review', 'Challenge assumptions', 'List assumptions.');
  const [, second] = view.storage.data;
  assert.notEqual(first.id, second.id);

  const reopened = await setup(t, view.storage.data);
  assert.match(reopened.buttons()[1].textContent, /Challenge assumptions.*Cross-review/);
  reopened.buttons()[0].click();
  assert.equal(reopened.$('#instruction-text').value, 'Verify references.\nFlag any unknowns.');
  await reopened.save('prompt', 'Check claims', 'Flag uncertainty.');
  assert.deepEqual(reopened.storage.data, [
    { id: first.id, kind: 'prompt', title: 'Check claims', text: 'Flag uncertainty.', useByDefault: true },
    second,
  ]);
  reopened.buttons()[1].click();
  reopened.$('#remove-instruction').click();
  await until(() => reopened.buttons().length === 1);
  assert.equal(reopened.storage.data[0].id, first.id);
});

test('saving a stale instruction preserves the unsaved editor and the latest stored value', async t => {
  const original = { id: 'review', kind: 'review', title: 'Check facts', text: 'Check the numbers.' };
  const view = await setup(t, [original]);
  view.buttons()[0].click();
  view.$('#instruction-text').value = 'My unsaved edits';
  view.storage.data[0].text = 'Saved in another popup.';
  view.$('#instruction-editor').requestSubmit();
  await until(() => view.$('#instruction-status').classList.contains('error'));
  assert.match(view.$('#instruction-status').textContent, /This instruction changed/);
  assert.equal(view.$('#instruction-editor').hidden, false);
  assert.equal(view.$('#instruction-text').value, 'My unsaved edits');
  assert.equal(view.storage.data[0].text, 'Saved in another popup.');
});

test('new instructions are enabled by default and existing optional instructions can be enabled in the list', async t => {
  const original = { id: 'old', kind: 'review', title: 'Check facts', text: 'Check the numbers.' };
  const view = await setup(t, [original]);
  const checkbox = () => view.$('[data-default-id="old"]');
  assert.equal(checkbox().checked, false);
  assert.equal(checkbox().getAttribute('aria-label'), 'Use Check facts by default');
  checkbox().focus();
  checkbox().click();
  await until(() => view.storage.data[0].useByDefault === true && checkbox().checked);
  assert.equal(checkbox().ownerDocument.activeElement, checkbox());
  assert.match(view.buttons()[0].textContent, /Edit/);
  view.buttons()[0].click();
  assert.equal(view.$('#instruction-default').checked, true);
  view.$('#cancel-instruction').click();
  view.$('#add-instruction').click();
  assert.equal(view.$('#instruction-default').checked, true);
  view.$('#instruction-default').click();
  await view.save('reply', 'Optional', 'One-time only.');
  assert.equal(view.storage.data[1].useByDefault, false);
  const reopened = await setup(t, view.storage.data);
  assert.equal(reopened.$('[data-default-id="old"]').checked, true);
  reopened.buttons()[1].click();
  assert.equal(reopened.$('#instruction-default').checked, false);
});
