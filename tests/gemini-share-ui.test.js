import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { translations } from './translations.js';

const scripts = await Promise.all(['adapters.js', 'content.js'].map(file =>
  readFile(new URL(`../extension/${file}`, import.meta.url), 'utf8')));
const settle = () => new Promise(resolve => setImmediate(resolve));

test('Chinese Gemini exposes Share for both speakers and transfers the chosen message', async t => {
  // Gemini localizes its action labels and nests the buttons inside Angular components.
  const fixture = `<!doctype html><html lang="zh-CN"><body><main>
    <user-query><span class="user-query-container"><user-query-content><div class="user-query-container">
      <div class="query-content"><p class="query-text">两段话有什么不同？</p></div>
      <div class="luminous-actions-container">
        <gem-icon-button data-test-id="prompt-copy-button"><button aria-label="复制提示"></button></gem-icon-button>
        <gem-icon-button data-test-id="prompt-edit-button"><button aria-label="修改提示"></button></gem-icon-button>
      </div>
    </div></user-query-content></span></user-query>
    <model-response><response-container><div class="response-container">
      <div class="response-container-content"><div><structured-content-container class="model-response-text">
        <message-content><p>第一段讨论时间，第二段讨论成本。</p></message-content>
      </structured-content-container></div></div>
      <div class="response-container-footer"><div><message-actions footer><div><div class="buttons-container-v2">
        <gem-icon-button><button aria-label="答得好"></button></gem-icon-button>
        <gem-icon-button><button aria-label="答得不好"></button></gem-icon-button>
        <gem-icon-button><button aria-label="重做"></button></gem-icon-button>
        <copy-button><gem-icon-button><button aria-label="复制"></button></gem-icon-button></copy-button>
        <gem-icon-button><button aria-label="显示更多选项"></button></gem-icon-button>
      </div></div></message-actions></div></div>
    </div></response-container></model-response>
    <form><rich-textarea><div class="ql-editor" contenteditable="true"></div></rich-textarea>
      <div class="input-buttons-wrapper-bottom"><button aria-label="麦克风"></button></div></form>
  </main></body></html>`;
  const { window } = new JSDOM(fixture, {
    url: 'https://gemini.google.com/app/example', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  t.after(() => window.close());
  // jsdom has no layout engine. Visible elements need a box for the production adapter.
  window.HTMLElement.prototype.getClientRects = () => [{ width: 100, height: 32 }];
  const peer = { id: 2, provider: 'claude', name: 'Claude', side: 'left' };
  const shares = [];
  const doc = window.document;
  const promptActions = doc.querySelector('.luminous-actions-container');
  const answerActions = doc.querySelector('.response-container-footer');
  const promptParent = promptActions.parentElement;
  const answerParent = answerActions.parentElement;
  promptActions.remove();
  answerActions.remove();
  window.chrome = { runtime: {
    id: 'extension', onMessage: { addListener() {} },
    async sendMessage(message) {
      if (message.type === 'ASB_CONTEXT') {
        return { ok: true, selfId: 1, provider: 'gemini', side: 'right', native: true, peer, chats: [peer], closed: [], shareMode: 'draft' };
      }
      assert.equal(message.type, 'ASB_SHARE');
      shares.push({ ...message });
      return { ok: true, message: 'Draft added to Claude.' };
    },
  } };
  window.eval(translations);
  for (const source of scripts) window.eval(source);
  await settle();
  const editorPill = doc.querySelector('.input-buttons-wrapper-bottom [data-ai-split-bridge="composer"]');
  assert.equal(editorPill?.shadowRoot.querySelector('.send')?.textContent, 'Send both');
  const promptControl = doc.querySelector('user-query [data-share-role="user"]');
  const answerControl = doc.querySelector('model-response [data-share-role="assistant"]');
  assert.ok(promptControl && answerControl, 'both turns can be shared before their native toolbars load');
  promptParent.append(promptActions);
  answerParent.append(answerActions);
  // Wait for the content script's own debounced render after the site adds its controls.
  await new Promise(resolve => window.setTimeout(resolve, 350));
  assert.equal(promptControl.parentElement, promptActions);
  assert.equal(answerControl.parentElement, answerActions.querySelector('.buttons-container-v2'));
  const menu = doc.querySelector('[data-ai-split-bridge="layer"]').shadowRoot.querySelector('[role="menu"]');
  const cases = [
    { turn: 'user-query', role: 'user', payload: { kind: 'prompt', reply: '两段话有什么不同？' } },
    { turn: 'model-response', role: 'assistant', payload: { reply: '第一段讨论时间，第二段讨论成本。' } },
  ];
  for (const [index, { turn, role, payload }] of cases.entries()) {
    const controls = doc.querySelectorAll(`${turn} [data-ai-split-bridge="share"][data-share-role="${role}"]`);
    assert.equal(controls.length, 1, `one Share control under the ${role} turn`);
    assert.equal(controls[0].style.display, 'inline-flex');
    controls[0].shadowRoot.querySelector('.share-button').click();
    await settle();
    assert.equal(menu.hidden, false);
    const reviewer = [...menu.querySelectorAll('button.row')].find(button => button.querySelector('.name')?.textContent === 'Claude');
    assert.ok(reviewer);
    assert.equal(shares.length, index, 'opening the picker does not transfer text');
    reviewer.click();
    await settle();
    assert.deepEqual(shares[index], { type: 'ASB_SHARE', targetId: peer.id, ...payload });
  }
});
