import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, validateText } from '../extension/bridge.js';
import { createTabManager } from '../extension/tabs.js';
import { mockChrome, chatTabs, deferred } from './mock-chrome.js';

function setup({ splitApi = true } = {}) {
  const model = mockChrome([
    ...chatTabs(),
    { id: 3, url: 'https://gemini.google.com/app/hidden' },
    { id: 4, url: 'https://grok.com/c/hidden' },
  ], { splitApi });
  const manager = createTabManager(model.api);
  model.respond = (id, message) => message.type === 'ASB_READ_DRAFT'
    ? { ok: true, text: 'Compare these independent answers.\nKeep the formatting.' }
    : { ok: true };
  return { model, manager, bridge: createBridge(model.api, manager, { retryDelay: 1, retryLimit: 5 }) };
}

test('send waits for every chosen chat at each preflight phase before any commit', async () => {
  const { model, bridge } = setup();
  const ready = deferred();
  const release = deferred();
  const respond = model.respond;
  model.respond = async (id, message) => {
    if (id === 3 && message.type === 'ASB_PREPARE') { ready.resolve(); await release.promise; }
    return respond(id, message);
  };
  const sending = bridge.send(1, [2, 3]);
  await ready.promise;
  assert.equal(model.messages('ASB_STAGE').length, 0);
  assert.equal(model.messages('ASB_COMMIT').length, 0);
  release.resolve();
  const result = await sending;
  assert.equal(result.partial, false);
  assert.equal(result.message, 'Sent to ChatGPT, Claude and Gemini.');
  const messages = model.messages();
  for (const [before, after] of [['ASB_PREPARE', 'ASB_STAGE'], ['ASB_STAGE', 'ASB_VALIDATE'], ['ASB_VALIDATE', 'ASB_COMMIT']]) {
    const earlier = messages.flatMap((call, index) => call.args[1].type === before ? [index] : []);
    const later = messages.flatMap((call, index) => call.args[1].type === after ? [index] : []);
    assert.equal(earlier.length, 3);
    assert.equal(later.length, 3);
    assert.ok(Math.max(...earlier) < Math.min(...later));
  }
  const prepared = model.messages('ASB_PREPARE');
  assert.equal(new Set(prepared.map(call => call.args[1].text)).size, 1);
  assert.equal(new Set(prepared.map(call => call.args[1].requestId)).size, 1);
  assert.deepEqual(prepared.map(call => [call.args[0], call.args[1].source]).sort(), [[1, true], [2, false], [3, false]]);
  assert.equal(model.messages().some(call => call.args[0] === 4), false, 'unchosen chats are never touched');
  assert.ok(messages.every(call => call.args[2].frameId === 0));
});

test('a hidden chat can be the only destination', async () => {
  const { model, bridge } = setup();
  const result = await bridge.send(2, [4]);
  assert.equal(result.message, 'Sent to Claude and Grok.');
  assert.deepEqual(model.messages('ASB_COMMIT').map(call => call.args[0]).sort(), [2, 4]);
});

for (const phase of ['ASB_PREPARE', 'ASB_STAGE', 'ASB_VALIDATE']) {
  test(`${phase} failure cancels every draft and commits nowhere`, async () => {
    const { model, bridge } = setup();
    const respond = model.respond;
    model.respond = (id, message) => id === 3 && message.type === phase
      ? { ok: false, error: 'The composer changed.' } : respond(id, message);
    await assert.rejects(bridge.send(1, [2, 3]), /Nothing was sent.*Gemini: The composer changed/);
    assert.equal(model.messages('ASB_COMMIT').length, 0);
    assert.deepEqual(model.messages('ASB_CANCEL').map(call => call.args[0]).sort(), [1, 2, 3]);
  });
}

test('failed staging waits for the other staging requests to settle before cancelling', async () => {
  const { model, bridge } = setup();
  const reached = deferred();
  const release = deferred();
  const respond = model.respond;
  model.respond = async (id, message) => {
    if (message.type === 'ASB_STAGE') {
      if (id === 1) return { ok: false, error: 'Draft changed' };
      reached.resolve();
      await release.promise;
    }
    return respond(id, message);
  };
  const rejected = assert.rejects(bridge.send(1, [2]), /Nothing was sent/);
  await reached.promise;
  assert.equal(model.messages('ASB_CANCEL').length, 0);
  release.resolve();
  await rejected;
  assert.equal(model.messages('ASB_COMMIT').length, 0);
  assert.equal(model.messages('ASB_CANCEL').length, 2);
});

test('partial commit is reported with delivery uncertainty and is never automatically retried', async () => {
  const { model, bridge } = setup();
  const respond = model.respond;
  model.respond = (id, message) => {
    if (id === 2 && message.type === 'ASB_COMMIT') throw new Error('Channel closed after click');
    return respond(id, message);
  };
  const result = await bridge.send(1, [2, 3]);
  assert.equal(result.partial, true);
  assert.match(result.message, /^Sent to ChatGPT and Gemini\./);
  assert.match(result.message, /Claude:.*Delivery is unconfirmed; check this chat before sending again/);
  assert.deepEqual(model.messages('ASB_COMMIT').map(call => call.args[0]).sort(), [1, 2, 3]);
});

test('attachment copies reach each destination once, at staging, while the source sends its own', async () => {
  const { model, bridge } = setup();
  const file = { name: 'chart.png', type: 'image/png', lastModified: 1, data: 'AAAA' };
  model.respond = (id, message) => message.type === 'ASB_READ_DRAFT' ? { ok: true, text: 'Explain this chart', files: [file], notCopied: [] } : { ok: true };
  const result = await bridge.send(1, [2, 3]);
  assert.deepEqual(result, { ok: true, partial: false, message: 'Sent to ChatGPT, Claude and Gemini.' });
  for (const type of ['ASB_PREPARE', 'ASB_STAGE', 'ASB_VALIDATE']) {
    const calls = model.messages(type);
    assert.equal(calls.some(call => call.args[0] === 1 && ('files' in call.args[1] || 'attachments' in call.args[1])), false, `${type}: the source keeps its own files`);
    for (const call of calls.filter(call => call.args[0] !== 1)) {
      assert.equal(call.args[1].attachments, 1);
      assert.deepEqual(call.args[1].files, type === 'ASB_STAGE' ? [file] : undefined);
    }
  }
});

test('a files-only prompt sends; unreadable attachments stop before any destination is changed', async () => {
  const { model, bridge } = setup();
  const file = { name: 'chart.png', type: 'image/png', data: 'AAAA' };
  model.respond = (id, message) => message.type === 'ASB_READ_DRAFT'
    ? { ok: true, text: '', files: [file], notCopied: [] } : { ok: true };
  const result = await bridge.send(1, [2]);
  assert.equal(result.partial, false);
  assert.equal(result.message, 'Sent to ChatGPT and Claude.');
  assert.equal(model.messages('ASB_STAGE').find(call => call.args[0] === 2).args[1].text, '');

  model.respond = (id, message) => message.type === 'ASB_READ_DRAFT'
    ? { ok: true, text: ' ', files: [], notCopied: ['1 attachment added before the extension could read it'] } : { ok: true };
  await assert.rejects(bridge.send(1, [2]), /Nothing was sent\. 1 attachment added before the extension could read it could not be copied/);
  const before = model.messages('ASB_PREPARE').length;
  model.respond = (id, message) => message.type === 'ASB_READ_DRAFT'
    ? { ok: true, text: 'Compare these PDFs', files: [file], notCopied: ['missing.pdf'] } : { ok: true };
  await assert.rejects(bridge.send(1, [2]), /missing.pdf could not be copied/);
  assert.equal(model.messages('ASB_PREPARE').length, before);
  model.respond = (id, message) => message.type === 'ASB_READ_DRAFT' ? { ok: true, text: '', files: [], notCopied: [] } : { ok: true };
  await assert.rejects(bridge.send(1, [2]), /Write a message/);
});

test('copies a destination could not remove after a failure are pointed out', async () => {
  const { model, bridge } = setup();
  model.respond = (id, message) => {
    if (message.type === 'ASB_READ_DRAFT') return { ok: true, text: 'Look', files: [{ name: 'a.pdf', data: 'AAAA' }], notCopied: [] };
    if (id === 3 && message.type === 'ASB_VALIDATE') return { ok: false, error: 'Send is not ready.' };
    if (message.type === 'ASB_CANCEL') return { ok: true, leftAttachments: id === 2 ? 1 : 0 };
    return { ok: true };
  };
  await assert.rejects(bridge.send(1, [2, 3]), /^Error: Nothing was sent\. Gemini: Send is not ready\. Remove the copied attachments still in Claude\.$/);
  assert.equal(model.messages('ASB_COMMIT').length, 0);
});

test('a destination that closes or falls asleep after staging aborts before any send', async () => {
  for (const change of [tab => { tab.url = 'https://example.com/'; }, tab => { tab.discarded = true; }]) {
    const { model, bridge } = setup();
    const respond = model.respond;
    model.respond = (id, message) => {
      if (id === 3 && message.type === 'ASB_VALIDATE') change(model.data.get(3));
      return respond(id, message);
    };
    await assert.rejects(bridge.send(1, [2, 3]), /Nothing was sent/);
    assert.equal(model.messages('ASB_COMMIT').length, 0);
    assert.deepEqual(model.messages('ASB_CANCEL').map(call => call.args[0]).sort(), [1, 2, 3]);
  }
});

for (const changedId of [1, 2]) {
  test(`recheck aborts if tab ${changedId} begins navigation before commit`, async () => {
    const { model, bridge } = setup();
    const respond = model.respond;
    model.respond = (id, message) => {
      if (id === 2 && message.type === 'ASB_VALIDATE') model.data.get(changedId).pendingUrl = 'https://example.com/';
      return respond(id, message);
    };
    await assert.rejects(bridge.send(1, [2]), /Nothing was sent.*(finish navigating|still loading)/);
    assert.equal(model.messages('ASB_COMMIT').length, 0);
  });
}

test('invalid destinations are refused before any chat is touched', async () => {
  for (const [targets, error] of [[[], /at least one/], [[2, 2], /each chat once/], [[1], /closed or changed/], [[99], /closed or changed/], ['2', /at least one/]]) {
    const { model, bridge } = setup();
    await assert.rejects(bridge.send(1, targets), error);
    assert.equal(model.messages().length, 0);
  }
  for (const property of ['frozen', 'discarded']) {
    const { model, bridge } = setup();
    model.data.get(2)[property] = true;
    await assert.rejects(bridge.send(1, [2]), /wake it/);
    assert.equal(model.messages().length, 0);
  }
});

test('per-window lock excludes competing actions, permits another window, and releases after failure', async () => {
  const { bridge } = setup();
  const entered = deferred();
  const release = deferred();
  const first = bridge.locked(1, async () => { entered.resolve(); await release.promise; throw new Error('First failed'); });
  const rejection = assert.rejects(first, /First failed/);
  await entered.promise;
  let conflictingActionRan = false;
  await assert.rejects(bridge.locked(1, () => { conflictingActionRan = true; }), /Another bridge action/);
  assert.equal(conflictingActionRan, false);
  assert.equal(await bridge.locked(2, () => 'other window'), 'other window');
  release.resolve();
  await rejection;
  assert.equal(await bridge.locked(1, () => 'available again'), 'available again');
});

test('sharing into the visible chat inserts a draft and never sends it', async () => {
  const { model, bridge } = setup();
  const result = await bridge.share(1, { targetId: 2 }, 'Please review this answer.');
  assert.match(result.message, /Draft added to Claude\. Review it/);
  assert.deepEqual(model.messages().map(call => [call.args[0], call.args[1].type]), [[2, 'ASB_INSERT']]);
  assert.equal(model.messages('ASB_INSERT')[0].args[1].text, 'Please review this answer.');
});

test('sharing into a hidden chat opens it on the other side, then waits for the new page before adding the draft', async () => {
  const { model, bridge } = setup({ splitApi: false });
  let inserts = 0;
  model.respond = (id, message) => {
    if (message.type === 'ASB_CAN_LEAVE') return { ok: true, page: 111 };
    if (message.type === 'ASB_INSERT' && ++inserts < 3) return { ok: false, error: 'Gemini is still opening.', retry: true };
    return { ok: true };
  };
  const result = await bridge.share(1, { targetId: 3 }, 'Please review this answer.');
  assert.match(result.message, /Gemini is on the right with the draft ready/);
  assert.equal(model.data.get(2).url, 'https://gemini.google.com/app/hidden');
  const sent = model.messages('ASB_INSERT');
  assert.equal(sent.length, 3);
  assert.ok(sent.every(call => call.args[0] === 2 && call.args[1].provider === 'gemini' && call.args[1].notPage === 111));
  assert.equal(model.messages().some(call => call.args[0] === 3), false, 'the hidden tab itself is left alone');
});

test('sharing stops retrying on a real refusal and reports that the chat opened without the draft', async () => {
  const { model, bridge } = setup({ splitApi: false });
  model.respond = (id, message) => message.type === 'ASB_INSERT'
    ? { ok: false, error: 'Gemini already has a draft.' } : { ok: true };
  await assert.rejects(bridge.share(1, { provider: 'gemini' }, 'Review.'), /already has a draft/);
  assert.equal(model.messages('ASB_INSERT').length, 1);
  model.respond = (id, message) => message.type === 'ASB_INSERT' ? { ok: false, error: 'Still opening.', retry: true } : { ok: true };
  await assert.rejects(bridge.share(1, { targetId: 4 }, 'Review.'), /draft was not added/);
});

test('sharing with send on stages the reply in the visible chat, clicks its Send once, and leaves this chat alone', async () => {
  const { model, bridge } = setup();
  const result = await bridge.share(1, { targetId: 2 }, 'Please review this answer.', { send: true });
  assert.equal(result.message, 'Sent to Claude.');
  assert.deepEqual(model.messages().map(call => [call.args[0], call.args[1].type]),
    [[2, 'ASB_PREPARE'], [2, 'ASB_STAGE'], [2, 'ASB_VALIDATE'], [2, 'ASB_COMMIT'], [2, 'ASB_CANCEL']]);
  const prepared = model.messages('ASB_PREPARE')[0].args[1];
  assert.deepEqual([prepared.text, prepared.source], ['Please review this answer.', false]);
  assert.equal(model.messages('ASB_INSERT').length, 0);
});

for (const phase of ['ASB_PREPARE', 'ASB_STAGE', 'ASB_VALIDATE']) {
  test(`a shared reply that fails at ${phase} is never sent and its staged draft is removed`, async () => {
    const { model, bridge } = setup();
    model.respond = (id, message) => message.type === phase ? { ok: false, error: 'Claude already has a draft.' } : { ok: true };
    await assert.rejects(bridge.share(1, { targetId: 2 }, 'Review.', { send: true }), /^Error: Nothing was sent\. Claude already has a draft\.$/);
    assert.equal(model.messages('ASB_PREPARE').length, 1, 'an open chat is not retried');
    assert.equal(model.messages('ASB_COMMIT').length, 0);
    assert.equal(model.messages('ASB_CANCEL').length, 1);
  });
}

test('a shared reply whose chat navigates before the click is not sent', async () => {
  const { model, bridge } = setup();
  model.respond = (id, message) => {
    if (message.type === 'ASB_VALIDATE') model.data.get(2).pendingUrl = 'https://claude.ai/new';
    return { ok: true };
  };
  await assert.rejects(bridge.share(1, { targetId: 2 }, 'Review.', { send: true }), /Nothing was sent/);
  assert.equal(model.messages('ASB_COMMIT').length, 0);
});

test('a failed click on a shared reply is reported as unconfirmed, never retried', async () => {
  const { model, bridge } = setup();
  model.respond = (id, message) => {
    if (message.type === 'ASB_COMMIT') throw new Error('Channel closed after click');
    return { ok: true };
  };
  await assert.rejects(bridge.share(1, { targetId: 2 }, 'Review.', { send: true }), /Delivery is unconfirmed/);
  assert.equal(model.messages('ASB_COMMIT').length, 1);
});

test('sending to a hidden chat opens it on the other side and waits for the new page before sending', async () => {
  const { model, bridge } = setup({ splitApi: false });
  let prepares = 0;
  model.respond = (id, message) => {
    if (message.type === 'ASB_CAN_LEAVE') return { ok: true, page: 111 };
    if (message.type === 'ASB_PREPARE' && ++prepares < 3) return { ok: false, error: 'Gemini is still opening.', retry: true };
    return { ok: true };
  };
  const result = await bridge.share(1, { targetId: 3 }, 'Please review this answer.', { send: true });
  assert.equal(result.message, 'Sent to Gemini, now on the right.');
  const prepared = model.messages('ASB_PREPARE');
  assert.equal(prepared.length, 3);
  assert.ok(prepared.every(call => call.args[0] === 2 && call.args[1].provider === 'gemini' && call.args[1].notPage === 111));
  assert.deepEqual(model.messages('ASB_COMMIT').map(call => call.args[0]), [2]);
  assert.equal(model.messages().some(call => call.args[0] === 1 && call.args[1].type !== 'ASB_CAN_LEAVE'), false, 'this chat is never sent anything');
});

test('outside Split View a hidden chat receives the draft in its own tab', async () => {
  const { model, bridge } = setup();
  model.data.get(1).splitViewId = model.data.get(2).splitViewId = -1;
  const result = await bridge.share(1, { targetId: 3 }, 'Please review.');
  assert.match(result.message, /Draft added to Gemini in its tab/);
  assert.deepEqual(model.messages().map(call => [call.args[0], call.args[1].type]), [[3, 'ASB_INSERT']]);
  await assert.rejects(bridge.share(1, { provider: 'claude' }, 'Please review.'), /Split View/);
  await assert.rejects(bridge.show(1, { targetId: 3 }), /Split View/);
});

test('show puts the chosen chat on the other side and leaves this chat in place', async () => {
  const { model, bridge } = setup();
  const result = await bridge.show(1, { targetId: 4 });
  assert.match(result.message, /Grok is now on the right/);
  assert.equal(model.data.get(4).splitViewId, model.data.get(1).splitViewId);
  assert.equal(model.data.get(2).splitViewId, -1);
});

test('invalid or oversized text is rejected without touching any composer', async () => {
  for (const text of ['', ' \n ', null, 'x'.repeat(60001)]) {
    const { model, bridge } = setup();
    await assert.rejects(bridge.share(1, { targetId: 2 }, text));
    assert.equal(model.messages().length, 0);
  }
  assert.doesNotThrow(() => validateText('x'.repeat(60000)));
});
