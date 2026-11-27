import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { translations } from './translations.js';

const scripts = await Promise.all(['adapters.js', 'reading-turns.js'].map(name => readFile(new URL(`../extension/${name}`, import.meta.url), 'utf8')));
const fixtures = {
  'chatgpt.com': `<article data-turn-id="turn1"><div data-message-author-role="user">Check the claim</div></article>
    <article data-turn-id="turn2"><div data-message-author-role="assistant"><div class="markdown"><p>The first result</p><p>The last result</p></div></div></article>`,
  'claude.ai': `<div data-turn-key="one"><div data-testid="user-message">Check the claim</div></div>
    <div data-turn-key="two"><div data-testid="assistant-message" class="font-claude-response">The first result</div><div class="font-claude-response">The last result</div><div><button aria-label="Copy"></button><button aria-label="Give positive feedback"></button></div></div>`,
  'gemini.google.com': '<user-query>Check the claim</user-query><model-response><div class="model-response-text"><p>The first result</p><p>The last result</p></div><message-actions><button aria-label="Copy">Copy</button><button aria-label="Good response">Good</button></message-actions></model-response>',
  'grok.com': '<div data-testid="user-message">Check the claim</div><div class="message-bubble"><div class="response-content-markdown"><p>The first result</p><p>The last result</p></div></div>',
};
function setup(t, hostname, markup) {
  const window = new JSDOM(`<main>${markup}<form><textarea id="draft">Keep my draft</textarea></form></main>`, {
    url: `https://${hostname}/chat/one`, runScripts: 'outside-only', pretendToBeVisual: true,
  }).window;
  t.after(() => window.close());
  const { document } = window;
  window.HTMLElement.prototype.getClientRects = () => [{ height: 20, width: 300 }];
  let scrolled;
  window.HTMLElement.prototype.scrollIntoView = function (options) { scrolled = { node: this, block: options.block }; };
  window.eval(translations);
  for (const script of scripts) window.eval(script);
  const api = window.AISplitReadingTurns, adapter = window.AISplitAdapters;
  const hidden = new Set(), bookmarks = new Set();
  function toggle(set, record) { if (set.has(record.key)) set.delete(record.key); else set.add(record.key); render(); }
  function render() { return Array.from(api.render({ hidden, bookmarks,
    onToggleHidden: record => toggle(hidden, record), onToggleBookmark: record => toggle(bookmarks, record),
  })); }
  const hosts = () => [...document.querySelectorAll('[data-asb-reading-ui]')];
  const buttons = (i, action) => hosts()[i].shadowRoot.querySelector(`button[data-action="${action}"]`);
  return { window, document, api, adapter, hidden, bookmarks, render, hosts, buttons, scrolled: () => scrolled };
}

for (const [hostname, markup] of Object.entries(fixtures)) {
  test(`${hostname}: folding a marked reply preserves the prompt, full sharing text and draft; jumping reveals the start`, t => {
    const f = setup(t, hostname, markup);
    const [prompt, reply] = f.render();
    assert.equal(f.hosts().length, 2);
    assert.equal(prompt.role, 'user');
    assert.equal(reply.role, 'assistant');
    assert.doesNotMatch(reply.key, /result/);
    assert.match(reply.label, /The first result/);
    const before = Array.from(f.adapter.messages(), entry => entry.text);
    f.buttons(1, 'bookmark').click();
    f.buttons(1, 'fold').click();
    assert.deepEqual(Array.from(f.bookmarks), [reply.key]);
    const folded = f.document.querySelector('[data-asb-reading-collapsed]');
    assert.ok(folded);
    assert.match(folded.textContent, /The first result/);
    assert.match(folded.textContent, /The last result/);
    assert.doesNotMatch(folded.textContent, /Check the claim/);
    assert.equal(f.buttons(1, 'fold').textContent, 'Show reply');
    assert.equal(f.hosts()[1].nextElementSibling, folded);
    assert.equal(f.render()[1].key, reply.key);
    assert.deepEqual(Array.from(f.adapter.messages(), entry => entry.text), before);
    assert.ok(f.api.jump(reply.key));
    assert.equal(f.hidden.size, 0);
    assert.equal(f.scrolled().node, folded);
    assert.equal(f.scrolled().block, 'start');
    assert.equal(f.document.querySelector('[data-asb-reading-collapsed]'), null);
    f.buttons(1, 'bookmark').click();
    assert.equal(f.bookmarks.size, 0);
    assert.equal(f.document.querySelector('#draft').value, 'Keep my draft');
    f.buttons(0, 'fold').click();
    assert.equal(f.buttons(0, 'fold').textContent, 'Show prompt');
    f.api.clear();
    assert.equal(f.hosts().length, 0);
    assert.equal(f.document.querySelector('[data-asb-reading-collapsed], [data-asb-reading-target]'), null);
    assert.deepEqual(Array.from(f.adapter.messages(), entry => entry.text), before);
  });
}

test('native identities survive edits, reordered same-text prompts and replaced DOM nodes', t => {
  const turn = (id, text) => `<article data-turn-id="${id}"><div data-message-author-role="user">${text}</div></article>`;
  const f = setup(t, 'chatgpt.com', turn('a', 'same') + turn('b', 'same'));
  const [first, second] = f.render();
  assert.notEqual(first.key, second.key);
  f.buttons(1, 'bookmark').click();
  f.buttons(1, 'fold').click();
  f.document.querySelector('main').innerHTML = turn('b', 'Updated source') + turn('a', 'same');
  const replacement = f.render();
  assert.deepEqual(replacement.map(entry => entry.key), [second.key, first.key]);
  assert.equal(f.buttons(0, 'bookmark').getAttribute('aria-pressed'), 'true');
  assert.match(f.document.querySelector('[data-asb-reading-collapsed]').textContent, /Updated source/);
  assert.ok(f.api.jump(second.key));
});

test('unidentified messages restore from content after a reload and fresh controls never affect their keys', t => {
  const html = fixtures['gemini.google.com'];
  const a = setup(t, 'gemini.google.com', html), b = setup(t, 'gemini.google.com', html);
  const old = a.render();
  b.hidden.add(old[0].key); b.bookmarks.add(old[1].key);
  const restored = b.render();
  assert.deepEqual(restored.map(r => r.key), old.map(r => r.key));
  assert.equal(b.buttons(0, 'fold').textContent, 'Show prompt');
  assert.equal(b.buttons(1, 'bookmark').getAttribute('aria-pressed'), 'true');
  assert.equal(b.api.jump('missing'), false);
});

test('a Gemini bookmark keeps its position while the response streams and native markup is replaced', t => {
  const f = setup(t, 'gemini.google.com', fixtures['gemini.google.com']);
  const old = f.render()[1];
  f.buttons(1, 'bookmark').click();
  const model = f.document.querySelector('model-response');
  model.querySelector('p').firstChild.textContent = 'A longer response as Gemini writes';
  const updated = f.render()[1];
  assert.equal(updated.key, old.key);
  assert.match(updated.label, /longer response/);
  model.replaceWith(model.cloneNode(true));
  assert.equal(f.render()[1].key, old.key);
  assert.equal(f.buttons(1, 'bookmark').getAttribute('aria-pressed'), 'true');
});

function virtualChat(t) {
  const item = (id, text) => `<article data-turn-id="${id}"><div data-message-author-role="assistant">${text}</div></article>`;
  const marked = item('past', 'Important earlier answer');
  const f = setup(t, 'chatgpt.com', `<div id="history" style="overflow-y:auto">${marked}</div>`);
  const history = f.document.querySelector('#history');
  Object.defineProperties(history, { scrollHeight: { value: 10000 }, clientHeight: { value: 500 } });
  history.getBoundingClientRect = () => ({ top: 50, height: 500, width: 600 });
  history.scrollTop = 800;
  history.firstChild.getBoundingClientRect = () => ({ top: 130, width: 600, height: 180 });
  const [record] = f.render();
  f.buttons(0, 'bookmark').click();
  f.buttons(0, 'fold').click();
  history.scrollTop = 6800;
  history.innerHTML = item('latest', 'A different later answer');
  const index = f.render();
  assert.ok(index.some(entry => entry.key === record.key && entry.label === 'Important earlier answer'));
  assert.equal(history.scrollTop, 6800, 'listing bookmarks never scrolls');
  return { f, history, record, marked, item };
}

test('jump restores a virtualized bookmarked reply in its real scroller and reveals it before reporting success', async t => {
  const { f, history, record, marked, item } = virtualChat(t);
  const positions = [];
  history.scrollTo = ({ top }) => {
    positions.push(top); history.scrollTop = top;
    history.innerHTML = item('nearby', 'Important earlier answer'); // identical text, different native ID
    f.render();
    f.window.setTimeout(() => { history.innerHTML = marked; f.render(); }, 10);
  };
  assert.equal(await f.api.jump(record.key), true);
  assert.deepEqual(positions, [880], 'maintains the scroll pane’s offset from the browser viewport');
  assert.equal(f.scrolled().node.getAttribute('data-turn-id'), 'past');
  assert.equal(f.hidden.has(record.key), false);
  f.api.clear();
  assert.equal(f.api.jump(record.key), false, 'old chat positions are discarded');
});

test('a failed virtual bookmark jump never selects a substitute and restores the initial position', async t => {
  const { f, history, record, item } = virtualChat(t);
  const timeout = f.window.setTimeout.bind(f.window);
  f.window.setTimeout = (callback, delay) => timeout(callback, delay === 80 ? 0 : delay);
  const positions = [];
  history.scrollTo = ({ top }) => {
    history.scrollTop = top; positions.push(top);
    history.innerHTML = item('other', 'Important earlier answer');
    f.render();
  };
  assert.equal(await f.api.jump(record.key), false);
  assert.equal(f.scrolled(), undefined);
  assert.equal(positions.at(-1), 6800);
  assert.ok(positions.length <= 5, 'each lookup makes at most four attempts plus one restoration');
});

test('user scrolling cancels a pending bookmark jump and preserves the new position', async t => {
  const { f, history, record } = virtualChat(t);
  const positions = [];
  history.scrollTo = ({ top }) => { positions.push(top); history.scrollTop = top; };
  const jump = f.api.jump(record.key);
  f.window.dispatchEvent(new f.window.Event('wheel'));
  history.scrollTop = 5000;
  assert.equal(await jump, false);
  assert.deepEqual(positions, [880]);
  assert.equal(history.scrollTop, 5000);
});

test('ChatGPT editor replies put Hide in native response actions, and move there when actions arrive', t => {
  const actions = '<div id="reply-actions"><span><button aria-label="Copy"></button></span><button aria-label="Rate response"></button><button aria-label="Read aloud"></button></div>';
  const f = setup(t, 'chatgpt.com', `<section data-talvt-turn-state>
    <div data-content-search-unit-key="one:user">Question<div><button aria-label="Copy message"></button><button aria-label="Edit message"></button></div></div>
    <div id="answer" data-content-search-unit-key="one:assistant"><div data-markdown-text-style="assistant-message">
      <div id="embedded" role="toolbar"><button>Save as Page</button><button aria-label="Copy"></button><button>Open editor</button><button aria-label="Read aloud"></button></div>
      <p>Draft document</p></div></div>
    </section>`);
  const [, reply] = f.render();
  assert.equal(f.hosts()[1].previousElementSibling.id, 'answer', 'streaming reply toolbar fallback stays outside the editor');
  assert.equal(f.buttons(1, 'fold').textContent, 'Hide');
  f.document.querySelector('section').insertAdjacentHTML('beforeend', actions);
  assert.equal(f.render()[1].key, reply.key);
  assert.equal(f.document.querySelector('#embedded [data-asb-reading-ui]'), null);
  assert.equal(f.hosts()[1].parentElement.id, 'reply-actions', 'find native assistant actions even outside the message');
  f.buttons(1, 'fold').click();
  assert.equal(f.document.querySelector('[data-asb-reading-collapsed]').id, 'answer');
  assert.equal(f.document.querySelector('[data-content-search-unit-key$=":user"]').closest('[data-asb-reading-collapsed]'), null);
  f.buttons(1, 'fold').click();
  assert.equal(f.hosts()[1].parentElement.id, 'reply-actions');
  assert.equal(f.adapter.messages()[1].text, 'Draft document');
  assert.equal(f.hosts().length, 2);
});

test('ChatGPT lists replies across mixed renderers and display:contents role wrappers', t => {
  const f = setup(t, 'chatgpt.com', `<section data-turn-id="a">
      <div data-message-role="user">First question</div>
      <div data-markdown-text-style="assistant-message">First reply</div>
    </section><section data-turn-id="b">
      <div data-message-role="user">Second question</div>
      <div data-message-role="assistant" style="display:contents"><p>Second reply</p></div>
    </section><aside><div data-assistant-markdown-root>Unrelated preview</div></aside>`);
  const semantic = f.document.querySelector('[data-message-role="assistant"]');
  semantic.getClientRects = () => [];
  const entries = f.render();
  assert.deepEqual(entries.map(entry => entry.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(f.hosts().length, 4);
  assert.equal(f.buttons(3, 'fold').getAttribute('aria-label'), 'Hide reply');
  f.buttons(3, 'fold').click();
  assert.equal(f.document.querySelector('[data-asb-reading-collapsed]'), semantic);
  assert.equal(f.render().at(-1).key, entries[3].key);
  assert.deepEqual(Array.from(f.adapter.messages(), entry => entry.text), ['First question', 'First reply', 'Second question', 'Second reply']);
});

test('a ChatGPT reply with an unrecognized renderer uses its own outer actions and never folds a neighboring prompt', t => {
  const bar = id => `<div id="${id}"><button aria-label="Copy"></button><button aria-label="Rate response"></button></div>`;
  const f = setup(t, 'chatgpt.com', `<article><div data-message-author-role="assistant">Known answer</div></article>
    <section data-talvt-turn-state><div data-content-search-unit-key="b:user">User prompt</div>
      <div id="custom-answer">New answer structure</div>${bar('own')}</section>
    <section data-talvt-turn-state><div data-content-search-unit-key="c:user">Another prompt</div>${bar('unassigned')}</section>`);
  const entries = f.render();
  assert.deepEqual(entries.map(record => record.role), ['assistant', 'user', 'assistant', 'user']);
  assert.equal(f.document.querySelector('#unassigned [data-asb-reading-ui]'), null);
  const fold = f.document.querySelector('#own [data-asb-reading-ui]').shadowRoot.querySelector('[data-action="fold"]');
  fold.click();
  assert.equal(f.document.querySelector('[data-asb-reading-collapsed]').id, 'custom-answer');
});
