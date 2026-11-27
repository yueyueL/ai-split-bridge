import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import * as actionsModule from '../extension/actions.js';
import * as settingsModule from '../extension/settings.js';
import { translations } from './translations.js';

const extension = new URL('../extension/', import.meta.url);
const read = file => readFile(new URL(file, extension), 'utf8');
const [html, actions, settings] = await Promise.all([read('popup.html'), read('popup-actions.js'), read('popup.js')]);

async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('The popup did not reach the expected state.');
}

function store(data = {}) {
  return {
    data,
    async get(key) { return structuredClone(key == null ? data : { [key]: data[key] }); },
    async set(changes) { Object.assign(data, structuredClone(changes)); },
  };
}

async function open(t, { storage = { local: store(), sync: store() }, intent, query = '' } = {}) {
  const dom = new JSDOM(html, { url: 'https://extension.test/popup.html' + query, runScripts: 'outside-only' });
  const { window } = dom;
  t.after(() => window.close());
  const $ = selector => window.document.querySelector(selector);
  const all = selector => Array.from(window.document.querySelectorAll(selector));
  window.chrome = { storage, runtime: { sendMessage: async message =>
    message.type === 'ASB_ACTION_EDITOR_CONTEXT' ? { ok: true, kind: intent } : { ok: true, tabs: [] } } };
  window.settingsModule = settingsModule;
  window.actionsModule = actionsModule;
  window.eval(translations);
  window.eval(settings.replace(/^import (.+) from .*$/m, 'const $1 = settingsModule;'));
  window.eval(actions.replace(/^import (.+) from .*$/m, 'const $1 = actionsModule;'));
  await until(() => !$('#add-action').disabled && !$('#send-now').disabled);
  return {
    $, all, window, storage,
    choose(kind) { $(`input[name=action-kind][value="${kind}"]`).click(); },
    async save(title, prompt) {
      $('#action-title').value = title;
      $('#action-prompt').value = prompt;
      $('#action-editor').requestSubmit();
      await until(() => $('#action-editor').hidden && $('#action-status').textContent === 'Saved');
    },
  };
}

test('reply, prompt and review actions appear beside their category’s built-ins and each has one default', async t => {
  const view = await open(t);
  const { $, all, storage } = view;
  const saved = {};
  for (const [kind, title, prompt, before] of [
    ['reply', 'Explain simply', 'Explain {reply} in plain language.', 2],
    ['prompt', 'Translate', 'Translate {content} into French.', 1],
    ['review', 'Check references', 'Verify every source in the opposite answer.', 3],
  ]) {
    view.choose(kind);
    assert.equal(all('#action-list li').length, before);
    $('#add-action').click();
    assert.equal($('#action-placeholders').hidden, kind === 'review');
    assert.equal($('#action-kinds').disabled, true);
    await view.save(title, prompt);
    const last = all('#action-list li').at(-1);
    const radio = last.querySelector('input');
    saved[kind] = radio.dataset.defaultAction;
    assert.equal(last.querySelector('label').textContent, title);
    radio.click();
    await until(() => storage.local.data.workflowActions.defaults[kind] === saved[kind]);
    assert.equal(all('#action-list :checked').length, 1);
  }
  const again = await open(t, { storage });
  again.choose('review');
  assert.equal(again.$('#action-list :checked').dataset.defaultAction, saved.review);
  again.$(`[data-edit-action="${saved.review}"]`).click();
  assert.equal(again.$('#action-title').readOnly, false);
  assert.equal(again.$('#action-prompt').value, 'Verify every source in the opposite answer.');
  await again.save('Verify citations', 'Prioritize the disputed claims.');
  again.$(`[data-edit-action="${saved.review}"]`).click();
  again.$('#delete-action').click();
  await until(() => again.$('#action-editor').hidden);
  assert.equal(again.$('#action-list :checked').dataset.defaultAction, 'critique');
  for (const kind of ['prompt', 'reply']) {
    again.choose(kind);
    assert.equal(again.$('#action-list :checked').dataset.defaultAction, saved[kind]);
  }
});

test('built-in prompt edits survive changes from the separate settings form and can be reset', async t => {
  const storage = { local: store(), sync: store({ settings: { shareMessage: 'Original {reply}', errorsMessage: 'Older saved error instructions' } }) };
  const view = await open(t, { storage });
  const { $, window } = view;
  $('[data-edit-action="review-reply"]').click();
  assert.equal($('#action-prompt').value, 'Original {reply}');
  assert.equal($('#action-title').readOnly, true);
  assert.equal($('#delete-action').hidden, true);
  $('#action-prompt').value = 'Inspect ';
  $('#action-prompt').setSelectionRange(8, 8);
  $('[data-action-token="{content}"]').click();
  await view.save('Review reply', $('#action-prompt').value);
  $('#send-now').click();
  $('#share-kind').value = 'comparison';
  $('#share-kind').dispatchEvent(new window.Event('change'));
  $('#share-message').value = 'Compare {answers}.';
  $('#share-message').dispatchEvent(new window.Event('input'));
  window.dispatchEvent(new window.Event('pagehide'));
  await until(() => $('#saved').textContent === 'Saved');
  assert.equal(storage.sync.data.settings.shareMessage, 'Inspect {content}');
  const again = await open(t, { storage });
  again.$('[data-edit-action="review-reply"]').click();
  assert.equal(again.$('#action-prompt').value, 'Inspect {content}');
  again.$('#reset-action').click();
  await until(() => again.$('#action-editor').hidden);
  assert.equal(storage.sync.data.settings.shareMessage, settingsModule.DEFAULT_SHARE_MESSAGE);
  again.choose('review');
  again.$('[data-edit-action="errors"]').click();
  assert.equal(again.$('#action-prompt').value, 'Older saved error instructions');
  await again.save('Find errors', 'Cite your source.');
  assert.equal(storage.sync.data.settings.errorsMessage, 'Cite your source.');
  assert.equal(storage.sync.data.settings.comparisonMessage, 'Compare {answers}.');
});

test('chat add-action shortcuts open the editor directly in their workflow', async t => {
  for (const [options, expected] of [[{ intent: 'review' }, 'review'], [{ query: '?addAction=prompt' }, 'prompt']]) {
    const { $ } = await open(t, options);
    await until(() => !$('#action-editor').hidden);
    assert.equal($('#action-kinds input:checked').value, expected);
    assert.equal($('#action-prompt').value, '');
    assert.equal($('#action-title').readOnly, false);
  }
  const { $ } = await open(t, { query: '?addAction=unknown' });
  assert.equal($('#action-editor').hidden, true);
  assert.equal($('#action-kinds input:checked').value, 'reply');
});

test('a simultaneous action edit preserves the newer stored prompt and the local unsaved draft', async t => {
  const view = await open(t);
  const { $, storage } = view;
  $('[data-edit-action="review-reply"]').click();
  $('#action-prompt').value = 'My draft';
  await settingsModule.saveSettings(storage.sync, { shareMessage: 'Edited in a different popup' });
  $('#action-editor').requestSubmit();
  await until(() => $('#action-status').classList.contains('error'));
  assert.equal($('#action-editor').hidden, false);
  assert.equal($('#action-prompt').value, 'My draft');
  assert.equal(storage.sync.data.settings.shareMessage, 'Edited in a different popup');
});
