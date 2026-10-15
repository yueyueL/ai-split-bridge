import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabManager } from '../extension/tabs.js';
import { providerFor, hasSplit, conversationKey } from '../extension/providers.js';
import { mockChrome, chatTabs, deferred } from './mock-chrome.js';

test('provider recognition uses HTTPS and exact hosts', () => {
  assert.equal(providerFor('https://chatgpt.com/c/a'), 'chatgpt');
  assert.equal(providerFor('https://chat.openai.com/'), 'chatgpt');
  assert.equal(providerFor('https://claude.ai.evil.test/'), null);
  assert.equal(providerFor('http://grok.com/'), null);
  assert.equal(providerFor('not a URL'), null);
  assert.equal(hasSplit({ splitViewId: 0 }), true);
  for (const splitViewId of [-1, undefined, '10', null]) assert.equal(hasSplit({ splitViewId }), false);
  assert.equal(conversationKey('https://chatgpt.com/g/g-p-x/c/abc?model=4'), 'chatgpt:/c/abc');
  assert.equal(conversationKey('https://gemini.google.com/u/1/app/f00'), 'gemini:/app/f00');
  for (const url of ['https://chatgpt.com/', 'https://claude.ai/new', 'https://example.com/c/abc']) assert.equal(conversationKey(url), null);
});

test('context lists every AI chat in the window with its side and skips copies of the same conversation', async () => {
  const model = mockChrome([
    ...chatTabs(),
    { id: 3, url: 'https://gemini.google.com/app/g1', title: 'Trip ideas' },
    { id: 4, url: 'https://claude.ai/chat/two' },
    { id: 5, url: 'https://chatgpt.com/c/one' },
    { id: 6, url: 'https://example.com/' },
    { id: 7, url: 'https://grok.com/', discarded: true },
    { id: 8, url: 'https://grok.com/', windowId: 2 },
  ], { splitApi: false });
  const left = await createTabManager(model.api).context(1);
  assert.equal(left.side, 'left');
  assert.equal(left.peer.id, 2);
  assert.equal(left.peer.side, 'right');
  assert.deepEqual(left.chats.map(chat => [chat.id, chat.side]), [[2, 'right'], [3, null], [7, null]]);
  assert.equal(left.chats.find(chat => chat.id === 7).asleep, true);
  assert.deepEqual(left.closed, []);
  const right = await createTabManager(model.api).context(2);
  assert.equal(right.side, 'right');
  assert.equal(right.peer.id, 1);
  assert.equal(right.peer.side, 'left');
  const alone = await createTabManager(model.api).context(3);
  assert.equal(alone.side, null);
  assert.equal(alone.peer, null);
  assert.deepEqual(alone.chats.map(chat => [chat.id, chat.side]), [[1, null], [2, null], [7, null]]);
});

test('closed assistants are offered as new chats, and a remembered conversation stays offered until reopened', async () => {
  const model = mockChrome(chatTabs(), { splitApi: false, session: { 'urls:1': { gemini: 'https://gemini.google.com/app/old', claude: 'https://claude.ai/chat/two' } } });
  const state = await createTabManager(model.api).context(1);
  assert.deepEqual(state.closed, [
    { provider: 'gemini', name: 'Gemini', remembered: true },
    { provider: 'grok', name: 'Grok', remembered: false },
  ]);
});

test('pair arranges existing tabs left/right even when their strip order is reversed', async () => {
  const model = mockChrome([
    { id: 2, url: 'https://claude.ai/new' },
    { id: 9 },
    { id: 1, url: 'https://chatgpt.com/' },
  ]);
  await createTabManager(model.api).pair(1, 2);
  assert.deepEqual(model.order(), [9, 1, 2]);
  assert.equal(model.data.get(1).splitViewId, model.data.get(2).splitViewId);
  assert.equal(model.data.get(1).active, true);
});

test('without split-management APIs pairing explains Chrome’s own menu and changes nothing', async () => {
  const model = mockChrome([{ id: 1, url: 'https://chatgpt.com/' }, { id: 2, url: 'https://claude.ai/new' }], { splitApi: false });
  const manager = createTabManager(model.api);
  await assert.rejects(manager.pair(1, 2), /Split View option/);
  await assert.rejects(manager.replace(1, { provider: 'gemini' }), /Split View first/);
  assert.equal(model.calls.some(call => ['move', 'create', 'update', 'storage.set'].includes(call.method)), false);
});

for (const side of ['left', 'right']) {
  test(`switching the ${side} side preserves every tab and conversation`, async () => {
    const initial = side === 'left'
      ? [{ id: 3, url: 'https://gemini.google.com/app/previous' }, ...chatTabs()]
      : [...chatTabs(), { id: 9 }, { id: 3, url: 'https://gemini.google.com/app/previous' }];
    const model = mockChrome(initial);
    const source = side === 'left' ? 1 : 2;
    const peer = side === 'left' ? 2 : 1;
    const originalUrls = [...model.data.values()].map(tab => [tab.id, tab.url]);
    const result = await createTabManager(model.api).replace(source, { provider: 'gemini' });
    assert.equal(result.tabId, 3);
    assert.equal(model.data.get(3).splitViewId, model.data.get(peer).splitViewId);
    assert.equal(model.data.get(source).splitViewId, -1);
    assert.equal(model.data.get(3).index + (side === 'left' ? 1 : -1), model.data.get(peer).index);
    assert.deepEqual([...model.data.values()].map(tab => [tab.id, tab.url]), originalUrls);
    assert.equal(model.calls.some(call => call.method === 'create'), false);
    assert.equal(model.calls.some(call => call.method === 'update' && 'url' in call.args[1]), false);
  });
}

test('with split APIs a specific hidden chat is swapped in, not just any tab from that assistant', async () => {
  const model = mockChrome([...chatTabs(),
    { id: 3, url: 'https://gemini.google.com/app/newer', lastAccessed: 99999 },
    { id: 4, url: 'https://gemini.google.com/app/chosen' },
  ]);
  const result = await createTabManager(model.api).replace(2, { tabId: 4 });
  assert.equal(result.tabId, 4);
  assert.equal(model.data.get(4).splitViewId, model.data.get(1).splitViewId);
  assert.equal(model.data.get(3).splitViewId, -1);
  model.data.get(3).splitViewId = model.data.get(2).splitViewId = 30;
  await assert.rejects(createTabManager(model.api).replace(4, { tabId: 3 }), /another split/);
});

test('switching back prefers the remembered conversation over a newer tab from that provider', async () => {
  const model = mockChrome([...chatTabs(),
    { id: 3, url: 'https://gemini.google.com/app/existing' },
    { id: 4, url: 'https://claude.ai/chat/newer', lastAccessed: 99999 },
  ]);
  const manager = createTabManager(model.api);
  await manager.replace(2, { provider: 'gemini' });
  await manager.replace(3, { provider: 'claude' });
  assert.equal(model.data.get(1).splitViewId, model.data.get(2).splitViewId);
  assert.equal(model.data.get(4).splitViewId, -1);
  assert.equal(model.data.get(3).splitViewId, -1);
});

test('failed split creation restores the original pair without closing any conversation', async () => {
  const model = mockChrome([...chatTabs(), { id: 3, url: 'https://gemini.google.com/app' }]);
  model.failSplits = 1;
  await assert.rejects(createTabManager(model.api).replace(2, { provider: 'gemini' }), /original split was restored/);
  assert.equal(model.data.size, 3);
  assert.equal(model.data.get(1).splitViewId, model.data.get(2).splitViewId);
  assert.ok(model.data.get(1).splitViewId >= 0);
  assert.equal(model.data.get(3).splitViewId, -1);
});

test('pair rejects mismatched groups, pinned states, and windows before rearranging', async () => {
  for (const different of [{ groupId: 8 }, { pinned: true }, { windowId: 2 }]) {
    const model = mockChrome([
      { id: 1, url: 'https://chatgpt.com/' },
      { id: 2, url: 'https://claude.ai/new', ...different },
    ]);
    await assert.rejects(createTabManager(model.api).pair(1, 2));
    assert.equal(model.calls.some(call => ['move', 'createSplit', 'unsplit'].includes(call.method)), false);
  }
});

test('switch creates a compatible tab instead of altering an incompatible existing conversation', async () => {
  const model = mockChrome([
    ...chatTabs().map(tab => ({ ...tab, groupId: 7 })),
    { id: 3, url: 'https://gemini.google.com/app/keep', groupId: 9 },
  ]);
  await createTabManager(model.api).replace(2, { provider: 'gemini' });
  assert.equal(model.data.get(3).groupId, 9);
  assert.equal(model.data.get(3).splitViewId, -1);
  const incoming = model.data.get(4);
  assert.equal(incoming.groupId, 7);
  assert.equal(incoming.splitViewId, model.data.get(1).splitViewId);
  assert.ok(model.calls.findIndex(call => call.method === 'group') < model.calls.findIndex(call => call.method === 'unsplit'));
});

test('failure preparing a compatible replacement leaves the original split intact', async () => {
  const model = mockChrome(chatTabs().map(tab => ({ ...tab, groupId: 7 })));
  model.before = method => { if (method === 'group') throw new Error('Cannot group tabs now'); };
  await assert.rejects(createTabManager(model.api).replace(2, { provider: 'gemini' }), /Cannot group/);
  assert.equal(model.calls.some(call => call.method === 'unsplit'), false);
  assert.equal(model.data.get(1).splitViewId, 10);
  assert.equal(model.data.get(2).splitViewId, 10);
});

test('navigation fallback switches inside the pane and either side can return to the remembered conversation', async () => {
  const model = mockChrome(chatTabs(), { splitApi: false });
  const manager = createTabManager(model.api);
  const result = await manager.replace(2, { provider: 'gemini' });
  assert.equal(result.tabId, 2);
  assert.equal(model.data.get(2).url, 'https://gemini.google.com/app');
  assert.equal(model.data.get(2).splitViewId, 10);
  assert.deepEqual((await manager.context(1)).closed.map(entry => [entry.provider, entry.remembered]), [['claude', true], ['grok', false]]);
  await manager.replace(1, { provider: 'claude' });
  assert.equal(model.data.get(1).url, 'https://claude.ai/chat/two');
  await manager.replace(2, { provider: 'chatgpt' });
  assert.equal(model.data.get(2).url, 'https://chatgpt.com/c/one');
  assert.equal(model.data.size, 2);
  assert.equal(model.messages('ASB_CAN_LEAVE').length, 3);
  assert.equal(model.calls.some(c => ['move', 'unsplit', 'createSplit', 'create'].includes(c.method)), false);
});

test('navigation fallback shows a specific hidden chat by opening its conversation in the pane', async () => {
  const model = mockChrome([...chatTabs(), { id: 3, url: 'https://gemini.google.com/app/hidden' }], { splitApi: false });
  model.respond = () => ({ ok: true, page: 123 });
  const manager = createTabManager(model.api);
  const result = await manager.replace(2, { tabId: 3 });
  assert.deepEqual([result.tabId, result.provider, result.previousPage], [2, 'gemini', 123]);
  assert.equal(model.data.get(2).url, 'https://gemini.google.com/app/hidden');
  assert.equal(model.data.get(3).url, 'https://gemini.google.com/app/hidden');
  assert.deepEqual((await manager.context(1)).chats.map(chat => [chat.id, chat.side]), [[2, 'right']]);
  await assert.rejects(manager.replace(2, { tabId: 1 }), /already on the other side/);
});

test('fallback refuses to navigate when draft/generation guard fails or content connection is unavailable', async () => {
  for (const disconnected of [false, true]) {
    const model = mockChrome(chatTabs(), { splitApi: false });
    model.respond = () => { if (disconnected) throw Error('No content'); return { ok: false, error: 'Send or clear Claude’s draft.' }; };
    await assert.rejects(createTabManager(model.api).replace(2, { provider: 'grok' }), /draft|Refresh/);
    assert.equal(model.data.get(2).url, 'https://claude.ai/chat/two');
    assert.equal(model.calls.some(c => c.method === 'update'), false);
  }
});

test('fallback rechecks the split after saving URLs and never follows an untrusted stored URL', async () => {
  const model = mockChrome(chatTabs(), { splitApi: false, session: { 'urls:1': { grok: 'https://attacker.example/' } } });
  const manager = createTabManager(model.api);
  await manager.replace(2, { provider: 'grok' });
  assert.equal(model.data.get(2).url, 'https://grok.com/');
  model.before = method => { if (method === 'storage.set') model.data.get(1).splitViewId = -1; };
  await assert.rejects(manager.replace(2, { provider: 'claude' }), /split changed/);
  assert.equal(model.data.get(2).url, 'https://grok.com/');
});

test('navigation to another page is rejected before any tab mutation', async () => {
  const model = mockChrome(chatTabs());
  model.data.get(1).pendingUrl = 'https://chatgpt.com/c/different';
  await assert.rejects(createTabManager(model.api).replace(1, { provider: 'gemini' }), /finish navigating/);
  assert.equal(model.calls.some(call => ['unsplit', 'move', 'create'].includes(call.method)), false);
});

for (const change of ['replace source', 'reverse sides', 'split incoming elsewhere']) {
  test(`switch rechecks the split after asynchronous preparation: ${change}`, async () => {
    const model = mockChrome([
      ...chatTabs(), { id: 3, url: 'https://gemini.google.com/app' },
      { id: 4, url: 'https://grok.com/' },
    ]);
    let changed = false;
    model.before = (method, args) => {
      if (method !== 'storage.set' || !args[0]['recent:1'] || changed) return;
      changed = true;
      if (change === 'replace source') {
        model.data.get(2).splitViewId = -1;
        model.data.get(4).splitViewId = 10;
        // Chrome keeps the replacement next to its native peer.
        model.data.get(4).index = 1;
        model.data.get(2).index = 3;
      } else if (change === 'reverse sides') {
        model.data.get(1).index = 1;
        model.data.get(2).index = 0;
      } else {
        model.data.get(3).splitViewId = model.data.get(4).splitViewId = 20;
      }
    };
    await assert.rejects(createTabManager(model.api).replace(2, { provider: 'gemini' }), /split changed while switching/);
    assert.equal(changed, true);
    assert.equal(model.calls.some(call => ['unsplit', 'move', 'createSplit'].includes(call.method)), false);
    assert.equal(model.data.get(1).splitViewId, 10);
    if (change === 'replace source') assert.equal(model.data.get(4).splitViewId, 10);
    if (change === 'reverse sides') assert.deepEqual(model.order().slice(0, 2), [2, 1]);
    if (change === 'split incoming elsewhere') assert.equal(model.data.get(3).splitViewId, 20);
  });
}

test('a newly created tab with only pendingUrl waits for its committed AI URL before unsplitting', async () => {
  const model = mockChrome(chatTabs());
  const waiting = deferred();
  let incomingReads = 0;
  model.before = (method, args) => {
    if (method !== 'get' || args[0] !== 3) return;
    incomingReads++;
    const tab = model.data.get(3);
    if (incomingReads === 1) {
      tab.url = '';
      tab.pendingUrl = 'https://gemini.google.com/app';
      waiting.resolve();
    } else {
      tab.url = 'https://gemini.google.com/app';
      delete tab.pendingUrl;
    }
  };
  const switching = createTabManager(model.api).replace(2, { provider: 'gemini' });
  await waiting.promise;
  assert.equal(model.calls.some(call => call.method === 'unsplit'), false);
  assert.equal(model.data.get(1).splitViewId, 10);
  assert.equal(model.data.get(2).splitViewId, 10);
  await switching;
  assert.ok(incomingReads >= 2);
  assert.equal(model.data.get(3).splitViewId, model.data.get(1).splitViewId);
  assert.equal(model.data.get(2).splitViewId, -1);
});
