import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTRUCTIONS_KEY, MAX_INSTRUCTIONS, MAX_INSTRUCTION_TEXT, instructionBlock, readInstructions, saveInstructions,
} from '../extension/instructions.js';

const first = { id: 'verify', kind: 'reply', title: '  Check sources ', text: ' Check {reply} and cite sources. ' };
const second = { id: 'format', kind: 'reply', title: 'Numbered list', text: 'Use a numbered list.\r\nGive an example.' };
const prompt = { id: 'compare', kind: 'prompt', title: 'Compare approaches', text: 'Show two approaches.' };

function makeStorage(initial) {
  const data = { [INSTRUCTIONS_KEY]: initial };
  return {
    async get(key) { return structuredClone({ [key]: data[key] }); },
    async set(values) { Object.assign(data, structuredClone(values)); },
  };
}

test('saved instructions round-trip in their existing order and only keep validated fields', async () => {
  const storage = makeStorage();
  assert.deepEqual(await readInstructions(storage), []);
  const entries = await saveInstructions(storage, [first, second, prompt]);
  assert.deepEqual(entries, [
    { ...first, useByDefault: false, title: 'Check sources', text: 'Check {reply} and cite sources.' },
    { ...second, useByDefault: false, text: 'Use a numbered list.\nGive an example.' },
    { ...prompt, useByDefault: false },
  ]);
  assert.deepEqual(await readInstructions(storage), entries);
  await assert.rejects(saveInstructions(storage, [first, first]), /different ID/);
  await assert.rejects(saveInstructions(storage, [{ ...first, text: '' }]), /instruction text/);
  await assert.rejects(saveInstructions(storage, [{ ...first, kind: 'compare' }]), /valid use/);
  await assert.rejects(saveInstructions(storage, Array(MAX_INSTRUCTIONS + 1).fill(first)), /saved instructions/);
  assert.deepEqual(await readInstructions(storage), entries);
});

test('used instructions stack in library order before one-time text and keep curly braces literal', async () => {
  const storage = makeStorage([first, second, prompt, first, null]);
  const extra = await instructionBlock(storage, 'reply', { instructionIds: ['format', 'verify'], instructionText: 'Keep {assistant} literal.' });
  assert.equal(extra, 'Additional instructions\n\nCheck {reply} and cite sources.\n\nUse a numbered list.\nGive an example.\n\nKeep {assistant} literal.');
  assert.equal(await instructionBlock(storage, 'prompt', { instructionText: 'Use examples.' }), 'Additional instructions\n\nUse examples.');
  assert.equal(await instructionBlock(undefined, 'reply'), '', 'missing library has no default instructions');
  assert.deepEqual((await readInstructions(storage)).map(preset => preset.id), ['verify', 'format', 'compare']);
});

test('deleted, mis-scoped, malformed, or oversized instructions fail clearly without replacing the library', async () => {
  const storage = makeStorage([first, prompt]);
  for (const id of ['deleted', 'compare']) {
    await assert.rejects(instructionBlock(storage, 'reply', { instructionIds: [id] }), /changed/);
  }
  await assert.rejects(instructionBlock(storage, 'reply', { instructionIds: [first.id, first.id] }), /valid instructions/);
  await assert.rejects(instructionBlock(storage, 'conversation', { instructionIds: [first.id] }), /valid instructions/);
  await assert.rejects(instructionBlock(storage, 'reply', { instructionText: 'a'.repeat(MAX_INSTRUCTION_TEXT + 1) }), /one-time instruction/);
  assert.deepEqual((await readInstructions(storage)).map(preset => preset.id), ['verify', 'compare']);
});

test('omitting a selection applies defaults for that action; an explicit selection replaces them', async () => {
  const storage = makeStorage([first, { ...second, useByDefault: true }, { ...prompt, useByDefault: true }]);
  assert.equal(await instructionBlock(storage, 'reply'), 'Additional instructions\n\nUse a numbered list.\nGive an example.');
  assert.equal(await instructionBlock(storage, 'prompt'), 'Additional instructions\n\nShow two approaches.');
  assert.equal(await instructionBlock(storage, 'reply', { instructionIds: [] }), '');
  assert.equal(await instructionBlock(storage, 'reply', { instructionIds: [first.id] }), 'Additional instructions\n\nCheck {reply} and cite sources.');
  for (const kind of ['review', 'handoff', 'conversation']) assert.equal(await instructionBlock(storage, kind), '');
});
