import test from 'node:test';
import assert from 'node:assert/strict';
import { mockChrome, chatTabs } from './mock-chrome.js';

async function load(t, tabs, options) {
  const model = mockChrome(tabs, options);
  let listener;
  const event = () => ({ addListener() {} });
  Object.assign(model.api.tabs, { onUpdated: event(), onMoved: event(), onAttached: event(), onDetached: event(), onCreated: event(), onRemoved: event(), onActivated: event() });
  model.api.storage.onChanged = event();
  model.api.windows = { onRemoved: event() };
  model.api.runtime = { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`, onMessage: { addListener(fn) { listener = fn; } } };
  globalThis.chrome = model.api;
  t.after(() => delete globalThis.chrome);
  await import(`../extension/background.js?test=${Date.now()}${Math.random()}`);
  const sender = { id: 'test-extension', frameId: 0, url: 'https://chatgpt.com/c/one', tab: { id: 1 } };
  const request = (message, from = sender) => new Promise(resolve => listener(message, from, resolve));
  return { model, request, sender };
}

test('a chat page acts only as itself: it can reach other open chats but never speak for another tab', async t => {
  const { model, request, sender } = await load(t, [...chatTabs(), { id: 3, url: 'https://grok.com/c/x' }]);
  model.respond = (_id, message) => message.type === 'ASB_READ_DRAFT' ? { ok: true, text: 'Hello' } : { ok: true };
  const context = await request({ type: 'ASB_CONTEXT' });
  assert.equal(context.source, undefined);
  assert.equal(context.shareMode, 'send');
  assert.deepEqual(context.chats.map(chat => [chat.id, chat.side]), [[2, 'right'], [3, null]]);
  const sent = await request({ type: 'ASB_SEND', targetIds: [3], sourceId: 2 });
  assert.equal(sent.ok, true);
  assert.equal(model.messages('ASB_READ_DRAFT')[0].args[0], 1, 'the sender is always the source');
  assert.deepEqual(model.messages('ASB_COMMIT').map(call => call.args[0]).sort(), [1, 3]);
  const before = model.messages().length;
  for (const [message, from] of [
    [{ type: 'ASB_SHARE', targetId: 1, reply: 'Loop' }, sender],
    [{ type: 'ASB_SHARE', targetId: 2, reply: 'From a frame' }, { ...sender, frameId: 1 }],
    [{ type: 'ASB_SHARE', targetId: 2, reply: 'Wrong site' }, { ...sender, url: 'https://claude.ai/chat/two' }],
    [{ type: 'ASB_SHARE', targetId: 2, reply: '  ' }, sender],
    [{ type: 'ASB_SHARE', targetId: 2, text: 'A page-made message' }, sender],
  ]) assert.equal((await request(message, from)).ok, false, JSON.stringify(message));
  assert.equal(model.messages().length, before, 'refused shares touch no chat');
  const shared = await request({ type: 'ASB_SHARE', targetId: 2, reply: 'Review this.' });
  assert.deepEqual([shared.ok, shared.message], [true, 'Sent to Claude.']);
  assert.equal(model.messages('ASB_PREPARE').at(-1).args[1].text,
    "Here is ChatGPT's reply:\n\nReview this.\n\nWhat do you think? Point out anything wrong or missing.");
  assert.deepEqual(model.messages('ASB_COMMIT').map(call => call.args[0]).sort(), [1, 2, 3]);
});

test('your share settings decide whether a shared reply is sent or drafted, and what surrounds it', async t => {
  const { model, request } = await load(t, chatTabs(), { sync: { settings: { shareMode: 'draft', shareMessage: 'Find the flaws in {assistant}’s answer:\n{reply}' } } });
  assert.equal((await request({ type: 'ASB_CONTEXT' })).shareMode, 'draft');
  const shared = await request({ type: 'ASB_SHARE', targetId: 2, reply: 'The answer is 42.' });
  assert.equal(shared.ok, true);
  assert.equal(model.messages('ASB_COMMIT').length, 0, 'draft mode never sends');
  assert.deepEqual(model.messages('ASB_INSERT').map(call => [call.args[0], call.args[1].text]),
    [[2, 'Find the flaws in ChatGPT’s answer:\nThe answer is 42.']]);
});

test('popup-only actions are refused from chat pages and unknown pages', async t => {
  const { request, sender } = await load(t, chatTabs());
  for (const from of [sender, { id: 'test-extension', url: 'https://example.com/' }]) {
    const result = await request({ type: 'ASB_OPEN', provider: 'grok' }, from);
    assert.equal(result.ok, false);
  }
  const popup = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
  const list = await request({ type: 'ASB_LIST' }, popup);
  assert.equal(list.ok, true);
  assert.equal(list.peer.id, 2);
  const foreign = await request({ type: 'ASB_LIST' }, { ...popup, id: 'another-extension' });
  assert.equal(foreign.ok, false);
});
