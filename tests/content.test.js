import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { translations } from './translations.js';

const source = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const page = `<main>
  <article class="reply"><p>First answer.</p><div class="actions"><span class="copy"><button>Copy</button></span><button>Like</button></div></article>
  <article class="reply"><p>Second answer.</p><div class="actions"><span class="copy"><button>Copy</button></span><button>Like</button></div></article>
</main>
<form><textarea id="site-composer"></textarea><div id="group"><button type="button" id="site-voice">Voice</button><button type="button" id="site-send">Send</button></div></form>`;

function split() {
  return {
    ok: true, selfId: 1, provider: 'chatgpt', side: 'left', native: true, shareMode: 'send', canManageSplit: false, switchMode: 'navigate',
    actions: [
      { id: 'review-reply', kind: 'reply', title: 'Review reply', isDefault: true, builtin: true },
      { id: 'handoff', kind: 'reply', title: 'Share as context', isDefault: false, builtin: true },
      { id: 'respond', kind: 'prompt', title: 'Answer prompt', isDefault: true, builtin: true },
      { id: 'critique', kind: 'review', title: 'Critique', isDefault: true, builtin: true },
      { id: 'errors', kind: 'review', title: 'Find errors', isDefault: false, builtin: true },
      { id: 'improvements', kind: 'review', title: 'Suggest improvements', isDefault: false, builtin: true },
    ],
    peer: { id: 2, provider: 'claude', name: 'Claude', title: 'Chat two', side: 'right' },
    chats: [
      { id: 2, provider: 'claude', name: 'Claude', title: 'Chat two', side: 'right' },
      { id: 3, provider: 'gemini', name: 'Gemini', title: 'Trip ideas', side: null },
      { id: 4, provider: 'grok', name: 'Grok', title: 'Grok', side: null, asleep: true },
    ],
    closed: [],
  };
}

function setup(t, context = split()) {
  const dom = new JSDOM(page, { url: 'https://chatgpt.com/c/example', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const calls = [];
  let listener;
  const model = {
    context,
    compareStatus: { ok: true, ready: true, turns: ['local-turn', 'peer-turn'] },
    reviewStatus: { ok: true, ready: true, turns: ['local-turn', 'peer-turn'] },
    respond(message) {
      if (message.type === 'ASB_CONTEXT') return this.context;
      if (message.type === 'ASB_COMPARE_STATUS') return this.compareStatus;
      if (message.type === 'ASB_REVIEW_STATUS') return this.reviewStatus;
      return { ok: true, message: 'Done.' };
    },
  };
  const adapter = {
    provider: 'chatgpt', name: 'ChatGPT',
    getDraft() {
      if (!document.querySelector('#site-composer')) throw new Error('ChatGPT composer was not found.');
      return { ok: true, text: document.querySelector('#site-composer').value };
    },
    composerAnchor: () => document.querySelector('#group') && { parent: document.querySelector('#group'), before: document.querySelector('#site-send') },
    replyAnchors: () => [...document.querySelectorAll('.reply')].map(response => ({ parent: response.querySelector('.actions'), before: response.querySelector('.copy').nextElementSibling, response })),
    replyText: response => ({ ok: true, text: response.querySelector('p').textContent, partial: false }),
    getResponse: () => adapter.replyText([...document.querySelectorAll('.reply')].at(-1)),
    ownsEditor: node => node === document.querySelector('#site-composer'),
    canLeave: () => ({ ok: true, page: 1 }),
  };
  dom.window.AISplitAdapters = adapter;
  dom.window.chrome = { runtime: { id: 'extension', onMessage: { addListener(fn) { listener = fn; } }, async sendMessage(message) { calls.push(JSON.parse(JSON.stringify(message))); return model.respond(message); } } };
  dom.window.eval(translations);
  dom.window.eval(source);
  const hosts = kind => [...document.querySelectorAll(`ai-split-bridge[data-ai-split-bridge='${kind}']`)];
  const layer = hosts('layer')[0].shadowRoot;
  const composer = () => hosts('composer')[0];
  const pill = () => composer().shadowRoot;
  const menu = layer.querySelector('[role=menu]');
  const toast = layer.querySelector('[role=status]');
  const rows = () => [...menu.querySelectorAll('.item, button.row')];
  const row = name => rows().find(node => node.querySelector('.name')?.textContent === name);
  const sent = type => calls.filter(message => message.type === type);
  const refresh = () => new Promise(resolve => listener({ type: 'ASB_REFRESH' }, { id: 'extension' }, resolve));
  const click = async node => { node.click(); await settle(); };
  const option = name => [...menu.querySelectorAll('.share-destination option')].find(item => item.textContent.startsWith(name + ' ·'));
  const choose = name => {
    const selected = option(name);
    selected.parentElement.value = selected.value;
    selected.parentElement.dispatchEvent(new dom.window.Event('change'));
  };
  const action = id => menu.querySelector(`[data-action-id="${id}"]`);
  return { dom, document, model, adapter, option, choose, action, calls, hosts, composer, pill, menu, toast, row, sent, refresh, click, get listener() { return listener; } };
}

test('a Send both pill sits just before the site’s own Send button and leaves the site’s send alone', async t => {
  const view = setup(t);
  await settle();
  const site = view.document.querySelector('#site-send');
  assert.equal(view.composer().nextSibling, site);
  assert.equal(view.composer().style.display, 'inline-flex');
  assert.equal(view.pill().querySelector('.send').textContent, 'Send both');
  assert.match(view.pill().querySelector('.send').title, /Send here and to Claude/);
  site.click();
  view.document.querySelector('#site-composer').dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.deepEqual(view.calls.map(message => message.type), ['ASB_CONTEXT']);
  const press = new view.dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true });
  view.pill().querySelector('.send').dispatchEvent(press);
  assert.equal(press.defaultPrevented, true, 'the site composer keeps its caret');
  await view.click(view.pill().querySelector('.send'));
  assert.deepEqual(view.sent('ASB_SEND'), [{ type: 'ASB_SEND', targetIds: [2] }]);
  assert.equal(view.toast.textContent, 'Done.');
  view.dom.window.eval(source);
  assert.equal(view.hosts('composer').length, 1);
  assert.equal(view.hosts('layer').length, 1);
});

test('the chooser adds chats from other tabs, skips sleeping ones, and labels the pill to match', async t => {
  const view = setup(t);
  await settle();
  await view.click(view.pill().querySelector('.more'));
  assert.equal(view.menu.hidden, false);
  assert.equal(view.menu.querySelector('.heading').textContent, 'Send this prompt to');
  const check = name => view.row(name).querySelector('[role=menuitemcheckbox]');
  assert.deepEqual(['Claude', 'Gemini', 'Grok'].map(name => check(name).getAttribute('aria-checked')), ['true', 'false', 'false']);
  assert.equal(view.row('Claude').querySelector('.detail').textContent, 'Right side · Chat two');
  assert.equal(view.row('Gemini').querySelector('.detail').textContent, 'Other tab · Trip ideas');
  assert.equal(check('Grok').disabled, true);
  assert.equal(view.row('Grok').querySelector('.detail').textContent, 'Asleep · open its tab first');
  await view.click(check('Gemini'));
  assert.equal(view.pill().querySelector('.send').textContent, 'Send all');
  assert.equal(view.menu.querySelector('.primary').textContent, 'Send all');
  await view.click(view.menu.querySelector('.primary'));
  assert.deepEqual(view.sent('ASB_SEND').map(message => message.targetIds), [[2, 3]]);
  assert.equal(view.menu.hidden, true);
  assert.equal(view.pill().querySelector('.send').textContent, 'Send all', 'choices survive a refresh');
  await view.click(view.pill().querySelector('.more'));
  await view.click(check('Claude'));
  assert.equal(view.pill().querySelector('.send').textContent, 'Send both');
  await view.click(check('Gemini'));
  assert.equal(view.pill().querySelector('.send').textContent, 'Send to…');
  assert.equal(view.menu.querySelector('.primary').disabled, true);
  await view.click(view.pill().querySelector('.more'));
  assert.equal(view.menu.hidden, true);
  await view.click(view.pill().querySelector('.send'));
  assert.equal(view.menu.hidden, false, 'with nothing chosen the pill opens the chooser instead of sending');
  assert.equal(view.sent('ASB_SEND').length, 1);
});

test('hidden and closed chats can be shown on the other side; outside a split there is nothing to show', async t => {
  const context = split();
  context.closed = [{ provider: 'grok', name: 'Grok', remembered: true }];
  context.chats = context.chats.filter(chat => chat.provider !== 'grok');
  const view = setup(t, context);
  await settle();
  await view.click(view.pill().querySelector('.more'));
  assert.equal(view.row('Claude').querySelector('.show'), null, 'the visible side needs no Show button');
  assert.equal(view.row('Gemini').querySelector('.show').getAttribute('aria-label'), 'Show Gemini on the right');
  assert.equal(view.row('Grok').querySelector('.detail').textContent, 'Earlier chat');
  await view.click(view.row('Gemini').querySelector('.show'));
  assert.deepEqual(view.sent('ASB_SHOW'), [{ type: 'ASB_SHOW', targetId: 3 }]);
  await view.click(view.pill().querySelector('.more'));
  await view.click(view.row('Grok').querySelector('.show'));
  assert.deepEqual(view.sent('ASB_SHOW').at(-1), { type: 'ASB_SHOW', provider: 'grok' });

  view.model.context = { ...split(), side: null, peer: null, chats: split().chats.map(chat => ({ ...chat, side: null })), closed: context.closed };
  await view.refresh();
  assert.equal(view.pill().querySelector('.send').textContent, 'Send to…');
  await view.click(view.pill().querySelector('.more'));
  assert.equal(view.menu.querySelectorAll('.show').length, 0);
  assert.equal(view.row('Grok').querySelector('.detail').textContent, 'Asleep · open its tab first');
});

const directReply = { type: 'ASB_SHARE', targetId: 2, peerId: 2, peerProvider: 'claude', expectedMode: 'send',
  page: 'https://chatgpt.com/c/example', actionId: 'review-reply' };

test('each reply gets a Share button after its Copy button that hands the reply to the chosen chat', async t => {
  const view = setup(t);
  await settle();
  const shares = view.hosts('share');
  assert.equal(shares.length, 2);
  assert.deepEqual(shares.map(node => node.previousSibling.className), ['copy', 'copy']);
  await view.click(shares[0].shadowRoot.querySelector('.share-options'));
  assert.equal(view.menu.querySelector('.heading').textContent, 'Send this reply to');
  assert.match(view.menu.querySelector('.hint').textContent, /^Sent right away/);
  assert.equal(view.option('Claude').textContent, 'Claude · Right side · Chat two');
  assert.equal(view.option('Gemini').textContent, 'Gemini · Opens on the right · Trip ideas');
  assert.equal(view.option('Grok').textContent, 'Grok · Opens on the right');
  assert.equal(view.option('Grok').disabled, false, 'a sleeping hidden tab is opened, not skipped');
  view.choose('Gemini');
  await view.click(view.action('review-reply'));
  assert.deepEqual(view.sent('ASB_SHARE'), [{ type: 'ASB_SHARE', targetId: 3, actionId: 'review-reply', expectedMode: 'send', reply: 'First answer.', instructionIds: [] }],
    'the page sends only the reply; the extension adds your message');
  assert.equal(view.calls.some(message => ['ASB_SEND', 'ASB_COMMIT'].includes(message.type)), false);
  view.model.context = { ...split(), shareMode: 'draft' };
  await view.refresh();
  await view.click(shares[1].shadowRoot.querySelector('.share-options'));
  assert.equal(view.menu.querySelector('.heading').textContent, 'Share this reply with');
  assert.match(view.menu.querySelector('.hint').textContent, /^Added as a draft/);
  view.model.context = split();
  view.document.querySelectorAll('.reply')[0].remove();
  await view.refresh();
  assert.equal(view.hosts('share').length, 1);
  view.model.context = { ...split(), chats: [], closed: [] };
  await view.refresh();
  assert.equal(view.hosts('share')[0].style.display, 'none');
  assert.equal(view.pill().querySelector('.send').textContent, 'Summarize…');
});

test('primary Share sends one selected reply to the visible peer, including its recognized files', async t => {
  const view = setup(t);
  await settle();
  const primary = view.hosts('share')[0].shadowRoot.querySelector('.share-primary');
  const descriptors = [{ name: 'notes.md' }];
  const files = [{ name: 'notes.md', data: 'bm90ZXM=' }];
  const downloaded = [];
  view.adapter.readReply = async () => ({ text: 'First answer.', files: descriptors });
  view.adapter.readReplyFiles = async items => {
    downloaded.push(items);
    return files;
  };
  assert.equal(primary.textContent, 'Share to Claude');
  primary.click();
  primary.click();
  await settle();
  const direct = { type: 'ASB_SHARE', targetId: 2, peerId: 2, peerProvider: 'claude',
    expectedMode: 'send', page: view.dom.window.location.href };
  assert.deepEqual(view.sent('ASB_SHARE'), [{ ...direct, reply: 'First answer.', files }]);
  assert.deepEqual(downloaded, [descriptors]);
  assert.equal(view.menu.hidden, true);

  view.model.context = { ...split(), shareMode: 'draft' };
  await view.refresh();
  assert.equal(primary.textContent, 'Draft for Claude');
  view.adapter.readReply = async () => ({ text: 'highlight', partial: true, files: descriptors });
  await view.click(primary);
  assert.deepEqual(view.sent('ASB_SHARE')[1], { ...direct, expectedMode: 'draft', reply: 'highlight' });
  assert.equal(downloaded.length, 1, 'an excerpt excludes the files from the whole reply');
});

test('primary Share checks that the same peer and mode still apply', async t => {
  const view = setup(t);
  await settle();
  const primary = view.hosts('share')[0].shadowRoot.querySelector('.share-primary');
  view.model.context = { ...split(), shareMode: 'draft' };
  await view.click(primary);
  assert.equal(view.sent('ASB_SHARE').length, 0);
  assert.equal(primary.textContent, 'Draft for Claude');
  view.model.context = { ...view.model.context, peer: { ...split().chats[1], side: 'right' } };
  await view.click(primary);
  assert.equal(view.sent('ASB_SHARE').length, 0);
  assert.equal(primary.textContent, 'Draft for Gemini');
  assert.match(view.toast.textContent, /changed/);
});

test('when there is no ready native peer, primary Share opens the chooser', async t => {
  const view = setup(t);
  await settle();
  const host = view.hosts('share')[0].shadowRoot;
  for (const context of [
    { ...split(), peer: null, side: null, native: false, chats: split().chats.map(chat => ({ ...chat, side: null })) },
    { ...split(), peer: { ...split().peer, loading: true } },
  ]) {
    view.model.context = context;
    await view.refresh();
    const primary = host.querySelector('.share-primary');
    assert.equal(primary.textContent, 'Share with…');
    assert.equal(host.querySelector('.share-options').hidden, true);
    await view.click(primary);
    assert.ok(view.option('Gemini'));
    assert.equal(view.action('review-reply').disabled, true);
    assert.equal(view.sent('ASB_SHARE').length, 0);
    await view.click(primary);
  }
});

test('a menu that fits on neither side opens on the roomier side and scrolls instead of covering its button', async t => {
  const view = setup(t);
  await settle();
  Object.defineProperty(view.dom.window, 'innerHeight', { value: 440, configurable: true });
  Object.defineProperty(view.menu, 'offsetHeight', { get: () => 255, configurable: true });
  const share = view.hosts('share')[0].shadowRoot.querySelector('.share-options');
  share.getBoundingClientRect = () => ({ top: 162, bottom: 194, left: 60, right: 160 });
  await view.click(share);
  assert.equal(view.menu.style.top, '202px');
  assert.equal(view.menu.style.maxHeight, '230px');
  await view.click(share);
  const more = view.pill().querySelector('.more');
  more.getBoundingClientRect = () => ({ top: 330, bottom: 362, left: 60, right: 92 });
  await view.click(more);
  assert.equal(view.menu.style.top, '67px', 'the send menu still prefers to open above the composer');
  assert.equal(view.menu.style.maxHeight, '');
});

test('without Copy buttons the chooser can still share the latest reply', async t => {
  const view = setup(t);
  view.adapter.replyAnchors = () => [];
  await view.refresh();
  await view.click(view.pill().querySelector('.more'));
  await view.click([...view.menu.querySelectorAll('.link')].find(link => link.textContent === 'Share this chat’s latest reply…'));
  assert.equal(view.menu.querySelector('.heading').textContent, 'Send this reply to');
  await view.click(view.action('review-reply'));
  assert.equal(view.sent('ASB_SHARE')[0].reply, 'Second answer.');
  assert.equal(view.sent('ASB_SHARE')[0].targetId, 2);
});

test('Gemini keeps Share latest in its composer menu even if only an older toolbar is present', async t => {
  const view = setup(t);
  view.adapter.provider = 'gemini';
  view.adapter.name = 'Gemini';
  const anchors = view.adapter.replyAnchors;
  view.adapter.replyAnchors = () => anchors().slice(0, 1);
  await view.refresh();
  assert.equal(view.hosts('share').length, 1);
  await view.click(view.pill().querySelector('.more'));
  const latest = [...view.menu.querySelectorAll('button')].find(node => node.textContent === 'Share this chat’s latest reply…');
  await view.click(latest);
  await view.click(view.action('review-reply'));
  assert.deepEqual(view.sent('ASB_SHARE'), [{ ...directReply, reply: 'Second answer.', instructionIds: [] }]);
});

test('Compare beside the latest reply lets either split side review only after an explicit choice', async t => {
  const view = setup(t);
  const compare = () => view.hosts('share').at(-1).shadowRoot.querySelector('.compare');
  await settle();
  assert.equal(view.hosts('share')[0].shadowRoot.querySelector('.compare'), null);
  assert.equal(view.sent('ASB_COMPARE_STATUS').length, 0, 'ordinary chatting makes no readiness requests');
  for (const [name, id, mode] of [['Claude', 2, 'draft'], ['ChatGPT', 1, 'send']]) {
    view.model.context.shareMode = mode;
    await view.click(compare());
    assert.deepEqual(view.sent('ASB_COMPARE_STATUS').at(-1), { type: 'ASB_COMPARE_STATUS', peerId: 2 });
    assert.match(view.menu.textContent, /ChatGPTLeft side/);
    assert.match(view.menu.textContent, /ClaudeRight side/);
    assert.equal(view.row('Gemini'), undefined, 'a hidden tab cannot be chosen as reviewer');
    assert.match(view.menu.querySelector('.hint').textContent, mode === 'draft' ? /editable.*prompt/ : /sends both answers/);
    assert.equal(view.sent('ASB_COMPARE').length, mode === 'draft' ? 0 : 1);
    await view.click(view.row(name));
    assert.deepEqual(view.sent('ASB_COMPARE').at(-1), {
      type: 'ASB_COMPARE', targetId: id, peerId: 2, peerProvider: 'claude', turns: ['local-turn', 'peer-turn'], expectedMode: mode,
    });
  }
});

test('Compare explains waiting and unpaired states, and can recheck without sending', async t => {
  const view = setup(t);
  view.adapter.replyAnchors = () => [];
  await view.refresh();
  await view.click(view.pill().querySelector('.more'));
  view.model.compareStatus = { ok: true, ready: false, message: 'Claude is still responding.' };
  await view.click(view.menu.querySelector('.compare'));
  assert.match(view.menu.textContent, /Claude is still responding/);
  assert.equal(view.menu.querySelector('button.row'), null);
  view.model.compareStatus = { ok: true, ready: false, message: 'ChatGPT has no completed answer yet.' };
  await view.click(view.menu.querySelector('.link'));
  assert.match(view.menu.textContent, /no completed answer/);
  view.model.compareStatus = { ok: true, ready: true, turns: ['answer1', 'answer2'] };
  await view.click(view.menu.querySelector('.link'));
  assert.ok(view.row('Claude'));
  await view.click(view.pill().querySelector('.more'));
  view.model.context = { ...split(), native: false, side: null, peer: null };
  await view.click(view.pill().querySelector('.more'));
  await view.click(view.menu.querySelector('.compare'));
  assert.match(view.menu.textContent, /Open two AI chats in Chrome Split View/);
  assert.equal(view.sent('ASB_COMPARE_STATUS').length, 3);
  assert.equal(view.sent('ASB_COMPARE').length, 0);
});

test('changing a split side or conversation leaves an open comparison unsubmitted', async t => {
  const view = setup(t);
  await settle();
  const compare = view.hosts('share').at(-1).shadowRoot.querySelector('.compare');
  await view.click(compare);
  view.model.context = { ...split(), peer: { ...split().peer, provider: 'gemini', name: 'Gemini' } };
  await view.click(view.row('Claude'));
  assert.match(view.toast.textContent, /changed.*Open Compare/);
  view.model.context = split();
  await view.click(compare);
  view.dom.window.history.pushState({}, '', '/c/different');
  await view.click(view.row('ChatGPT'));
  assert.match(view.toast.textContent, /changed.*Open Compare/);
  assert.equal(view.sent('ASB_COMPARE').length, 0);
});

test('Cross-review offers all three review actions and submits only the selected workflow', async t => {
  const view = setup(t);
  await settle();
  assert.equal(view.hosts('share')[0].shadowRoot.querySelector('.cross-review'), null);
  assert.equal(view.sent('ASB_REVIEW_STATUS').length, 0);
  for (const [label, action, mode] of [
    ['Critique', 'critique', 'send'], ['Find errors', 'errors', 'draft'], ['Suggest improvements', 'improvements', 'send'],
  ]) {
    view.model.context.shareMode = mode;
    const count = view.sent('ASB_CROSS_REVIEW').length;
    await view.click(view.hosts('share').at(-1).shadowRoot.querySelector('.review-options'));
    assert.deepEqual(view.sent('ASB_REVIEW_STATUS').at(-1), { type: 'ASB_REVIEW_STATUS', peerId: 2 });
    assert.equal(view.sent('ASB_CROSS_REVIEW').length, count, 'opening the menu transfers nothing');
    assert.match(view.menu.querySelector('.hint').textContent, mode === 'send' ? /Each assistant receives the selected action/ : /draft in each chat/);
    assert.equal(view.row('Claude'), undefined, 'revision is unavailable before the two critiques arrive');
    await view.click(view.row(label));
    assert.equal(view.menu.hidden, true);
    assert.deepEqual(view.sent('ASB_CROSS_REVIEW').at(-1), {
      type: 'ASB_CROSS_REVIEW', peerId: 2, peerProvider: 'claude', expectedMode: mode,
      turns: ['local-turn', 'peer-turn'], actionId: action, instructionIds: [],
    });
  }
  assert.equal(view.sent('ASB_REVISE').length, 0);
});

test('both matching critiques unlock a revision in the chosen split pane', async t => {
  const view = setup(t);
  view.adapter.replyAnchors = () => [];
  view.model.reviewStatus = { ok: true, ready: false, message: 'Waiting for the other critique.' };
  await view.refresh();
  await view.click(view.pill().querySelector('.more'));
  await view.click(view.menu.querySelector('.cross-review'));
  assert.match(view.menu.textContent, /Waiting for the other critique/);
  assert.ok(view.action('errors').disabled);
  const revision = { reviewId: 'session-1', turns: ['critique1', 'critique2'] };
  view.model.reviewStatus = { ok: true, ready: true, turns: ['latest1', 'latest2'], revision };
  await view.click(view.menu.querySelector('.link'));
  assert.equal(view.menu.querySelector('.heading').textContent, 'Revise an answer');
  assert.deepEqual([...view.menu.querySelectorAll('.row .name')].map(node => node.textContent), ['ChatGPT', 'Claude']);
  assert.equal(view.sent('ASB_REVISE').length, 0);
  // Switch to a repeat review deliberately; opening the menu never starts a round.
  await view.click(view.menu.querySelector('.link'));
  assert.ok(view.row('Critique'));
  assert.equal(view.sent('ASB_CROSS_REVIEW').length, 0);
  await view.click(view.pill().querySelector('.more'));

  for (const [name, targetId, mode] of [['ChatGPT', 1, 'send'], ['Claude', 2, 'draft']]) {
    view.model.context.shareMode = mode;
    await view.click(view.pill().querySelector('.more'));
    await view.click(view.menu.querySelector('.cross-review'));
    assert.match(view.menu.querySelector('.hint').textContent, mode === 'send' ? /revise its original answer/ : /draft a revision request/);
    await view.click(view.row(name));
    assert.deepEqual(view.sent('ASB_REVISE').at(-1), {
      type: 'ASB_REVISE', reviewId: revision.reviewId, turns: revision.turns,
      peerId: 2, peerProvider: 'claude', targetId, expectedMode: mode,
    });
  }
});

test('the primary Cross-review button requests one mutual critique in one click', async t => {
  const view = setup(t, { ...split(), shareMode: 'draft' });
  await settle();
  const primary = view.hosts('share').at(-1).shadowRoot.querySelector('.cross-review');
  assert.match(primary.title, /Draft the review request in both chats/);
  let finish;
  const respond = view.model.respond.bind(view.model);
  view.model.respond = msg => msg.type === 'ASB_CROSS_REVIEW' ? new Promise(resolve => { finish = resolve; }) : respond(msg);
  await view.click(primary);
  assert.equal(primary.disabled, true);
  await view.click(primary);
  assert.deepEqual(view.sent('ASB_CROSS_REVIEW'), [{
    type: 'ASB_CROSS_REVIEW', turns: ['local-turn', 'peer-turn'],
    peerId: 2, peerProvider: 'claude', expectedMode: 'draft',
  }]);
  finish({ ok: true, message: 'Drafts ready.' }); await settle();
  assert.equal(primary.disabled, false);
  view.model.reviewStatus.revision = { reviewId: 'completed-review', turns: ['c1', 'c2'] };
  await view.click(primary);
  assert.equal(view.menu.querySelector('.heading').textContent, 'Revise an answer');
  assert.equal(view.sent('ASB_REVISE').length, 0);
  assert.equal(view.sent('ASB_CROSS_REVIEW').length, 1);
});

test('a quick critique checks changed draft settings and pending answers before submission', async t => {
  const view = setup(t, { ...split(), shareMode: 'draft' });
  await settle();
  const primary = view.hosts('share').at(-1).shadowRoot.querySelector('.cross-review');
  view.model.context = { ...split(), shareMode: 'send' };
  await view.click(primary);
  assert.ok(view.row('Critique'), 'a mode change between paint and click needs a fresh choice');
  assert.equal(view.sent('ASB_CROSS_REVIEW').length, 0);
  await view.click(primary);
  view.model.reviewStatus = { ok: true, ready: false, message: 'Claude is still writing.' };
  await view.click(primary);
  assert.match(view.menu.textContent, /Claude is still writing/);
  assert.equal(view.sent('ASB_CROSS_REVIEW').length, 0);
});

test('reply controls use their own line in a narrow pane and move back when widened', async t => {
  const view = setup(t);
  await settle();
  const host = view.hosts('share').at(-1);
  const bar = host.parentElement;
  for (const width of [390, 1000]) {
    view.dom.window.innerWidth = width;
    view.dom.window.dispatchEvent(new view.dom.window.Event('resize'));
    await settle();
    assert.equal(host.parentElement, width === 390 ? bar.closest('article') : bar);
    assert.ok(host.shadowRoot.querySelector('.cross-review'));
    assert.equal(view.hosts('share').length, 2);
  }
});

test('changed split, mode or conversation prevents stale cross-review and revision choices', async t => {
  const view = setup(t);
  await settle();
  const trigger = view.hosts('share').at(-1).shadowRoot.querySelector('.review-options');
  await view.click(trigger);
  view.model.context = { ...split(), peer: { ...split().peer, id: 5 } };
  await view.click(view.row('Find errors'));
  assert.match(view.toast.textContent, /changed.*Open Cross-review/);
  assert.equal(view.sent('ASB_CROSS_REVIEW').length, 0);
  view.model.context = { ...split(), shareMode: 'draft' };
  view.model.reviewStatus.revision = { reviewId: 'r', turns: ['c1', 'c2'] };
  await view.click(trigger);
  view.model.context.shareMode = 'send';
  await view.click(view.row('Claude'));
  assert.match(view.toast.textContent, /changed.*Open Cross-review/);
  await view.click(trigger);
  view.dom.window.history.pushState({}, '', '/c/different');
  await view.click(view.row('ChatGPT'));
  assert.equal(view.sent('ASB_REVISE').length, 0);
  view.model.context = { ...split(), native: false, peer: null, side: null };
  await view.click(view.pill().querySelector('.more'));
  const calls = view.sent('ASB_REVIEW_STATUS').length;
  await view.click(view.menu.querySelector('.cross-review'));
  assert.match(view.menu.textContent, /Open two AI chats in Chrome Split View/);
  assert.equal(view.sent('ASB_REVIEW_STATUS').length, calls);
});

test('the shortcut sends from the site composer only, and pending work blocks a second send', async t => {
  const view = setup(t);
  await settle();
  let finish;
  view.model.respond = function (message) { return message.type === 'ASB_CONTEXT' ? this.context : new Promise(resolve => { finish = resolve; }); };
  const press = target => {
    const event = new view.dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, ctrlKey: true, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  assert.equal(press(view.document.querySelector('#site-voice')).defaultPrevented, false);
  assert.equal(press(view.document.querySelector('#site-composer')).defaultPrevented, true);
  await settle();
  assert.equal(view.pill().querySelector('.send').textContent, 'Working…');
  assert.equal(view.pill().querySelector('.send').disabled, true);
  press(view.document.querySelector('#site-composer'));
  await view.click(view.pill().querySelector('.send'));
  assert.equal(view.sent('ASB_SEND').length, 1);
  finish({ ok: false, error: 'Claude still has a draft.' });
  await settle();
  assert.equal(view.toast.textContent, 'Claude still has a draft.');
  assert.equal(view.toast.classList.contains('error'), true);
  assert.equal(view.pill().querySelector('.send').disabled, false);
});

test('without an anchor the pill floats over a composer, and disappears when there is no composer', async t => {
  const view = setup(t);
  view.adapter.composerAnchor = () => null;
  await view.refresh();
  assert.equal(view.composer().parentNode, view.document.documentElement);
  assert.match(view.composer().style.cssText, /position: fixed/);
  view.document.querySelector('form').remove();
  await view.refresh();
  assert.equal(view.composer(), undefined);
});

test('only explicit extension-owned adapter requests are accepted', async t => {
  const view = setup(t);
  await settle();
  for (const [type, id] of [['ASB_COMMIT', 'other'], ['toString', 'extension'], ['constructor', 'extension']]) {
    assert.equal(view.listener({ type }, { id }, () => assert.fail()), false);
  }
  const result = await new Promise(resolve => view.listener({ type: 'ASB_CAN_LEAVE' }, { id: 'extension' }, resolve));
  assert.equal(result.ok, true);
  view.adapter.insert = () => { throw Object.assign(new Error('Claude is still opening.'), { retry: true }); };
  const failure = await new Promise(resolve => view.listener({ type: 'ASB_INSERT', text: 'x' }, { id: 'extension' }, resolve));
  assert.deepEqual({ ...failure }, { ok: false, error: 'Claude is still opening.', retry: true });
});

function conversation(view) {
  const replies = [...view.document.querySelectorAll('.reply')];
  const prompt = view.document.createElement('article');
  prompt.innerHTML = '<p>My original question.</p><div class="actions"><span class="copy"><button>Copy prompt</button></span><button>Edit</button></div>';
  replies[0].before(prompt);
  const entries = [
    { element: prompt, role: 'user', text: 'My original question.' },
    ...replies.map(element => ({ element, role: 'assistant', text: element.querySelector('p').textContent })),
  ];
  const reads = [];
  view.adapter.messages = () => entries;
  view.adapter.readMessages = async elements => {
    reads.push(elements);
    return { ok: true, text: elements.map(element => {
      const entry = entries.find(item => item.element === element);
      return `${entry.role === 'user' ? 'You' : 'ChatGPT'}: ${entry.text}`;
    }).join('\n\n'), partial: false, conversation: true };
  };
  view.adapter.promptAnchors = () => prompt.isConnected ? [{ parent: prompt.querySelector('.actions'), before: prompt.querySelector('.copy').nextElementSibling, response: prompt }] : [];
  view.adapter.readMessage = async element => ({ ok: true, text: element.querySelector('p').textContent, partial: false, prompt: true });
  return { entries, reads, prompt };
}

test('historical prompts have a share action that preserves their role', async t => {
  const view = setup(t);
  const chat = conversation(view);
  await view.refresh();
  const host = view.hosts('share').find(node => node.dataset.shareRole === 'user');
  assert.equal(host.previousSibling.className, 'copy');
  await view.click(host.shadowRoot.querySelector('.share-options'));
  assert.equal(view.menu.querySelector('.heading').textContent, 'Send this prompt to');
  await view.click(view.action('respond'));
  assert.deepEqual(view.sent('ASB_SHARE'), [{...directReply,actionId:'respond',reply:'My original question.',kind:'prompt',instructionIds:[]}]);
  assert.equal(view.sent('ASB_SEND').length,0);
  chat.prompt.remove();await view.refresh();
  assert.equal(view.hosts('share').filter(node=>node.dataset.shareRole==='user').length,0);
});

test('the prompt share menu accepts a matching original for an unavailable upload or shares text only', async t => {
  const view = setup(t);
  conversation(view);
  const descriptor = { name: 'plan.pdf', nameKnown: true, promptAttachment: true, kind: 'unavailable' };
  view.adapter.readMessage = async () => ({ prompt: true, text: 'Review this.', files: [descriptor] });
  const picked = [];
  view.adapter.readReplyFiles = async ([item]) => {
    if (!item.pickedFile) throw new Error('Original unavailable.');
    picked.push(item);
    return [{ name: item.pickedFile.name, type: 'application/pdf', data: 'YWJj' }];
  };
  await view.refresh();
  const host = view.hosts('share').find(node => node.dataset.shareRole === 'user').shadowRoot;
  await view.click(host.querySelector('.share-primary'));
  assert.equal(view.sent('ASB_SHARE').length, 0);
  await view.click(host.querySelector('.share-options'));
  const input = view.menu.querySelector('.prompt-originals input');
  const pick = name => {
    const file = new view.dom.window.File(['abc'], name);
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
    return file;
  };
  pick('another.pdf');
  assert.match(view.menu.querySelector('.prompt-originals [role=status]').textContent, /Choose the file named plan.pdf/);
  const original = pick('plan.pdf');
  await view.click(view.action('respond'));
  assert.equal(picked[0].pickedFile, original);
  assert.equal(picked[0].kind, 'local-prompt');
  assert.equal(view.sent('ASB_SHARE')[0].files[0].data, 'YWJj');
  await view.click(host.querySelector('.share-options'));
  await view.click(view.menu.querySelector('.file-option input'));
  await view.click(view.action('respond'));
  assert.equal(view.sent('ASB_SHARE')[1].files, undefined);
  assert.equal(picked.length, 1);
});

test('selected prompts and replies are read in conversation order and shared as one conversation', async t => {
  const view = setup(t);
  const chat = conversation(view);
  await view.refresh();
  await view.click(view.pill().querySelector('.more'));
  await view.click(view.menu.querySelector('.select-messages'));
  const checks = [...view.menu.querySelectorAll('.message-choice input')];
  assert.equal(checks.length,3);
  assert.equal(view.menu.querySelector('.primary').disabled,true);
  assert.equal(chat.reads.length,0);
  // Click out of order; the transcript must still retain the conversation's order.
  await view.click(checks[2]);await view.click(checks[0]);
  assert.equal(view.menu.querySelector('.primary').textContent,'Share 2 messages…');
  await view.click(view.menu.querySelector('.primary'));
  assert.deepEqual([...chat.reads[0]],[chat.entries[0].element,chat.entries[2].element]);
  assert.equal(view.menu.querySelector('.heading').textContent,'Send the selected messages to');
  assert.equal(view.sent('ASB_SHARE').length,0,'choosing messages does not send');
  await view.click(view.row('Gemini'));
  assert.deepEqual(view.sent('ASB_SHARE'),[{type:'ASB_SHARE',targetId:3,reply:'You: My original question.\n\nChatGPT: Second answer.',kind:'conversation'}]);
});

test('select all, clear, and back never transfer messages', async t => {
  const view=setup(t);conversation(view);await view.refresh();
  await view.click(view.pill().querySelector('.more'));await view.click(view.menu.querySelector('.select-messages'));
  const actions=[...view.menu.querySelectorAll('.selection-actions button')];
  await view.click(actions[0]);assert.equal(view.menu.querySelectorAll('.message-choice input:checked').length,3);
  await view.click(actions[1]);assert.equal(view.menu.querySelectorAll('.message-choice input:checked').length,0);
  assert.equal(view.menu.querySelector('.primary').disabled,true);
  await view.click(view.menu.querySelector('.footer .link'));
  assert.equal(view.menu.querySelector('.heading').textContent,'Send this prompt to');
  assert.equal(view.sent('ASB_SHARE').length,0);
});

test('changing conversations invalidates message selection before any read or send', async t => {
  const view=setup(t);const chat=conversation(view);await view.refresh();
  await view.click(view.pill().querySelector('.more'));await view.click(view.menu.querySelector('.select-messages'));
  await view.click(view.menu.querySelector('.message-choice input'));
  view.dom.window.history.pushState({},'', '/c/another');
  await view.click(view.menu.querySelector('.primary'));
  assert.equal(chat.reads.length,0);assert.equal(view.sent('ASB_SHARE').length,0);
  assert.match(view.toast.textContent,/conversation changed/);
});

test('a message selection with generated files uses the existing file controls', async t => {
  const view=setup(t);conversation(view);await view.refresh();
  let fileReads=0;
  view.adapter.readMessages=async()=>({ok:true,text:'You: question\nChatGPT: document',files:[{name:'draft.md'}],partial:false,conversation:true});
  view.adapter.readReplyFiles=async()=>{fileReads++;return [{name:'draft.md',data:'dGVzdA==',type:'text/markdown'}];};
  await view.click(view.pill().querySelector('.more'));await view.click(view.menu.querySelector('.select-messages'));
  await view.click(view.menu.querySelector('.message-choice input'));await view.click(view.menu.querySelector('.primary'));
  assert.match(view.menu.querySelector('.file-option').textContent,/Include 1 file/);
  await view.click(view.row('Claude'));
  assert.equal(fileReads,1);assert.equal(view.sent('ASB_SHARE')[0].files[0].name,'draft.md');
  assert.equal(view.sent('ASB_SHARE')[0].kind,'conversation');
});

test('navigation while selected messages are being read discards the completed result', async t => {
  const view=setup(t);conversation(view);await view.refresh();
  let finish;
  view.adapter.readMessages=()=>new Promise(resolve=>{finish=resolve;});
  await view.click(view.pill().querySelector('.more'));await view.click(view.menu.querySelector('.select-messages'));
  await view.click(view.menu.querySelector('.message-choice input'));await view.click(view.menu.querySelector('.primary'));
  assert.equal(view.menu.querySelector('.primary').textContent,'Preparing…');
  view.dom.window.history.pushState({},'', '/c/another');
  finish({ok:true,text:'Old conversation',conversation:true});await settle();
  assert.equal(view.menu.hidden,true);assert.equal(view.menu.querySelector('button.row'),null);
  assert.match(view.toast.textContent,/conversation changed/);
  assert.equal(view.sent('ASB_SHARE').length,0);
  assert.equal(view.pill().querySelector('.send').disabled,false);
});

test('transparent neighbouring controls never supply invisible ink to the extension', async t => {
  const view=setup(t);await settle();
  view.document.querySelector('#site-send').style.cssText='color:rgba(255,255,255,0);background-color:transparent';
  await view.refresh();
  assert.equal(view.pill().querySelector('.root').style.getPropertyValue('--ink'),'');
  assert.match(view.pill().querySelector('style').textContent,/color:var\(--fg\); -webkit-text-fill-color:currentColor/);
});

test('a site revealing a different composer control through attributes triggers remounting', async t => {
  const view=setup(t);await settle();
  const group=view.document.createElement('div');group.id='revealed-group';view.document.querySelector('form').append(group);
  view.adapter.composerAnchor=()=>view.document.querySelector('#site-send').hidden ? {parent:group,before:null} : {parent:view.document.querySelector('#group'),before:view.document.querySelector('#site-send')};
  view.document.querySelector('#site-send').hidden=true;
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(view.composer().parentNode,group);
});

// ---------- Interface language ----------
test('the controls beside the composer and replies change language as soon as one is chosen', async t => {
  const view = setup(t);
  await settle();
  const send = () => view.pill().querySelector('.send');
  const shareButtons = () => view.hosts('share').map(host => host.shadowRoot.querySelector('.share-primary'));
  const latest = () => [...view.hosts('share').at(-1).shadowRoot.querySelectorAll('.share-button')].map(node => node.textContent);
  assert.equal(send().textContent, 'Send both');
  assert.deepEqual(latest(), ['Share to Claude', '', 'Compare', 'Cross-review', '']);

  view.dom.window.AISplitI18n.choose('zh-CN');
  await settle();
  assert.equal(send().textContent, '同时发送');
  assert.equal(send().title, '在这里发送，并同时发送到 Claude（Ctrl+Shift+Enter）');
  assert.equal(view.pill().querySelector('.more').getAttribute('aria-label'), '选择聊天和对话操作');
  assert.equal(view.hosts('share').length, 2, 'each reply keeps exactly one share control');
  assert.deepEqual(latest(), ['分享给 Claude', '', '对比', '互评', '']);
  assert.match(shareButtons()[0].title, /^发送给 Claude/);
  const [, , compare, review, options] = view.hosts('share').at(-1).shadowRoot.querySelectorAll('.share-button');
  assert.equal(compare.title, '对比两侧的最新回答');
  assert.equal(review.getAttribute('aria-label'), '让两个回答互评');
  assert.equal(options.title, '选择互评方式，或修订一个回答');

  view.dom.window.AISplitI18n.choose('en');
  await settle();
  assert.equal(send().textContent, 'Send both');
  assert.deepEqual(latest(), ['Share to Claude', '', 'Compare', 'Cross-review', '']);
  assert.equal(view.hosts('composer').length, 1);
});

test('menus, their hints and notices are written in Chinese when it is chosen', async t => {
  const view = setup(t);
  await settle();
  view.dom.window.AISplitI18n.choose('zh-CN');
  await settle();
  await view.click(view.pill().querySelector('.more'));
  assert.equal(view.menu.querySelector('.heading').textContent, '把这条提问发送到');
  assert.equal(view.row('Claude').querySelector('.detail').textContent, '右侧 · Chat two');
  assert.equal(view.row('Gemini').querySelector('.detail').textContent, '其他标签页 · Trip ideas');
  assert.equal(view.row('Grok').querySelector('.detail').textContent, '已休眠 · 请先打开它的标签页');
  assert.equal(view.row('Gemini').querySelector('.show').title, '在右侧显示 Gemini');
  assert.deepEqual([...view.menu.querySelectorAll('.footer .link')].map(node => node.textContent), ['总结此对话…', '将最新回复作为上下文分享…', '对比最新回答…', '互评…']);
  assert.equal(view.menu.querySelector('.footer .hint').textContent, '按 Ctrl+Shift+Enter 发送到已勾选的聊天');
  await view.click(view.row('Gemini').querySelector('[role=menuitemcheckbox]'));
  assert.equal(view.menu.querySelector('.primary').textContent, '全部发送');
  await view.click(view.row('Claude').querySelector('[role=menuitemcheckbox]'));
  await view.click(view.row('Gemini').querySelector('[role=menuitemcheckbox]'));
  assert.equal(view.pill().querySelector('.send').textContent, '发送到…');
  assert.equal(view.menu.querySelector('.primary').textContent, '选择一个聊天');
  await view.click(view.pill().querySelector('.more'));

  const share = view.hosts('share')[0].shadowRoot.querySelector('.share-options');
  await view.click(share);
  assert.equal(view.menu.querySelector('.heading').textContent, '把这条回复发送到');
  assert.equal(view.menu.querySelector('.hint').textContent, '会连同你的分享消息立即发送。');
  assert.equal(view.option('Gemini').textContent, 'Gemini · 将在右侧打开 · Trip ideas');
  await view.click(share);

  view.model.respond = message => message.type === 'ASB_CONTEXT' ? view.model.context : { ok: false };
  await view.click(view.hosts('share')[0].shadowRoot.querySelector('.share-options'));
  await view.click(view.action('review-reply'));
  assert.equal(view.toast.textContent, '无法完成该操作。');

  view.model.respond = message => message.type === 'ASB_CONTEXT' ? view.model.context : view.model.compareStatus;
  const compare = view.hosts('share').at(-1).shadowRoot.querySelector('.share-button.compare');
  await view.click(compare);
  assert.equal(view.menu.querySelector('.heading').textContent, '由谁来对比这两个最新回答？');
  assert.equal(view.menu.querySelector('.hint').textContent, '选定后，会把两个回答都发送到该聊天进行对比。');
  assert.equal(view.row('ChatGPT').querySelector('.detail').textContent, '左侧');
});


const instructionPresets = [
  { id: 'reply-sources', kind: 'reply', title: 'Check sources' },
  { id: 'reply-length', kind: 'reply', title: 'Keep it short' },
  { id: 'review-counter', kind: 'review', title: 'Find a counterexample' },
  { id: 'review-risk', kind: 'review', title: 'Flag risks' },
];

test('reply sharing passes checked instructions and a one-time addition, while context sharing keeps the original reply', async t => {
  const view = setup(t, { ...split(), instructions: instructionPresets });
  await settle();
  const trigger = view.hosts('share')[0].shadowRoot.querySelector('.share-options');
  await view.click(trigger);
  const panel = view.menu.querySelector('details.instructions');
  const checks = Array.from(panel.querySelectorAll('input'));
  assert.deepEqual(checks.map(check => check.value), ['reply-sources', 'reply-length']);
  checks.reverse().forEach(check => { check.checked = true; });
  panel.querySelector('textarea').value = ' Keep the code examples. ';
  await view.click(view.action('review-reply'));
  assert.deepEqual(view.sent('ASB_SHARE'), [{
    ...directReply, reply: 'First answer.',
    instructionIds: ['reply-sources', 'reply-length'], instructionText: 'Keep the code examples.',
  }]);
  await view.click(trigger);
  assert.equal(view.menu.querySelector('.share-context'), null, 'one context action is enough for an individual reply');
  await view.click(view.action('handoff'));
  assert.deepEqual(view.sent('ASB_SHARE').at(-1), { ...directReply, actionId: 'handoff', reply: 'First answer.', instructionIds: [] });
});

test('saved instructions appear in an open menu and a user can override defaults for one send', async t => {
  const view = setup(t);
  await settle();
  const options = view.hosts('share')[0].shadowRoot.querySelector('.share-options');
  await view.click(options);
  const panel = view.menu.querySelector('details.instructions');
  const oneTime = panel.querySelector('textarea');
  oneTime.value = 'Keep page numbers.';
  const preset = { id: 'sources', title: 'Check sources', kind: 'reply', useByDefault: true };
  view.model.context = { ...split(), instructions: [preset] };
  await view.refresh();
  assert.equal(panel.open, false, 'supplemental instructions stay secondary to actions');
  panel.open = true;
  assert.equal(panel.querySelector('input').checked, true);
  assert.equal(panel.querySelector('summary').textContent, 'Extra instructions · 1 selected');
  await view.click(panel.querySelector('input'));
  view.model.context.instructions = [
    { ...preset, title: 'Cite sources' },
    { id: 'extra', title: 'Be brief', kind: 'reply', useByDefault: true },
    { id: 'prompt', title: 'Prompt only', kind: 'prompt', useByDefault: true },
  ];
  await view.refresh();
  const checks = [...panel.querySelectorAll('input')];
  assert.deepEqual(checks.map(box => [box.value, box.checked]), [['sources', false], ['extra', true]]);
  assert.equal(checks[0].parentElement.textContent, 'Cite sources');
  assert.equal(oneTime.value, 'Keep page numbers.');
  await view.click(checks[1]);
  await view.click(view.action('review-reply'));
  assert.deepEqual(view.sent('ASB_SHARE'), [{ ...directReply, reply: 'First answer.',
    instructionIds: [], instructionText: 'Keep page numbers.' }]);
  await view.click(options);
  assert.equal(view.menu.querySelectorAll('.instructions :checked').length, 2, 'the override only affects one send');
});

test('the cross-review menu applies the selected additions to its chosen mode', async t => {
  const view = setup(t, { ...split(), instructions: instructionPresets, shareMode: 'draft' });
  await settle();
  const options = view.hosts('share').at(-1).shadowRoot.querySelector('.review-options');
  await view.click(options);
  const panel = view.menu.querySelector('.instructions');
  assert.deepEqual(Array.from(panel.querySelectorAll('input'), check => check.value), ['review-counter', 'review-risk']);
  panel.querySelectorAll('input').forEach(check => { check.checked = true; });
  panel.querySelector('textarea').value = 'Check the numbers.';
  await view.click(view.row('Find errors'));
  assert.deepEqual(view.sent('ASB_CROSS_REVIEW'), [{
    type: 'ASB_CROSS_REVIEW', peerId: 2, peerProvider: 'claude', expectedMode: 'draft',
    actionId: 'errors', turns: ['local-turn', 'peer-turn'], instructionIds: ['review-counter', 'review-risk'],
    instructionText: 'Check the numbers.',
  }]);
});

test('the composer can request or draft a summary in a single chat', async t => {
  const view = setup(t, { ...split(), chats: [], closed: [], peer: null, native: false });
  await settle();
  const summary = view.pill().querySelector('.send');
  assert.equal(summary.textContent, 'Summarize…');
  assert.equal(view.pill().querySelector('.more').hidden, true);
  for (const [selector, send] of [['.link', false], ['.primary', true]]) {
    await view.click(summary);
    assert.equal(view.menu.querySelector('.heading').textContent, 'Summarize this chat');
    await view.click(view.menu.querySelector(selector));
    assert.deepEqual(view.sent('ASB_SUMMARIZE').at(-1), { type: 'ASB_SUMMARIZE', send, page: 'https://chatgpt.com/c/example' });
  }
  assert.equal(view.sent('ASB_SEND').length, 0);
});

test('the composer shares the latest reply as context and refuses a summary after navigation', async t => {
  const view = setup(t);
  await settle();
  const menu = view.pill().querySelector('.more');
  await view.click(menu);
  await view.click(view.menu.querySelector('.share-context'));
  await view.click(view.row('Claude'));
  assert.deepEqual(view.sent('ASB_SHARE'), [{ type: 'ASB_SHARE', targetId: 2, reply: 'Second answer.', kind: 'handoff' }]);
  await view.click(menu);
  await view.click(view.menu.querySelector('.summarize'));
  view.dom.window.history.pushState({}, '', '/c/other');
  await view.click(view.menu.querySelector('.primary'));
  assert.equal(view.sent('ASB_SUMMARIZE').length, 0);
  assert.match(view.toast.textContent, /conversation changed/i);
});

test('custom actions run from the same list as built-ins in the matching share or review workflow', async t => {
  const state = split();
  state.actions.push(
    { id: 'citations', kind: 'reply', title: 'Check citations', isDefault: true, builtin: false },
    { id: 'translate', kind: 'prompt', title: 'Translate to Japanese', isDefault: false, builtin: false },
    { id: 'counterexample', kind: 'review', title: 'Find a counterexample', isDefault: false, builtin: false },
  );
  state.actions[0].isDefault = false;
  const view = setup(t, state);
  conversation(view);
  await view.refresh();

  const reply = view.hosts('share').find(host => host.dataset.shareRole === 'assistant').shadowRoot;
  const prompt = view.hosts('share').find(host => host.dataset.shareRole === 'user').shadowRoot;
  const review = view.document.querySelectorAll('article.reply')[1].querySelector('[data-share-role=assistant]').shadowRoot;
  assert.match(reply.querySelector('.share-primary').title, /Check citations/);
  await view.click(reply.querySelector('.share-options'));
  const names = () => [...view.menu.querySelectorAll('.action-list .name')].map(node => node.textContent);
  assert.deepEqual(names(), ['Review reply', 'Share as context', 'Check citations']);
  assert.equal(view.action('citations').querySelector('.detail').textContent, 'Default');
  assert.equal(view.option('Claude').selected, true);
  view.action('citations').click();
  view.action('citations').click();
  await settle();
  assert.deepEqual(view.sent('ASB_SHARE'), [{ ...directReply, actionId: 'citations', reply: 'First answer.', instructionIds: [] }]);

  await view.click(prompt.querySelector('.share-options'));
  assert.deepEqual(names(), ['Answer prompt', 'Translate to Japanese']);
  view.choose('Gemini');
  await view.click(view.action('translate'));
  assert.deepEqual(view.sent('ASB_SHARE')[1], { type: 'ASB_SHARE', kind: 'prompt', actionId: 'translate', targetId: 3,
    expectedMode: 'send', reply: 'My original question.', instructionIds: [] });

  await view.click(review.querySelector('.review-options'));
  assert.deepEqual(names(), ['Critique', 'Find errors', 'Suggest improvements', 'Find a counterexample']);
  await view.click(view.action('counterexample'));
  assert.deepEqual(view.sent('ASB_CROSS_REVIEW'), [{ type: 'ASB_CROSS_REVIEW', actionId: 'counterexample',
    expectedMode: 'send', peerId: 2, peerProvider: 'claude', turns: ['local-turn', 'peer-turn'], instructionIds: [] }]);
});

test('open menus reflect action renames and deletions while keeping the chosen destination and one-time text', async t => {
  const view = setup(t);
  await settle();
  const options = view.hosts('share')[0].shadowRoot.querySelector('.share-options');
  await view.click(options);
  view.choose('Gemini');
  const extras = view.menu.querySelector('.instructions textarea');
  extras.value = 'Keep equations.';
  view.model.context.actions.push({ id: 'math', title: 'Check math', kind: 'reply', builtin: false, isDefault: false });
  await view.refresh();
  const original = view.action('math');
  original.focus();
  view.model.context.actions = view.model.context.actions.map(a => a.id === 'math' ? { ...a, title: 'Verify calculations' } : a);
  await view.refresh();
  assert.equal(view.action('math').querySelector('.name').textContent, 'Verify calculations');
  assert.equal(view.action('math').getRootNode().activeElement, view.action('math'));
  assert.ok(view.option('Gemini').selected);
  const renamed = view.action('math');
  view.model.context.actions = view.model.context.actions.filter(a => a.id !== 'math');
  await view.refresh();
  assert.equal(view.action('math'), null);
  await view.click(renamed);
  assert.equal(view.sent('ASB_SHARE').length, 0);
  await view.click(view.action('review-reply'));
  assert.equal(view.sent('ASB_SHARE')[0].targetId, 3);
  assert.equal(view.sent('ASB_SHARE')[0].instructionText, 'Keep equations.');
});

test('Add action opens the correct editor without sending, including when cross-review is unavailable', async t => {
  const view = setup(t);
  conversation(view);
  await view.refresh();
  const reply = view.hosts('share').find(node => node.dataset.shareRole === 'assistant').shadowRoot;
  const prompt = view.hosts('share').find(node => node.dataset.shareRole === 'user').shadowRoot;
  for (const root of [reply, prompt]) {
    await view.click(root.querySelector('.share-options'));
    await view.click(view.menu.querySelector('.add-action'));
    assert.equal(view.menu.hidden, true);
  }
  view.model.reviewStatus = { ok: true, ready: false };
  const latest = view.hosts('share').find(node => node.shadowRoot.querySelector('.review-options'));
  await view.click(latest.shadowRoot.querySelector('.review-options'));
  assert.ok(view.action('critique').disabled);
  await view.click(view.menu.querySelector('.add-action'));
  assert.deepEqual(view.sent('ASB_OPEN_ACTION_EDITOR').map(m => m.kind), ['reply', 'prompt', 'review']);
  assert.equal(view.sent('ASB_CROSS_REVIEW').length + view.sent('ASB_SHARE').length, 0);
});

test('sharing an action after a peer or delivery mode change stops without sending', async t => {
  const view = setup(t);
  await settle();
  const options = view.hosts('share')[0].shadowRoot.querySelector('.share-options');
  await view.click(options);
  view.model.context = { ...split(), peer: null, side: null, native: false };
  await view.click(view.action('review-reply'));
  assert.equal(view.sent('ASB_SHARE').length, 0);
  assert.match(view.toast.textContent, /changed/);
  view.model.context = split();
  await view.refresh();
  await view.click(options);
  view.choose('Gemini');
  view.model.context.shareMode = 'draft';
  await view.click(view.action('review-reply'));
  assert.equal(view.sent('ASB_SHARE').length, 0);
});
