import test from 'node:test';
import assert from 'node:assert/strict';
import { composeShare, DEFAULT_SHARE_MESSAGE, loadSettings, MAX_SHARE_MESSAGE, readSettings, saveSettings } from '../extension/settings.js';

const memory = (initial = {}) => {
  const data = structuredClone(initial);
  return { data, async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; }, async set(value) { Object.assign(data, structuredClone(value)); } };
};

test('by default a shared reply is sent right away inside the standard message', async () => {
  const settings = await loadSettings(memory());
  assert.deepEqual(settings, { shareMode: 'send', shareMessage: DEFAULT_SHARE_MESSAGE });
  assert.equal(composeShare(settings.shareMessage, { assistant: 'Grok', reply: 'Hi there.' }),
    "Here is Grok's reply:\n\nHi there.\n\nWhat do you think? Point out anything wrong or missing.");
});

test('your own message wraps the reply, and without {reply} the reply goes at the end', () => {
  const reply = 'Use {assistant} and {reply} literally. $& $1';
  assert.equal(composeShare('Critique {assistant}:\n{reply}\n— from {assistant}', { assistant: 'Claude', reply }),
    `Critique Claude:\n${reply}\n— from Claude`, 'placeholders inside the reply are left alone');
  assert.equal(composeShare('Summarize this in one line.  \n', { assistant: 'Gemini', reply: 'Long answer.' }),
    'Summarize this in one line.\n\nLong answer.');
});

test('saved settings are kept, and anything unexpected falls back to the defaults', async () => {
  const storage = memory();
  await saveSettings(storage, { shareMode: 'draft' });
  await saveSettings(storage, { shareMessage: 'Check {assistant}: {reply}' });
  assert.deepEqual(await loadSettings(storage), { shareMode: 'draft', shareMessage: 'Check {assistant}: {reply}' });
  await saveSettings(storage, { shareMessage: '   ' });
  assert.equal((await loadSettings(storage)).shareMessage, DEFAULT_SHARE_MESSAGE);
  for (const stored of [null, 'x', { shareMode: 'post', shareMessage: 42 }]) {
    assert.deepEqual(readSettings(stored), { shareMode: 'send', shareMessage: DEFAULT_SHARE_MESSAGE });
  }
  assert.equal(readSettings({ shareMessage: 'x'.repeat(MAX_SHARE_MESSAGE + 10) }).shareMessage.length, MAX_SHARE_MESSAGE);
});
