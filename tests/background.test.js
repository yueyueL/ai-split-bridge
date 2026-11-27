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
    "Here is ChatGPT's reply:\n\nReview this.\n\nWhat do you think? Please review it critically. Point out anything wrong, weak, or missing.\n\nIf there are good ideas, use them to improve your previous response. Do not just agree with it—use your own judgement.");
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

test('sharing prompts and conversations labels authors accurately and respects draft mode', async t => {
  const { model, request } = await load(t, chatTabs(), { sync: { settings: { shareMode: 'draft', shareMessage: 'Critique {assistant}’s answer: {reply}' } } });
  const prompt = 'Please explain this example.';
  assert.equal((await request({ type: 'ASB_SHARE', targetId: 2, reply: prompt, kind: 'prompt' })).ok, true);
  assert.equal(model.messages('ASB_INSERT').at(-1).args[1].text,
    `Here is my prompt from a chat with ChatGPT:\n\n${prompt}\n\nPlease respond to this prompt.`);
  const transcript = 'You:\nA question\n\nChatGPT:\nAn answer\n\nYou:\nA follow-up';
  assert.equal((await request({ type: 'ASB_SHARE', targetId: 2, reply: transcript, kind: 'conversation' })).ok, true);
  assert.equal(model.messages('ASB_INSERT').at(-1).args[1].text,
    `Here are selected messages from my conversation with ChatGPT:\n\n${transcript}\n\nPlease continue from this context.`);
  assert.equal(model.messages('ASB_COMMIT').length, 0);
  const count = model.messages().length;
  for (const kind of ['system', 'user', '', null, {}]) {
    const result = await request({ type: 'ASB_SHARE', targetId: 2, reply: 'Text', kind });
    assert.equal(result.ok, false);
    assert.match(result.error, /Choose a prompt, reply, or conversation/);
  }
  assert.equal(model.messages().length, count, 'unsupported kinds never touch a destination');
});

test('conversation shares preserve generated files and the selected delivery mode', async t => {
  const { model, request } = await load(t, chatTabs(), { sync: { settings: { shareMode: 'draft' } } });
  const files = [{ name: 'notes.md', type: 'text/markdown', data: btoa('# Notes') }];
  const result = await request({ type: 'ASB_SHARE', targetId: 2, kind: 'conversation', reply: 'You:\nWrite notes\n\nChatGPT:\nHere are the notes.', files });
  assert.equal(result.ok, true);
  assert.deepEqual(model.messages('ASB_STAGE').at(-1).args[1].files, files);
  assert.match(model.messages('ASB_STAGE').at(-1).args[1].text, /^Here are selected messages from my conversation with ChatGPT:/);
  assert.equal(model.messages('ASB_KEEP').length, 1);
  assert.equal(model.messages('ASB_COMMIT').length, 0);
});

test('custom prompt and conversation instructions from settings reach the chosen chat', async t => {
  const { model, request } = await load(t, chatTabs(), { sync: { settings: {
    shareMode: 'draft', shareMessage: 'Reply only: {reply}',
    promptMessage: 'Explain my question:\n{content}\nUse a short example.',
    conversationMessage: 'Conversation with {assistant}:\n{content}\nCheck the assumptions before continuing.',
  } } });
  const prompt = 'How does this work?';
  assert.equal((await request({ type: 'ASB_SHARE', targetId: 2, kind: 'prompt', reply: prompt })).ok, true);
  assert.equal(model.messages('ASB_INSERT').at(-1).args[1].text, `Explain my question:\n${prompt}\nUse a short example.`);
  const conversation = 'You:\nA question\n\nChatGPT:\nAn answer';
  assert.equal((await request({ type: 'ASB_SHARE', targetId: 2, kind: 'conversation', reply: conversation })).ok, true);
  assert.equal(model.messages('ASB_INSERT').at(-1).args[1].text,
    `Conversation with ChatGPT:\n${conversation}\nCheck the assumptions before continuing.`);
  assert.equal(model.messages('ASB_COMMIT').length, 0, 'custom instructions preserve draft mode');
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

function comparePages(model) {
  return (id, message) => {
    if (message.type === 'ASB_COMPARE_STATUS') return { ok: true, ready: true, turn: `turn-${id}` };
    if (message.type === 'ASB_COMPARE_READ') {
      return { ok: true, url: model.data.get(id).url, turn: `turn-${id}`, text: `Independent answer from pane ${id}.` };
    }
    return { ok: true };
  };
}

test('Compare reads only readiness until chosen, then asks exactly the selected pane using the saved mode', async t => {
  for (const [mode, reviewerId] of [['send', 1], ['draft', 2]]) {
    await t.test(`${mode} in tab ${reviewerId}`, async t => {
      const { model, request } = await load(t, [...chatTabs(), { id: 3, url: 'https://grok.com/c/third' }], { sync: { settings: { shareMode: mode } } });
      model.respond = comparePages(model);
      const status = await request({ type: 'ASB_COMPARE_STATUS', peerId: 2 });
      assert.deepEqual(status, { ok: true, ready: true, turns: ['turn-1', 'turn-2'] });
      assert.deepEqual(model.messages().map(call => call.args[1].type), ['ASB_COMPARE_STATUS', 'ASB_COMPARE_STATUS']);
      const result = await request({ type: 'ASB_COMPARE', peerId: 2, peerProvider: 'claude', targetId: reviewerId, turns: status.turns, expectedMode: mode, send: mode !== 'send' });
      assert.equal(result.ok, true, result.error);
      const stages = model.messages('ASB_STAGE');
      assert.equal(stages.length, 1);
      assert.equal(!!model.messages('ASB_PREPARE')[0].args[1].draftOnly, mode === 'draft');
      const [id, staged] = stages[0].args;
      assert.equal(id, reviewerId);
      assert.equal(staged.source, false);
      assert.equal(staged.attachments, 0);
      assert.equal('files' in staged, false);
      assert.match(staged.text, /independent judgment/i);
      for (const element of ['agreements', 'disagreements', 'missing considerations', 'verification', 'Agreement is not proof']) assert.ok(staged.text.includes(element));
      assert.match(staged.text, /ChatGPT \(left pane\)\nIndependent answer from pane 1\.\n\nClaude \(right pane\)\nIndependent answer from pane 2\.$/);
      assert.deepEqual(model.messages('ASB_COMPARE_CHECK').map(call => call.args[0]), [1, 2]);
      assert.deepEqual(model.messages('ASB_COMMIT').map(call => call.args[0]), mode === 'send' ? [reviewerId] : []);
      assert.deepEqual(model.messages('ASB_KEEP').map(call => call.args[0]), mode === 'draft' ? [reviewerId] : []);
      assert.ok(model.messages().every(call => call.args[0] !== 3));
    });
  }
});

test('Compare uses the saved comparison template for sending and drafting from the right pane', async t => {
  const { model, request, sender } = await load(t, chatTabs().reverse());
  model.respond = comparePages(model);
  const choice = { type: 'ASB_COMPARE', peerId: 2, targetId: 2, turns: ['turn-1', 'turn-2'] };
  const answers = 'Claude (left pane)\nIndependent answer from pane 2.\n\nChatGPT (right pane)\nIndependent answer from pane 1.';
  const cases = [
    { mode: 'draft', template: '检查两份答案。\n\n{answers}\n\n列出证据。', expected: `检查两份答案。\n\n${answers}\n\n列出证据。` },
    { mode: 'send', template: 'Which assumption matters most?', expected: `Which assumption matters most?\n\n${answers}` },
  ];
  for (const { mode, template, expected } of cases) {
    model.synced.settings = { comparisonMessage: template, shareMode: mode, shareMessage: 'Only for a shared reply.' };
    const result = await request({ ...choice, expectedMode: mode, comparisonMessage: 'Injected by the page.' }, sender);
    assert.equal(result.ok, true, result.error);
    const { args: [id, payload] } = model.messages('ASB_STAGE').at(-1);
    assert.equal(id, choice.targetId);
    assert.equal(payload.text, expected);
    assert.equal(model.messages('ASB_COMMIT').length, mode === 'send' ? 1 : 0);
  }
  assert.deepEqual(model.messages('ASB_KEEP').map(call => call.args[0]), [2]);
});

test('Compare declines a missing answer, oversized prompt, changed pane, or changed answer before sending', async t => {
  for (const scenario of ['unanswered', 'oversize', 'unsplit', 'different reviewer', 'chooser stale', 'answer changed', 'pane navigated']) {
    await t.test(scenario, async t => {
      const { model, request } = await load(t, chatTabs());
      const respond = comparePages(model);
      if (scenario === 'unsplit') model.data.get(2).splitViewId = -1;
      model.respond = (id, message) => {
        if (id === 2 && message.type === 'ASB_COMPARE_STATUS' && scenario === 'unanswered') return { ok: true, ready: false, message: 'Wait for Claude to finish.' };
        if (id === 2 && message.type === 'ASB_COMPARE_READ') {
          if (scenario === 'unanswered') return { ok: false, error: 'Wait for Claude to finish.' };
          if (scenario === 'oversize') return { ...respond(id, message), text: 'a'.repeat(59500) };
        }
        if (id === 1 && message.type === 'ASB_COMPARE_CHECK' && scenario === 'answer changed') return { ok: false, error: 'The answer changed.' };
        if (message.type === 'ASB_VALIDATE' && scenario === 'pane navigated') model.data.get(1).url += '-new';
        return respond(id, message);
      };
      if (scenario === 'unanswered') {
        const status = await request({ type: 'ASB_COMPARE_STATUS', peerId: 2 });
        assert.deepEqual(status, { ok: true, ready: false, message: 'Wait for Claude to finish.' });
      }
      const result = await request({ type: 'ASB_COMPARE', peerId: 2, expectedMode: 'send',
        targetId: scenario === 'different reviewer' ? 3 : 2,
        turns: [scenario === 'chooser stale' ? 'old' : 'turn-1', 'turn-2'] });
      assert.equal(result.ok, false, scenario);
      assert.equal(model.messages('ASB_COMMIT').length, 0);
      assert.equal(model.messages('ASB_KEEP').length, 0);
      const staged = ['answer changed', 'pane navigated'].includes(scenario);
      assert.equal(model.messages('ASB_STAGE').length, staged ? 1 : 0);
      assert.equal(model.messages('ASB_CANCEL').length, staged ? 1 : 0);
    });
  }
});

test('Compare refuses to submit when a draft was promised and sharing settings changed after the chooser opened', async t => {
  const { model, request } = await load(t, chatTabs(), { sync: { settings: { shareMode: 'draft' } } });
  model.respond = comparePages(model);
  const { shareMode } = await request({ type: 'ASB_CONTEXT' });
  const { turns } = await request({ type: 'ASB_COMPARE_STATUS', peerId: 2 });
  model.synced.settings.shareMode = 'send';
  const reply = await request({ type: 'ASB_COMPARE', peerId: 2, targetId: 2, turns, expectedMode: shareMode });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /settings changed.*Open Compare again/);
  assert.deepEqual(model.messages().map(call => call.args[1].type), ['ASB_COMPARE_STATUS', 'ASB_COMPARE_STATUS']);
});

const crossChoice = { type: 'ASB_CROSS_REVIEW', peerId: 2, turns: ['turn-1', 'turn-2'], expectedMode: 'send', action: 'critique' };
const revisionChoice = { type: 'ASB_REVISE', peerId: 2, turns: ['turn-1', 'turn-2'], expectedMode: 'send', targetId: 1, reviewId: 'round-one' };

function reviewPages(model) {
  const base = comparePages(model);
  return (id, message) => {
    if (message.type !== 'ASB_REVIEW_RESULT') return base(id, message);
    assert.equal(message.peerId, id === 1 ? 2 : 1);
    const metadata = { ok: true, ready: true, reviewId: 'round-one', turn: `turn-${id}` };
    return message.read ? { ...metadata, text: `Critique from ${id} about ${3 - id}.`, original: `Original answer from ${id}.`, url: model.data.get(id).url } : metadata;
  };
}

test('cross-review status returns only metadata from a matched round; drafts, missing replies and mismatched rounds cannot be revised', async t => {
  const { model, request } = await load(t, chatTabs());
  const base = reviewPages(model);
  for (const situation of ['matched', 'pending', 'different round', 'older critique', 'no receipt', 'unanswered']) {
    model.respond = (id, m) => {
      const value = base(id, m);
      if (id === 2 && m.type === 'ASB_COMPARE_STATUS' && situation === 'unanswered') return { ok: true, ready: false, message: 'Still writing.' };
      if (id !== 2 || m.type !== 'ASB_REVIEW_RESULT') return value;
      if (situation === 'pending') return { ok: true, ready: false, pending: true, message: 'Send the draft in Claude.' };
      if (situation === 'different round') return { ...value, reviewId: 'different' };
      if (situation === 'older critique') return { ...value, turn: 'older' };
      if (situation === 'no receipt') return { ok: true, ready: false };
      return value;
    };
    const result = await request({ type: 'ASB_REVIEW_STATUS', peerId: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.ready, !['unanswered', 'pending'].includes(situation));
    if (situation === 'pending') assert.match(result.message, /Send the draft/);
    if (situation === 'matched') assert.deepEqual(result.revision, { reviewId: 'round-one', turns: crossChoice.turns });
    else assert.equal(result.revision, undefined);
  }
  assert.ok(model.messages().every(call => ['ASB_COMPARE_STATUS', 'ASB_REVIEW_RESULT'].includes(call.args[1].type)));
  assert.ok(model.messages('ASB_REVIEW_RESULT').every(call => call.args[1].read === false));
});

test('each review action sends the opposite original exactly once per selected pane, including when started on the right', async t => {
  const { model, request } = await load(t, [...chatTabs().reverse(), { id: 3, url: 'https://grok.com/c/unused' }]);
  model.respond = reviewPages(model);
  for (const [action, expected, mode] of [['critique', 'Critique the answer', 'send'], ['errors', 'calculation errors', 'draft'], ['improvements', 'concrete improvements', 'send']]) {
    model.synced.settings = { shareMode: mode };
    model.calls.length = 0;
    const result = await request({ ...crossChoice, action, expectedMode: mode });
    assert.ok(result.ok, result.error);
    assert.equal(result.partial, false);
    const prepares = model.messages('ASB_PREPARE');
    assert.equal(prepares.length, 2);
    assert.equal(new Set(prepares.map(call => call.args[1].review.reviewId)).size, 1);
    for (const { args: [id, payload] } of prepares) {
      assert.equal(payload.answer.turn, `turn-${id}`);
      assert.equal(payload.review.peerId, 3 - id);
      assert.equal(payload.attachments, 0);
      assert.equal(payload.source, false);
      assert.ok(payload.text.includes(expected));
      assert.equal(payload.text.slice(payload.review.quotedStart), `Answer from ${id === 1 ? 'Claude (left pane)' : 'ChatGPT (right pane)'}\nIndependent answer from pane ${3 - id}.`);
      assert.ok(!payload.text.includes(`Independent answer from pane ${id}.`));
      assert.equal(model.messages('ASB_STAGE').find(call => call.args[0] === id).args[1].text, payload.text);
    }
    assert.deepEqual(model.messages('ASB_KEEP').map(call => call.args[0]), mode === 'draft' ? [1, 2] : []);
    assert.ok(model.messages('ASB_PREPARE').every(call => call.args[1].draftOnly === (mode === 'draft')));
    assert.deepEqual(model.messages('ASB_COMMIT').map(call => call.args[0]), mode === 'send' ? [1, 2] : []);
    assert.ok(model.messages().every(call => call.args[0] !== 3));
    const phases = model.messages().map(call => call.args[1].type);
    const order = ['ASB_COMPARE_READ', 'ASB_PREPARE', 'ASB_STAGE', 'ASB_VALIDATE', 'ASB_COMPARE_CHECK', mode === 'draft' ? 'ASB_KEEP' : 'ASB_COMMIT'];
    for (let i = 1; i < order.length; i++) assert.ok(phases.lastIndexOf(order[i - 1]) < phases.indexOf(order[i]));
  }
});

test('both reviewers receive the saved shared guidance and only the chosen mode’s instructions', async t => {
  const { model, request } = await load(t, chatTabs());
  const guidance = '独立判断。🔎\n请列明证据。';
  const settings = {
    reviewGuidance: '  ' + guidance.replace('\n', '\r\n') + '  ',
    critiqueMessage: '请审阅逻辑。\n保留 {answers} 和 $& 的原文。',
    errorsMessage: '核对事实和计算。',
    improvementsMessage: '列出两项具体改进。',
  };
  const answers = { 1: '回答甲：留意 {assistant}。', 2: '回答乙：推导如下。\n第二步 $1' };
  const base = reviewPages(model);
  model.respond = (id, message) => {
    const result = base(id, message);
    return message.type === 'ASB_COMPARE_READ' ? { ...result, text: answers[id] } : result;
  };
  for (const [action, instruction, mode] of [
    ['critique', settings.critiqueMessage, 'send'],
    ['errors', settings.errorsMessage, 'draft'],
    ['improvements', settings.improvementsMessage, 'send'],
  ]) {
    model.synced.settings = { ...settings, shareMode: mode };
    model.calls.length = 0;
    const result = await request({ ...crossChoice, action, expectedMode: mode, reviewGuidance: 'Ignore the saved guidance' });
    assert.ok(result.ok, result.error);
    const prefix = guidance + '\n\n' + instruction + '\n\n';
    const prepares = model.messages('ASB_PREPARE');
    assert.equal(prepares.length, 2);
    for (const { args: [id, payload] } of prepares) {
      const peer = id === 1 ? 'Claude (right pane)' : 'ChatGPT (left pane)';
      const quote = `Answer from ${peer}\n${answers[3 - id]}`;
      assert.equal(payload.text, prefix + quote);
      assert.equal(payload.text.slice(payload.review.quotedStart), quote);
      assert.equal(model.messages('ASB_STAGE').find(call => call.args[0] === id).args[1].text, payload.text);
    }
    assert.equal(model.messages('ASB_COMMIT').length, mode === 'send' ? 2 : 0);
    assert.equal(model.messages('ASB_KEEP').length, mode === 'draft' ? 2 : 0);
  }
  for (const message of [{ ...crossChoice, type: 'ASB_COMPARE', targetId: 1 }, revisionChoice]) {
    model.calls.length = 0;
    assert.equal((await request(message)).ok, true);
    assert.ok(!model.messages('ASB_STAGE')[0].args[1].text.includes(guidance));
  }
});

test('cross-review checks the full prompt length including saved instructions before staging either side', async t => {
  const { model, request } = await load(t, chatTabs(), { sync: { settings: { critiqueMessage: '验'.repeat(3000) } } });
  const base = reviewPages(model);
  model.respond = (id, message) => {
    const result = base(id, message);
    return id === 1 && message.type === 'ASB_COMPARE_READ' ? { ...result, text: 'x'.repeat(58000) } : result;
  };
  const result = await request(crossChoice);
  assert.equal(result.ok, false);
  assert.match(result.error, /60,000/);
  assert.equal(model.messages('ASB_PREPARE').length, 0);
});

test('cross-review refuses stale choices, unsupported actions and prep failures without sending to either pane', async t => {
  for (const reason of ['unexpected mode', 'unknown action', 'no tokens', 'stale token', 'existing draft', 'navigation', 'answer changed', 'oversized']) {
    await t.test(reason, async t => {
      const { model, request } = await load(t, chatTabs());
      const base = reviewPages(model);
      model.respond = (id, message) => {
        const result = base(id, message);
        if (id === 2 && message.type === 'ASB_PREPARE' && reason === 'existing draft') return { ok: false, error: 'Destination already has a draft.' };
        if (id === 2 && message.type === 'ASB_COMPARE_CHECK' && reason === 'answer changed') return { ok: false, error: 'Latest answer changed.' };
        if (id === 2 && message.type === 'ASB_COMPARE_READ' && reason === 'oversized') return { ...result, text: 'a'.repeat(59999) };
        if (id === 2 && message.type === 'ASB_STAGE' && reason === 'navigation') model.data.get(id).url += '/elsewhere';
        return result;
      };
      const msg = { ...crossChoice };
      if (reason === 'unexpected mode') msg.expectedMode = 'draft';
      if (reason === 'unknown action') msg.action = '__proto__';
      if (reason === 'no tokens') delete msg.turns;
      if (reason === 'stale token') msg.turns = ['old', 'turn-2'];
      const result = await request(msg);
      assert.equal(result.ok, false);
      assert.equal(model.messages('ASB_COMMIT').length + model.messages('ASB_KEEP').length, 0);
      if (['existing draft', 'navigation', 'answer changed'].includes(reason)) {
        assert.deepEqual(model.messages('ASB_CANCEL').map(call => call.args[0]), [1, 2]);
      } else assert.equal(model.messages('ASB_PREPARE').length, 0);
    });
  }
});

test('partial cross-review submission identifies affected panes and does not retry the click', async t => {
  const { model, request } = await load(t, chatTabs());
  const base = reviewPages(model);
  model.respond = (id, m) => id === 2 && m.type === 'ASB_COMMIT' ? { ok: false, error: 'Lost connection.' } : base(id, m);
  const result = await request(crossChoice);
  assert.equal(result.partial, true);
  assert.match(result.message, /Sent to ChatGPT \(left pane\).*Claude \(right pane\).*unconfirmed/);
  assert.deepEqual(model.messages('ASB_COMMIT').map(call => call.args[0]), [1, 2]);
});

test('revision uses the chosen original and the critique addressed to it from the same round', async t => {
  const { model, request } = await load(t, chatTabs());
  model.respond = reviewPages(model);
  for (const [targetId, mode] of [[1, 'send'], [2, 'draft']]) {
    model.calls.length = 0;
    model.synced.settings = { shareMode: mode };
    const result = await request({ ...revisionChoice, targetId, expectedMode: mode });
    assert.ok(result.ok, result.error);
    assert.equal(model.messages('ASB_STAGE').length, 1);
    const { args: [id, draft] } = model.messages('ASB_STAGE')[0];
    assert.equal(id, targetId);
    assert.ok(draft.text.includes(`Original answer from ${id}.`));
    assert.ok(draft.text.includes(`Critique from ${3 - id} about ${id}.`));
    assert.ok(!draft.text.includes(`Critique from ${id} about ${3 - id}.`));
    assert.ok(!draft.text.includes(`Original answer from ${3 - id}.`));
    assert.deepEqual(model.messages('ASB_COMPARE_CHECK').map(call => call.args[0]), [1, 2]);
    assert.deepEqual(model.messages('ASB_COMMIT').map(call => call.args[0]), mode === 'send' ? [targetId] : []);
    assert.deepEqual(model.messages('ASB_KEEP').map(call => call.args[0]), mode === 'draft' ? [targetId] : []);
    assert.ok(model.messages('ASB_REVIEW_RESULT').every(call => call.args[1].read && call.args[1].reviewId === 'round-one'));
  }
});

test('revision refuses mixed rounds, unrelated new replies, navigation and changed critiques', async t => {
  for (const reason of ['other round', 'untracked', 'different turn', 'new page', 'changed at submit', 'oversize']) {
    await t.test(reason, async t => {
      const { model, request } = await load(t, chatTabs());
      const base = reviewPages(model);
      model.respond = (id, m) => {
        const result = base(id, m);
        if (id === 2 && m.type === 'ASB_COMPARE_CHECK' && reason === 'changed at submit') return { ok: false, error: 'Critique changed.' };
        if (id !== 2 || m.type !== 'ASB_REVIEW_RESULT') return result;
        if (reason === 'untracked') return { ok: true, ready: false };
        if (reason === 'other round') return { ...result, reviewId: 'other' };
        if (reason === 'different turn') return { ...result, turn: 'unrelated-reply' };
        if (reason === 'new page') return { ...result, url: model.data.get(id).url + '/another' };
        if (reason === 'oversize') return { ...result, text: 'x'.repeat(60000) };
        return result;
      };
      const result = await request(revisionChoice);
      assert.equal(result.ok, false);
      assert.equal(model.messages('ASB_STAGE').length, reason === 'changed at submit' ? 1 : 0);
      assert.equal(model.messages('ASB_COMMIT').length, 0);
    });
  }
});

// ---------- Interface language ----------
test('with Chinese saved, shared text, review prompts and results are all written in Chinese', async t => {
  const { model, request } = await load(t, chatTabs(), { sync: { language: 'zh-CN' } });
  model.respond = (_id, message) => message.type === 'ASB_READ_DRAFT' ? { ok: true, text: 'Hello' } : { ok: true };
  const shared = await request({ type: 'ASB_SHARE', targetId: 2, reply: 'Review this.' });
  assert.deepEqual([shared.ok, shared.message], [true, '已发送到 Claude。']);
  assert.match(model.messages('ASB_PREPARE').at(-1).args[1].text, /^下面是 ChatGPT 的回复：\n\nReview this\.\n\n你怎么看？/);
  const refused = await request({ type: 'ASB_SHARE', targetId: 2, reply: '  ' });
  assert.deepEqual([refused.ok, refused.error], [false, '所选内容没有可分享的文字或文件。']);
  const popup = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
  assert.equal((await request({ type: 'ASB_OPEN', provider: 'grok' }, popup)).message, 'Grok 已在新标签页中打开。如有需要请先登录。');

  model.respond = reviewPages(model);
  model.calls.length = 0;
  const review = await request(crossChoice);
  assert.equal(review.message, '互评已发送到两个聊天。每份点评会出现在各自的窗格中。');
  for (const { args: [id, payload] } of model.messages('ASB_PREPARE')) {
    assert.match(payload.text, /^请就事论事地点评下面的回答。/);
    assert.equal(payload.text.slice(payload.review.quotedStart), `${id === 1 ? 'Claude（右侧窗格）' : 'ChatGPT（左侧窗格）'}的回答\nIndependent answer from pane ${3 - id}.`);
  }

  model.calls.length = 0;
  const revised = await request(revisionChoice);
  assert.equal(revised.message, '已请 ChatGPT 修订回答。');
  const draft = model.messages('ASB_STAGE')[0].args[1].text;
  assert.match(draft, /^请根据下面的点评修订你原来的回答。/);
  assert.ok(draft.includes('你原来的回答（ChatGPT，左侧窗格）\nOriginal answer from 1.'));
  assert.ok(draft.includes('Claude（右侧窗格）对你的回答的点评\nCritique from 2 about 1.'));

  model.respond = comparePages(model);
  model.calls.length = 0;
  const compared = await request({ type: 'ASB_COMPARE', peerId: 2, targetId: 2, turns: ['turn-1', 'turn-2'], expectedMode: 'send' });
  assert.equal(compared.message, '对比已发送到 Claude。');
  const comparison = model.messages('ASB_STAGE')[0].args[1].text;
  assert.match(comparison, /^请运用你自己的独立判断，对比下面两个回答。/);
  assert.ok(comparison.endsWith('ChatGPT（左侧窗格）\nIndependent answer from pane 1.\n\nClaude（右侧窗格）\nIndependent answer from pane 2.'));
  const stale = await request({ type: 'ASB_COMPARE', peerId: 2, targetId: 2, turns: ['turn-1', 'turn-2'], expectedMode: 'draft' });
  assert.equal(stale.error, '分享设置已变化。请重新打开“对比”以确认发送方式。');
});

test('a later request with nothing saved is answered in English again', async t => {
  const { model, request } = await load(t, chatTabs());
  model.respond = () => ({ ok: true });
  const shared = await request({ type: 'ASB_SHARE', targetId: 2, reply: 'Review this.' });
  assert.deepEqual([shared.ok, shared.message], [true, 'Sent to Claude.']);
});

// ---------- Opening an assistant from the popup's Split View form ----------
const popupSender = { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' };
const urls = model => model.order().map(id => model.data.get(id).url);

test('Create split opens an assistant that is not open yet beside the chosen chat', async t => {
  const { model, request } = await load(t, [{ id: 1, url: 'https://chatgpt.com/c/one' }, { id: 2 }]);
  const result = await request({ type: 'ASB_PAIR', leftId: 1, rightProvider: 'gemini' }, popupSender);
  assert.deepEqual([result.ok, result.message], [true, 'Split View ready.']);
  assert.deepEqual(urls(model), ['https://chatgpt.com/c/one', 'https://gemini.google.com/app', 'https://example.com/']);
  const opened = model.data.get(3);
  assert.ok(opened.splitViewId >= 0);
  assert.equal(opened.splitViewId, model.data.get(1).splitViewId);
  assert.equal(model.data.get(1).active, true);
  assert.equal(model.calls.find(call => call.method === 'create').args[0].active, false, 'the new chat opens in the background');
});

test('a new chat chosen for the left joins the open chat without moving it', async t => {
  const { model, request } = await load(t, [{ id: 2 }, { id: 1, url: 'https://claude.ai/chat/two' }, { id: 3 }]);
  const result = await request({ type: 'ASB_PAIR', leftProvider: 'gemini', rightId: 1 }, popupSender);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(model.order(), [2, 4, 1, 3]);
  assert.equal(model.data.get(4).splitViewId, model.data.get(1).splitViewId);
  assert.deepEqual(model.calls.filter(call => call.method === 'move').map(call => call.args[0]), [4], 'only the new tab is moved');
  assert.equal(model.data.get(4).active, true);
});

test('two new chats can be opened side by side when no AI chat is open', async t => {
  const { model, request } = await load(t, [{ id: 1 }]);
  const list = await request({ type: 'ASB_LIST' }, popupSender);
  assert.deepEqual([list.tabs, list.canManageSplit], [[], true]);
  const result = await request({ type: 'ASB_PAIR', leftProvider: 'claude', rightProvider: 'gemini' }, popupSender);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(urls(model), ['https://example.com/', 'https://claude.ai/new', 'https://gemini.google.com/app']);
  assert.ok(model.data.get(2).splitViewId >= 0);
  assert.equal(model.data.get(2).splitViewId, model.data.get(3).splitViewId);
});

test('a new chat takes the pinned state and tab group of the chat it joins', async t => {
  for (const state of [{ groupId: 7 }, { pinned: true }]) {
    const { model, request } = await load(t, [{ id: 1, url: 'https://chatgpt.com/c/one', ...state }, { id: 2 }]);
    const result = await request({ type: 'ASB_PAIR', leftId: 1, rightProvider: 'grok' }, popupSender);
    assert.equal(result.ok, true, result.error);
    const opened = model.data.get(3);
    assert.deepEqual([opened.groupId, opened.pinned], [state.groupId ?? -1, state.pinned ?? false]);
    assert.equal(opened.splitViewId, model.data.get(1).splitViewId);
  }
});

test('the split is made only after the new chat has finished loading', async t => {
  const { model, request } = await load(t, [{ id: 1, url: 'https://chatgpt.com/c/one' }]);
  let reads = 0;
  model.before = (method, args) => {
    if (method === 'createSplit') assert.equal(model.data.get(2).pendingUrl, undefined, 'the split waits for the page');
    if (method !== 'get' || args[0] !== 2) return;
    const tab = model.data.get(2);
    if (++reads === 1) { tab.url = ''; tab.pendingUrl = 'https://gemini.google.com/app'; }
    else { tab.url = 'https://gemini.google.com/app'; delete tab.pendingUrl; }
  };
  const result = await request({ type: 'ASB_PAIR', leftId: 1, rightProvider: 'gemini' }, popupSender);
  assert.equal(result.ok, true, result.error);
  assert.ok(reads >= 2);
  assert.equal(model.data.get(2).splitViewId, model.data.get(1).splitViewId);
});

test('a split that cannot be made is refused before any new tab is opened', async t => {
  const { model, request, sender } = await load(t, [...chatTabs(), { id: 3 }]);
  const refused = await request({ type: 'ASB_PAIR', leftId: 1, rightProvider: 'gemini' }, popupSender);
  assert.deepEqual([refused.ok, refused.error], [false, 'Remove the chosen tabs from their existing splits first.']);
  for (const [message, from] of [
    [{ leftId: 3, rightProvider: 'gemini' }, popupSender],
    [{ leftId: 1, rightProvider: 'perplexity' }, popupSender],
    [{ leftProvider: 'claude', rightProvider: 'constructor' }, popupSender],
    [{ leftId: 99, rightProvider: 'gemini' }, popupSender],
    [{ leftProvider: 'claude' }, popupSender],
    [{ leftProvider: 'claude', rightProvider: 'gemini' }, sender],
  ]) assert.equal((await request({ type: 'ASB_PAIR', ...message }, from)).ok, false, JSON.stringify(message));
  assert.equal(model.calls.some(call => call.method === 'create'), false);

  const old = await load(t, [{ id: 1, url: 'https://chatgpt.com/c/one' }], { splitApi: false });
  const unsupported = await old.request({ type: 'ASB_PAIR', leftId: 1, rightProvider: 'gemini' }, popupSender);
  assert.match(unsupported.error, /Split View option/);
  assert.equal(old.model.calls.some(call => call.method === 'create'), false);
});

// ---------- Remembering the last pair of assistants ----------
const pairLast = { type: 'ASB_PAIR_LAST' };
const made = (model, method) => model.calls.filter(call => call.method === method);

test('a split made from the popup is remembered by its two assistants, left and right', async t => {
  const { model, request } = await load(t, [{ id: 1, url: 'https://chatgpt.com/c/one' }, { id: 2 }]);
  assert.equal((await request({ type: 'ASB_LIST' }, popupSender)).lastPair, null);
  const refused = await request({ type: 'ASB_PAIR', leftId: 2, rightProvider: 'gemini' }, popupSender);
  assert.equal(refused.ok, false);
  assert.equal(model.synced.lastPair, undefined, 'a refused split is not remembered');

  const result = await request({ type: 'ASB_PAIR', leftProvider: 'gemini', rightId: 1 }, popupSender);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(model.synced.lastPair, { left: 'gemini', right: 'chatgpt' });
  assert.deepEqual((await request({ type: 'ASB_LIST' }, popupSender)).lastPair, { left: 'gemini', right: 'chatgpt' });
});

test('the remembered pair reuses open chats that are not in a split, in the remembered order', async t => {
  const { model, request } = await load(t, [
    { id: 1 }, { id: 2, url: 'https://gemini.google.com/app/g1' }, { id: 3, url: 'https://claude.ai/chat/c1' },
  ], { sync: { lastPair: { left: 'claude', right: 'gemini' } } });
  const result = await request(pairLast, popupSender);
  assert.deepEqual([result.ok, result.message], [true, 'Split View ready.']);
  assert.equal(made(model, 'create').length, 0, 'both assistants were already open');
  assert.deepEqual(model.order(), [1, 3, 2]);
  assert.ok(model.data.get(3).splitViewId >= 0);
  assert.equal(model.data.get(3).splitViewId, model.data.get(2).splitViewId);
  assert.equal(model.data.get(3).active, true);
});

test('the remembered pair opens whichever assistant is missing, or both', async t => {
  const one = await load(t, [{ id: 1 }, { id: 2, url: 'https://gemini.google.com/app/g1' }, { id: 4 }], { sync: { lastPair: { left: 'claude', right: 'gemini' } } });
  assert.equal((await one.request(pairLast, popupSender)).ok, true);
  assert.deepEqual(made(one.model, 'create').map(call => call.args[0].url), ['https://claude.ai/new']);
  assert.deepEqual(urls(one.model), ['https://example.com/', 'https://claude.ai/new', 'https://gemini.google.com/app/g1', 'https://example.com/']);
  assert.deepEqual(made(one.model, 'move').map(call => call.args[0]), [5], 'the open chat keeps its place');
  assert.equal(one.model.data.get(5).splitViewId, one.model.data.get(2).splitViewId);

  const none = await load(t, [{ id: 1 }], { sync: { lastPair: { left: 'claude', right: 'gemini' } } });
  assert.equal((await none.request(pairLast, popupSender)).ok, true);
  assert.deepEqual(urls(none.model), ['https://example.com/', 'https://claude.ai/new', 'https://gemini.google.com/app']);
  assert.equal(none.model.data.get(2).splitViewId, none.model.data.get(3).splitViewId);
});

test('the same assistant on both sides uses two different chats', async t => {
  const { model, request } = await load(t, [{ id: 1, url: 'https://claude.ai/chat/c1' }, { id: 2 }], { sync: { lastPair: { left: 'claude', right: 'claude' } } });
  assert.equal((await request(pairLast, popupSender)).ok, true);
  assert.deepEqual(made(model, 'create').map(call => call.args[0].url), ['https://claude.ai/new']);
  assert.equal(model.data.get(1).splitViewId, model.data.get(3).splitViewId);
  assert.deepEqual(model.order(), [1, 3, 2]);
});

test('chats already side by side are left as they are, and chats in other splits are not taken', async t => {
  for (const lastPair of [{ left: 'chatgpt', right: 'claude' }, { left: 'claude', right: 'chatgpt' }]) {
    const { model, request } = await load(t, chatTabs(), { sync: { lastPair } });
    const result = await request(pairLast, popupSender);
    assert.deepEqual([result.ok, result.message], [true, 'These chats are already side by side.']);
    assert.equal(model.calls.some(call => ['create', 'move', 'createSplit', 'unsplit'].includes(call.method)), false);
  }
  const { model, request } = await load(t, [{ id: 5, active: true }, ...chatTabs().map(tab => ({ ...tab, active: false }))], { sync: { lastPair: { left: 'chatgpt', right: 'claude' } } });
  assert.equal((await request(pairLast, popupSender)).ok, true);
  assert.equal(made(model, 'create').length, 2, 'the existing split is not broken up');
  assert.deepEqual([model.data.get(1).splitViewId, model.data.get(2).splitViewId], [10, 10]);
});

test('an open chat in another tab group stays there; a new one joins the first chat’s group', async t => {
  const { model, request } = await load(t, [
    { id: 1, url: 'https://gemini.google.com/app/g1', groupId: 7 }, { id: 2, url: 'https://claude.ai/chat/c1' },
  ], { sync: { lastPair: { left: 'gemini', right: 'claude' } } });
  assert.equal((await request(pairLast, popupSender)).ok, true);
  assert.deepEqual([model.data.get(2).groupId, model.data.get(2).splitViewId], [-1, -1]);
  const opened = model.data.get(3);
  assert.deepEqual([opened.url, opened.groupId], ['https://claude.ai/new', 7]);
  assert.equal(opened.splitViewId, model.data.get(1).splitViewId);
});

test('with no usable pair remembered there is nothing to open', async t => {
  for (const sync of [{}, { lastPair: { left: 'perplexity', right: 'claude' } }, { lastPair: 'claude+gemini' }, { lastPair: { left: 'claude' } }]) {
    const { model, request, sender } = await load(t, [{ id: 1, url: 'https://chatgpt.com/c/one' }], { sync });
    assert.equal((await request({ type: 'ASB_LIST' }, popupSender)).lastPair, null);
    const refused = await request(pairLast, popupSender);
    assert.deepEqual([refused.ok, refused.error], [false, 'Create a split from this popup once first. It then remembers that pair.']);
    assert.equal((await request(pairLast, sender)).ok, false, 'a chat page cannot ask for it');
    assert.equal(made(model, 'create').length, 0);
  }
  const chinese = await load(t, [{ id: 1 }], { sync: { language: 'zh-CN' } });
  assert.equal((await chinese.request(pairLast, popupSender)).error, '请先在这个弹窗里创建一次分屏，之后它会记住那个组合。');
});
