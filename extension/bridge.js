import './i18n.js';
import { PROVIDERS, providerFor } from './providers.js';
import { composeComparison } from './settings.js';

const i18n = globalThis.AISplitI18n;
const { t, list } = i18n;
// Menus are identified by their English names; these are the names shown to the user.
const menuName = menu => menu === 'Share' ? t('Share') : menu === 'Cross-review' ? t('Cross-review') : t('Compare');
const paneLabel = ({ name, side }) => side === 'left' ? t('{name} (left pane)', { name }) : t('{name} (right pane)', { name });

const MAX_TARGETS = 8;
const MAX_FILES = 10;

export function createBridge(api, manager, { retryDelay = 500, retryLimit = 40 } = {}) {
  const busyWindows = new Set();

  async function locked(windowId, action) {
    if (busyWindows.has(windowId)) throw new Error(t('Another bridge action is running in this window. Wait for it to finish.'));
    busyWindows.add(windowId);
    try { return await action(); } finally { busyWindows.delete(windowId); }
  }

  async function ask(tabId, type, payload = {}, documentId) {
    let result;
    try { result = await api.tabs.sendMessage(tabId, { type, ...payload }, { frameId: 0, ...(documentId && { documentId }) }); }
    catch { throw Object.assign(new Error(t('Chat connection unavailable. Refresh that AI tab after installing or updating the extension.')), { retry: true }); }
    if (!result?.ok) throw Object.assign(new Error(result?.error || t('The chat did not accept the action.')), { retry: !!result?.retry });
    return result;
  }

  function chosen(state, targetIds) {
    if (!Array.isArray(targetIds) || !targetIds.length) throw new Error(t('Choose at least one other chat.'));
    if (targetIds.length > MAX_TARGETS || new Set(targetIds).size !== targetIds.length) throw new Error(t('Choose each chat once.'));
    return targetIds.map(id => {
      const chat = state.chats.find(item => item.id === id);
      if (!chat) throw new Error(t('A chosen chat closed or changed. Review the list and try again.'));
      if (chat.asleep) throw new Error(t('{name} is asleep. Open its tab once to wake it, then try again.', { name: chat.name }));
      if (chat.loading) throw new Error(t('{name} is still loading. Wait for the chat tab to finish navigating.', { name: chat.name }));
      return chat;
    });
  }

  async function send(sourceId, targetIds) {
    const state = await manager.context(sourceId);
    const targets = chosen(state, targetIds);
    const ids = [sourceId, ...targets.map(chat => chat.id)];
    const labels = [PROVIDERS[state.provider].name, ...targets.map(chat => chat.name)];
    const { text, files = [], notCopied = [] } = await ask(sourceId, 'ASB_READ_DRAFT');
    if (!Array.isArray(files) || !Array.isArray(notCopied) || files.length > MAX_FILES) throw new Error(t('The attachments could not be read. Nothing was sent.'));
    if (notCopied.length) {
      throw new Error(t('Nothing was sent. {files} could not be copied. Remove and reattach those files in this chat, then try again. Both chats need the same context.', { files: list(notCopied) }));
    }
    validateText(text, { allowEmpty: files.length > 0 });
    const requestId = crypto.randomUUID();
    // Copies go out once, when staging; the source keeps and sends its own attachments.
    const payload = (id, type) => id === sourceId ? { requestId, text, source: true }
      : { requestId, text, source: false, attachments: files.length, ...(type === 'ASB_STAGE' ? { files } : {}) };
    return deliverMany({ ids, labels, requestId, payload, verify: async () => chosen(await manager.context(sourceId), targetIds) });
  }

  async function deliverMany({ ids, labels, requestId, payload, verify, sendNow = true }) {
    async function phase(type) {
      // Wait for every chat even when one fails before cancelling any of them.
      const results = await Promise.allSettled(ids.map((id, i) => ask(id, type, payload(id, type, i))));
      const errors = results.flatMap((r, i) => r.status === 'rejected' ? [t('{chat}: {error}', { chat: labels[i], error: r.reason.message })] : []);
      if (errors.length) throw new Error(errors.join(t(' ')));
    }
    try {
      await phase('ASB_PREPARE');
      await phase('ASB_STAGE');
      await phase('ASB_VALIDATE');
      await verify();
    } catch (error) {
      const cleanup = await Promise.allSettled(ids.map(id => ask(id, 'ASB_CANCEL', { requestId })));
      const left = labels.filter((_, i) => cleanup[i].value?.leftAttachments);
      throw new Error(left.length
        ? t('Nothing was sent. {error} Remove the copied attachments still in {chats}.', { error: error.message, chats: list(left) })
        : t('Nothing was sent. {error}', { error: error.message }));
    }
    // Separate websites cannot be submitted atomically. Never retry a click automatically.
    const results = await Promise.allSettled(ids.map(id => ask(id, sendNow ? 'ASB_COMMIT' : 'ASB_KEEP', { requestId })));
    await Promise.allSettled(ids.map(id => ask(id, 'ASB_CANCEL', { requestId })));
    const failed = results.flatMap((result, i) => {
      if (result.status !== 'rejected') return [];
      const values = { chat: labels[i], error: result.reason.message };
      return [sendNow ? t('{chat}: {error} Delivery is unconfirmed; check this chat before sending again.', values)
        : t('{chat}: {error} Check the draft in this chat.', values)];
    });
    const sent = labels.filter((_, i) => results[i].status === 'fulfilled');
    const success = !sent.length ? '' : sendNow ? t('Sent to {chats}.', { chats: list(sent) }) : t('Draft ready in {chats}.', { chats: list(sent) });
    return {
      ok: true, partial: failed.length > 0,
      message: [success, ...failed].filter(Boolean).join(t(' ')),
    };
  }

  // A freshly opened page may still be loading its composer; retry only errors marked safe to retry.
  async function insertWhenReady(tabId, text, expect) {
    let lastError;
    for (let attempt = 0; attempt < retryLimit; attempt++) {
      try { return await ask(tabId, 'ASB_INSERT', { text, ...expect }); }
      catch (error) {
        if (!error.retry) throw error;
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
    throw new Error(t('{error} The chat opened, but the draft was not added.', { error: lastError.message }));
  }

  // One destination, one staged transaction, at most one native Send click.
  async function deliver(sourceId, tabId, text, expect, { files = [], send = true, answer, verifyTarget, keepIfSendMissing = false, documentId } = {}) {
    const requestId = crypto.randomUUID();
    const payload = { requestId, text, source: false, attachments: files.length };
    const target = (type, data) => ask(tabId, type, data, documentId);
    try {
      for (let attempt = 1; ; attempt++) {
        try { await target('ASB_PREPARE', { ...payload, ...expect, ...(answer && { answer }), ...(!send && { draftOnly: true }) }); break; }
        catch (error) {
          // Only a pane that was just opened is worth waiting for.
          if (!expect?.provider || !error.retry || attempt >= retryLimit) throw error;
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
      await target('ASB_STAGE', { ...payload, ...(files.length ? { files } : {}) });
      await target('ASB_VALIDATE', { ...payload, ...(keepIfSendMissing && { keepIfSendMissing }) });
      if (verifyTarget) await verifyTarget();
      else chosen(await manager.context(sourceId), [tabId]);
      if (!send) {
        await target('ASB_KEEP', { requestId });
        return;
      }
    } catch (error) {
      const cleanup = await target('ASB_CANCEL', { requestId }).catch(() => null);
      throw new Error(cleanup?.leftAttachments
        ? t('Nothing was sent. {error} Remove the copied attachments still in that chat.', { error: error.message })
        : t('Nothing was sent. {error}', { error: error.message }));
    }
    try { return await target('ASB_COMMIT', { requestId }); }
    catch (error) { throw new Error(t('{error} Delivery is unconfirmed; check that chat before sending again.', { error: error.message })); }
    finally { await target('ASB_CANCEL', { requestId }).catch(() => {}); }
  }

  async function summarize(source, text, { send, page, documentId }) {
    if (typeof send !== 'boolean') throw new Error(t('Unsupported request.'));
    if (page !== source.url) throw new Error(t('The chat changed. Refresh and try again.'));
    validateText(text);
    const verifyTarget = async () => {
      const current = await manager.supported(source.id);
      if (current.url !== page || current.windowId !== source.windowId) {
        throw new Error(t('The chat changed. Refresh and try again.'));
      }
    };
    await deliver(source.id, source.id, text, { expectedUrl: page }, { send, documentId, verifyTarget });
    return { ok: true, message: send
      ? t('Summary requested in this chat. Share the reply as context when it is ready.')
      : t('Summary request added as a draft. Review it, then click Send in this chat.') };
  }

  // Quick sharing is bound to the displayed peer. Never open, move, or substitute a tab.
  async function shareWithPeer(sourceId, choice, text, { files, send, verifyMode }) {
    validateFiles(files);
    validateText(text, { allowEmpty: files.length > 0 });
    const pair = await splitPair(sourceId, choice, 'Share');
    if (pair[0].url !== choice.page) throw new Error(t('The chat changed. Refresh and try again.'));
    const peer = pair[1];
    const verifyTarget = () => Promise.all([verifyPair(pair, choice, 'Share'), verifyMode()]);
    const result = await deliver(sourceId, peer.id, text, { expectedUrl: peer.url }, {
      files, send, verifyTarget, keepIfSendMissing: send && choice.peerProvider === 'gemini' && !files.length,
    });
    if (!send) return { ok: true, message: t('Draft added to {name}. Review it, then send it there.', { name: peer.name }) };
    return { ok: true, message: result.status === 'draft'
      ? t('Your shared text is ready in Gemini. Click Send in Gemini to submit it.')
      : t('Sent to {chats}.', { chats: peer.name }) };
  }

  async function share(sourceId, { targetId, provider } = {}, text, { send = false, files = [] } = {}) {
    validateFiles(files);
    validateText(text, { allowEmpty: files.length > 0 });
    const state = await manager.context(sourceId);
    async function sendShare(tabId, targetProvider, expect, sentMessage) {
      const keepIfSendMissing = targetProvider === 'gemini' && !files.length;
      const result = await deliver(sourceId, tabId, text, expect, { files, keepIfSendMissing });
      return { ok: true, message: result.status === 'draft'
        ? t('Your shared text is ready in Gemini. Click Send in Gemini to submit it.')
        : sentMessage };
    }
    if (targetId !== undefined) {
      const chat = state.chats.find(item => item.id === targetId);
      if (!chat) throw new Error(t('That chat closed or changed. Open Share again.'));
      if (chat.side || !state.peer) {
        const name = chat.name;
        if (chat.asleep) throw new Error(t('{name} is asleep. Open its tab once to wake it, then try again.', { name }));
        if (send) return sendShare(chat.id, chat.provider, undefined, chat.side ? t('Sent to {chats}.', { chats: name }) : t('Sent to {name} in its tab.', { name }));
        if (files.length) await deliver(sourceId, chat.id, text, undefined, { files, send: false });
        else await ask(chat.id, 'ASB_INSERT', { text });
        return { ok: true, message: chat.side ? t('Draft added to {name}. Review it, then send it there.', { name })
          : t('Draft added to {name} in its tab. Review it, then send it there.', { name }) };
      }
    } else if (!Object.hasOwn(PROVIDERS, provider)) {
      throw new Error(t('Choose a supported assistant.'));
    } else if (!state.peer) {
      throw new Error(t('Put this chat in Split View to open another assistant beside it.'));
    }
    const shown = await manager.replace(state.peer.id, { tabId: targetId, provider });
    const expect = { provider: shown.provider, notPage: shown.previousPage };
    const name = PROVIDERS[shown.provider].name;
    const left = state.peer.side === 'left';
    if (send) return sendShare(shown.tabId, shown.provider, expect, left ? t('Sent to {name}, now on the left.', { name }) : t('Sent to {name}, now on the right.', { name }));
    if (files.length) await deliver(sourceId, shown.tabId, text, expect, { files, send: false });
    else await insertWhenReady(shown.tabId, text, expect);
    return { ok: true, message: left ? t('{name} is on the left with the draft ready. Review it, then send it there.', { name })
      : t('{name} is on the right with the draft ready. Review it, then send it there.', { name }) };
  }

  async function splitPair(sourceId, { peerId, peerProvider }, menu) {
    const state = await manager.context(sourceId);
    if (!state.native || !state.peer) throw new Error(t('Open two supported AI chats in Chrome Split View to use {menu}.', { menu: menuName(menu) }));
    if (state.peer.id !== peerId || (peerProvider && state.peer.provider !== peerProvider)) {
      throw new Error(t('The other pane changed. Open {menu} again in the current split.', { menu: menuName(menu) }));
    }
    chosen(state, [peerId]);
    const peer = await manager.supported(peerId);
    if (peer.splitViewId !== state.source.splitViewId || peer.windowId !== state.source.windowId || providerFor(peer.url) !== state.peer.provider) {
      throw new Error(t('The split changed. Open {menu} again.', { menu: menuName(menu) }));
    }
    return [state.source, peer].map((tab, index) => ({
      id: tab.id, url: tab.url, split: tab.splitViewId, windowId: tab.windowId,
      name: index ? state.peer.name : PROVIDERS[state.provider].name,
      side: index ? state.peer.side : state.side,
    }));
  }

  function reviewResults(pair, { read, reviewId }) {
    return Promise.all(pair.map((chat, i) => ask(chat.id, 'ASB_REVIEW_RESULT', { peerId: pair[1 - i].id, read, ...(reviewId && { reviewId }) })));
  }

  async function compareStatus(sourceId, choice, menu = 'Compare') {
    try {
      const pair = await splitPair(sourceId, choice, menu);
      const [statuses, reviews] = await Promise.all([
        Promise.all(pair.map(chat => ask(chat.id, 'ASB_COMPARE_STATUS'))),
        menu === 'Cross-review' ? reviewResults(pair, { read: false }) : [],
      ]);
      const pending = reviews.find(review => review.pending);
      if (pending) return { ok: true, ready: false, message: pending.message || t('Send both review drafts and wait for both critiques to finish.') };
      const unavailable = statuses.find(status => !status.ready || !status.turn);
      if (unavailable) return { ok: true, ready: false, message: unavailable.message || t('Wait for both assistants to finish, then open {menu} again.', { menu: menuName(menu) }) };
      const turns = statuses.map(status => status.turn);
      const status = { ok: true, ready: true, turns };
      if (reviews.length && reviews[0].reviewId && reviews.every((review, i) =>
        review.ready && review.reviewId === reviews[0].reviewId && review.turn === turns[i])) {
        status.revision = { reviewId: reviews[0].reviewId, turns };
      }
      return status;
    } catch (error) { return { ok: true, ready: false, message: error.message }; }
  }

  async function readAnswers(pair, turns, menu) {
    const answers = await Promise.all(pair.map(chat => ask(chat.id, 'ASB_COMPARE_READ')));
    for (const [i, answer] of answers.entries()) {
      if (!answer.turn || answer.url !== pair[i].url || (turns && turns[i] !== answer.turn)) {
        throw new Error(t('An answer or conversation changed. Open {menu} again.', { menu: menuName(menu) }));
      }
      if (typeof answer.text !== 'string' || !answer.text.trim()) throw new Error(t('{name} has no answer text to use.', { name: pair[i].name }));
    }
    return answers;
  }

  async function verifyPair(pair, choice, menu) {
    const current = await splitPair(pair[0].id, choice, menu);
    if (current.some((chat, i) => chat.url !== pair[i].url || chat.split !== pair[i].split || chat.windowId !== pair[i].windowId || chat.side !== pair[i].side)) {
      throw new Error(t('The split changed. Open {menu} again.', { menu: menuName(menu) }));
    }
  }

  async function verifyAnswers(pair, choice, answers, menu) {
    await verifyPair(pair, choice, menu);
    await Promise.all(pair.map((chat, i) => ask(chat.id, 'ASB_COMPARE_CHECK', answers[i])));
  }

  async function compare(sourceId, choice, settings) {
    const pair = await splitPair(sourceId, choice, 'Compare');
    const reviewer = pair.findIndex(chat => chat.id === choice.targetId);
    if (reviewer < 0) throw new Error(t('Choose one of the two chats in this split to compare the answers.'));
    const answers = await readAnswers(pair, choice.turns, 'Compare');
    const sections = pair.map((chat, i) => `${paneLabel(chat)}\n${answers[i].text}`);
    if (pair[0].side === 'right') sections.reverse();
    const text = composeComparison(settings, { answers: sections.join('\n\n') }, i18n.language);
    if (text.length > 60000) throw new Error(t('The comparison exceeds 60,000 characters. Shorten your comparison instructions or share selected excerpts.'));
    const verifyTarget = () => verifyAnswers(pair, choice, answers, 'Compare');
    const target = pair[reviewer];
    const send = settings.shareMode === 'send';
    await deliver(sourceId, target.id, text, undefined, { send, answer: answers[reviewer], verifyTarget });
    return { ok: true, message: send ? t('Comparison sent to {name}.', { name: target.name }) : t('Comparison draft added to {name}. Review it, then send it there.', { name: target.name }) };
  }

  function requireReviewTurns(turns) {
    if (!Array.isArray(turns) || turns.length !== 2 || !turns.every(turn => typeof turn === 'string' && turn)) {
      throw new Error(t('Open Cross-review again to choose the current answers.'));
    }
  }

  async function crossReview(sourceId, choice, prompt, settings, extra = '') {
    requireReviewTurns(choice.turns);
    const pair = await splitPair(sourceId, choice, 'Cross-review');
    const answers = await readAnswers(pair, choice.turns, 'Cross-review');
    const reviewId = crypto.randomUUID();
    const instructions = [settings.reviewGuidance, prompt, extra]
      .map(value => value.trim().replace(/\r\n?/g, '\n')).filter(Boolean).join('\n\n') + '\n\n';
    const prompts = pair.map((_, i) => {
      const peer = pair[1 - i];
      const heading = peer.side === 'left' ? t('Answer from {name} (left pane)', { name: peer.name }) : t('Answer from {name} (right pane)', { name: peer.name });
      const text = instructions + `${heading}\n${answers[1 - i].text}`;
      validateText(text);
      return text;
    });
    const sendNow = settings.shareMode === 'send';
    const result = await deliverMany({
      ids: pair.map(chat => chat.id), labels: pair.map(paneLabel), requestId: reviewId, sendNow,
      payload: (_id, type, i) => ({
        requestId: reviewId, text: prompts[i], attachments: 0, source: false,
        ...(type === 'ASB_PREPARE' && { answer: answers[i], draftOnly: !sendNow, review: { reviewId, peerId: pair[1 - i].id, quotedStart: instructions.length } }),
      }),
      verify: () => verifyAnswers(pair, choice, answers, 'Cross-review'),
    });
    if (!result.partial) result.message = sendNow
      ? t('Cross-review sent to both chats.')
      : t('Cross-review drafts are ready in both panes.');
    return result;
  }

  async function revise(sourceId, choice, reviewId, settings) {
    requireReviewTurns(choice.turns);
    if (typeof reviewId !== 'string' || !reviewId || reviewId.length > 160) throw new Error(t('Open a completed Cross-review to revise an answer.'));
    const pair = await splitPair(sourceId, choice, 'Cross-review');
    const i = pair.findIndex(chat => chat.id === choice.targetId);
    if (i < 0) throw new Error(t('Choose the answer to revise in one of these two chats.'));
    const reviews = await reviewResults(pair, { read: true, reviewId });
    if (reviews.some((review, index) => !review.ready || review.reviewId !== reviewId || review.turn !== choice.turns[index] ||
      review.url !== pair[index].url || typeof review.text !== 'string' || !review.text.trim() ||
      typeof review.original !== 'string' || !review.original.trim())) {
      throw new Error(t('The two critiques for this review are no longer current. Open Cross-review again.'));
    }
    const peer = pair[1 - i], target = pair[i];
    const original = target.side === 'left' ? t('Your original answer ({name}, left pane)', { name: target.name })
      : t('Your original answer ({name}, right pane)', { name: target.name });
    const critique = peer.side === 'left' ? t('Critique of your answer from {name} (left pane)', { name: peer.name })
      : t('Critique of your answer from {name} (right pane)', { name: peer.name });
    const text = [
      t('Revise your original answer using the critique below. Draw on your own critique of the other answer where useful. Use your own judgment about which suggestions the evidence supports, correct any errors, and give a standalone revised answer.'),
      `${original}\n${reviews[i].original}`,
      `${critique}\n${reviews[1 - i].text}`,
    ].join('\n\n');
    validateText(text);
    const snapshots = reviews.map(({ turn, url, text }) => ({ turn, url, text }));
    const send = settings.shareMode === 'send';
    await deliver(sourceId, target.id, text, undefined, {
      send, answer: snapshots[i], verifyTarget: () => verifyAnswers(pair, choice, snapshots, 'Cross-review'),
    });
    return { ok: true, message: send ? t('Revision requested from {name}.', { name: target.name }) : t('Revision draft added to {name}.', { name: target.name }) };
  }

  async function show(sourceId, { targetId, provider } = {}) {
    const state = await manager.context(sourceId);
    if (!state.peer) throw new Error(t('Put this chat in Split View to open another assistant beside it.'));
    const { message } = await manager.replace(state.peer.id, { tabId: targetId, provider });
    return { ok: true, message };
  }

  return { send, share, shareWithPeer, summarize, show, compare, compareStatus, crossReview, revise, locked };
}

export function validateText(text, { allowEmpty = false } = {}) {
  if (typeof text !== 'string' || (!allowEmpty && !text.trim())) throw new Error(t('Write a message in the chat composer first.'));
  if (text.length > 60000) throw new Error(t('Keep shared text under 60,000 characters for this prototype.'));
}

export function validateFiles(files) {
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error(t('Share up to 10 files at a time. Nothing was sent.'));
  let total = 0;
  for (const file of files) {
    if (!file || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255
      || typeof file.data !== 'string' || file.data.length > 4 * Math.ceil(20 * 1024 * 1024 / 3)
      || file.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
      || (file.type !== undefined && (typeof file.type !== 'string' || file.type.length > 200))) {
      throw new Error(t('A shared file is invalid or exceeds 20 MB. Nothing was sent.'));
    }
    const bytes = file.data.length / 4 * 3 - (file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0);
    total += bytes;
    if (bytes > 20 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new Error(t('Shared files must fit within 20 MB each and 32 MB in total. Nothing was sent.'));
  }
}
