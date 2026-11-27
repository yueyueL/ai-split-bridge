import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS_KEY, changeAction, readActions, resolveAction } from '../extension/actions.js';
import { defaultMessages, loadSettings, saveSettings } from '../extension/settings.js';

function memory(initial = {}) {
  const data = structuredClone(initial);
  return {
    async get(key) { return key == null ? structuredClone(data) : { [key]: structuredClone(data[key]) }; },
    async set(values) { Object.assign(data, structuredClone(values)); },
  };
}

test('built-in actions inherit saved templates and reset only the selected action', async () => {
  const storage = { local: memory(), sync: memory({ settings: {
    shareMode: 'draft', errorsMessage: 'Check the proof.', reviewGuidance: 'Keep excerpts precise.',
  } }) };
  const actions = await readActions(storage);
  assert.deepEqual(actions.map(({ id, kind, isDefault }) => [id, kind, isDefault]), [
    ['review-reply', 'reply', true], ['handoff', 'reply', false], ['respond', 'prompt', true], ['critique', 'review', true],
    ['errors', 'review', false], ['improvements', 'review', false],
  ]);
  assert.equal(resolveAction(actions, 'review', 'errors').prompt, 'Check the proof.');
  await Promise.all([
    changeAction(storage, { type: 'edit', id: 'errors', kind: 'review', prompt: 'Check atomicity.' }),
    saveSettings(storage.sync, { comparisonMessage: 'Compare the reasoning.' }),
  ]);
  assert.equal((await loadSettings(storage.sync)).errorsMessage, 'Check atomicity.');
  assert.equal((await loadSettings(storage.sync)).comparisonMessage, 'Compare the reasoning.');
  let updated = await changeAction(storage, { type: 'default', id: 'errors', kind: 'review' });
  assert.equal(resolveAction(updated, 'review').id, 'errors');
  updated = await changeAction(storage, { type: 'reset', id: 'errors', kind: 'review' }, 'zh-CN');
  assert.equal(resolveAction(updated, 'review').prompt, defaultMessages('zh-CN').errorsMessage);
  const settings = await loadSettings(storage.sync);
  assert.equal(settings.reviewGuidance, 'Keep excerpts precise.');
  assert.equal(settings.shareMode, 'draft');
  assert.deepEqual((await storage.local.get(ACTIONS_KEY))[ACTIONS_KEY].custom, []);
});

test('concurrent additions, edits, stale changes and deletion preserve the rest of the action library', async () => {
  const storage = { local: memory(), sync: memory() };
  await Promise.all(['reply', 'prompt', 'review'].map(kind =>
    changeAction(storage, { type: 'add', kind, title: kind + ' action', prompt: 'Give one example.' })));
  const actions = await readActions(storage);
  assert.equal(actions.filter(a => !a.builtin).length, 3);
  const original = actions.find(a => !a.builtin && a.kind === 'reply');
  const { id, kind } = original;
  await changeAction(storage, { type: 'default', kind, id });
  const updated = await changeAction(storage, { type: 'edit', kind, id, title: 'Keep evidence', prompt: 'Quote exact figures.', expected: original });
  assert.equal(resolveAction(updated, kind).prompt, 'Quote exact figures.');
  assert.equal(resolveAction(updated, 'prompt').id, 'respond');
  await assert.rejects(changeAction(storage, { type: 'delete', kind, id, expected: original }), /action changed/);
  await assert.rejects(changeAction(storage, { type: 'default', kind: 'review', id }), /no longer available/);
  await assert.rejects(changeAction(storage, { type: 'default', kind }), /no longer available/);
  await assert.rejects(changeAction(storage, { type: 'edit', kind, id, title: '', prompt: 'abc' }), /action name/);
  await assert.rejects(changeAction(storage, { type: 'edit', kind, id, title: 'abc', prompt: ' ' }), /action prompt/);
  const remaining = await changeAction(storage, { type: 'delete', kind, id });
  assert.equal(remaining.filter(a => !a.builtin).length, 2);
  assert.equal(resolveAction(remaining, kind).id, 'review-reply');
  assert.throws(() => resolveAction(remaining, kind, id), /no longer available/);
  await assert.rejects(changeAction(storage, { type: 'delete', kind, id: 'review-reply' }), /Unsupported/);
  assert.deepEqual(await readActions(storage), remaining);
});

test('stale defaults and invalid saved entries fall back to a real built-in for each workflow', async () => {
  const storage = { sync: memory(), local: memory({ [ACTIONS_KEY]: {
    defaults: { review: 'removed-action', reply: 'prompt-only' },
    custom: [
      { id: 'prompt-only', kind: 'prompt', title: 'Translate', prompt: 'Write in German.' },
      { id: 'errors', kind: 'reply', title: 'Shadow', prompt: 'Override a built-in from the wrong workflow.' },
      { id: 'empty', kind: 'review', title: '', prompt: 'Empty title' },
      { id: 'prompt-only', kind: 'review', title: 'Duplicate', prompt: 'Ambiguous ID' },
    ],
  } }) };
  const catalog = await readActions(storage);
  assert.deepEqual(catalog.filter(a => !a.builtin).map(a => a.id), ['prompt-only']);
  assert.deepEqual(catalog.filter(a => a.isDefault).map(a => a.id), ['review-reply', 'respond', 'critique']);
});
