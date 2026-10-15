import { PROVIDERS } from './providers.js';

const MAX_TARGETS = 8;
const MAX_FILES = 10;

export function createBridge(api, manager, { retryDelay = 500, retryLimit = 40 } = {}) {
  const busyWindows = new Set();

  async function locked(windowId, action) {
    if (busyWindows.has(windowId)) throw new Error('Another bridge action is running in this window. Wait for it to finish.');
    busyWindows.add(windowId);
    try { return await action(); } finally { busyWindows.delete(windowId); }
  }

  async function ask(tabId, type, payload = {}) {
    let result;
    try { result = await api.tabs.sendMessage(tabId, { type, ...payload }, { frameId: 0 }); }
    catch { throw Object.assign(new Error('Chat connection unavailable. Refresh that AI tab after installing or updating the extension.'), { retry: true }); }
    if (!result?.ok) throw Object.assign(new Error(result?.error || 'The chat did not accept the action.'), { retry: !!result?.retry });
    return result;
  }

  function chosen(state, targetIds) {
    if (!Array.isArray(targetIds) || !targetIds.length) throw new Error('Choose at least one other chat.');
    if (targetIds.length > MAX_TARGETS || new Set(targetIds).size !== targetIds.length) throw new Error('Choose each chat once.');
    return targetIds.map(id => {
      const chat = state.chats.find(item => item.id === id);
      if (!chat) throw new Error('A chosen chat closed or changed. Review the list and try again.');
      if (chat.asleep) throw new Error(`${chat.name} is asleep. Open its tab once to wake it, then try again.`);
      if (chat.loading) throw new Error(`${chat.name} is still loading. Wait for the chat tab to finish navigating.`);
      return chat;
    });
  }

  async function send(sourceId, targetIds) {
    const state = await manager.context(sourceId);
    const targets = chosen(state, targetIds);
    const ids = [sourceId, ...targets.map(chat => chat.id)];
    const labels = [PROVIDERS[state.provider].name, ...targets.map(chat => chat.name)];
    const { text, files = [], notCopied = [] } = await ask(sourceId, 'ASB_READ_DRAFT');
    if (!Array.isArray(files) || !Array.isArray(notCopied) || files.length > MAX_FILES) throw new Error('The attachments could not be read. Nothing was sent.');
    if (notCopied.length) {
      throw new Error(`Nothing was sent. ${list(notCopied)} could not be copied. Remove and reattach those files in this chat, then try again. Both chats need the same context.`);
    }
    validateText(text, { allowEmpty: files.length > 0 });
    const requestId = crypto.randomUUID();
    // Copies go out once, when staging; the source keeps and sends its own attachments.
    const payload = (id, type) => id === sourceId ? { requestId, text, source: true }
      : { requestId, text, source: false, attachments: files.length, ...(type === 'ASB_STAGE' ? { files } : {}) };
    async function phase(type) {
      // Wait for every chat even when one fails before cancelling any of them.
      const results = await Promise.allSettled(ids.map(id => ask(id, type, payload(id, type))));
      const errors = results.flatMap((r, i) => r.status === 'rejected' ? [`${labels[i]}: ${r.reason.message}`] : []);
      if (errors.length) throw new Error(errors.join(' '));
    }
    try {
      await phase('ASB_PREPARE');
      await phase('ASB_STAGE');
      await phase('ASB_VALIDATE');
      chosen(await manager.context(sourceId), targetIds);
    } catch (error) {
      const cleanup = await Promise.allSettled(ids.map(id => ask(id, 'ASB_CANCEL', { requestId })));
      const left = labels.filter((_, i) => cleanup[i].value?.leftAttachments);
      throw new Error(`Nothing was sent. ${error.message}${left.length ? ` Remove the copied attachments still in ${list(left)}.` : ''}`);
    }
    // Separate websites cannot be submitted atomically. Never retry a click automatically.
    const results = await Promise.allSettled(ids.map(id => ask(id, 'ASB_COMMIT', { requestId })));
    await Promise.allSettled(ids.map(id => ask(id, 'ASB_CANCEL', { requestId })));
    const failed = results.flatMap((result, i) => result.status === 'rejected'
      ? [`${labels[i]}: ${result.reason.message} Delivery is unconfirmed; check this chat before sending again.`] : []);
    const sent = labels.filter((_, i) => results[i].status === 'fulfilled');
    return {
      ok: true, partial: failed.length > 0,
      message: failed.length ? `${sent.length ? `Sent to ${list(sent)}. ` : ''}${failed.join(' ')}` : `Sent to ${list(labels)}.`,
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
    throw new Error(`${lastError.message} The chat opened, but the draft was not added.`);
  }

  // Sends to one chat with the same staged checks as Send both; the source chat is never touched.
  async function deliver(sourceId, tabId, text, expect) {
    const requestId = crypto.randomUUID();
    const payload = { requestId, text, source: false };
    try {
      for (let attempt = 1; ; attempt++) {
        try { await ask(tabId, 'ASB_PREPARE', { ...payload, ...expect }); break; }
        catch (error) {
          // Only a pane that was just opened is worth waiting for.
          if (!expect || !error.retry || attempt >= retryLimit) throw error;
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
      await ask(tabId, 'ASB_STAGE', payload);
      await ask(tabId, 'ASB_VALIDATE', payload);
      chosen(await manager.context(sourceId), [tabId]);
    } catch (error) {
      await ask(tabId, 'ASB_CANCEL', { requestId }).catch(() => {});
      throw new Error(`Nothing was sent. ${error.message}`);
    }
    try { await ask(tabId, 'ASB_COMMIT', { requestId }); }
    catch (error) { throw new Error(`${error.message} Delivery is unconfirmed; check that chat before sending again.`); }
    finally { await ask(tabId, 'ASB_CANCEL', { requestId }).catch(() => {}); }
  }

  async function share(sourceId, { targetId, provider } = {}, text, { send = false } = {}) {
    validateText(text);
    const state = await manager.context(sourceId);
    if (targetId !== undefined) {
      const chat = state.chats.find(item => item.id === targetId);
      if (!chat) throw new Error('That chat closed or changed. Open Share again.');
      if (chat.side || !state.peer) {
        if (chat.asleep) throw new Error(`${chat.name} is asleep. Open its tab once to wake it, then try again.`);
        const where = chat.side ? '' : ' in its tab';
        if (send) {
          await deliver(sourceId, chat.id, text);
          return { ok: true, message: `Sent to ${chat.name}${where}.` };
        }
        await ask(chat.id, 'ASB_INSERT', { text });
        return { ok: true, message: `Draft added to ${chat.name}${where}. Review it, then send it there.` };
      }
    } else if (!Object.hasOwn(PROVIDERS, provider)) {
      throw new Error('Choose a supported assistant.');
    } else if (!state.peer) {
      throw new Error('Put this chat in Split View to open another assistant beside it.');
    }
    const shown = await manager.replace(state.peer.id, { tabId: targetId, provider });
    const expect = { provider: shown.provider, notPage: shown.previousPage };
    const name = PROVIDERS[shown.provider].name;
    if (send) {
      await deliver(sourceId, shown.tabId, text, expect);
      return { ok: true, message: `Sent to ${name}, now on the ${state.peer.side}.` };
    }
    await insertWhenReady(shown.tabId, text, expect);
    return { ok: true, message: `${name} is on the ${state.peer.side} with the draft ready. Review it, then send it there.` };
  }

  async function show(sourceId, { targetId, provider } = {}) {
    const state = await manager.context(sourceId);
    if (!state.peer) throw new Error('Put this chat in Split View to open another assistant beside it.');
    const { message } = await manager.replace(state.peer.id, { tabId: targetId, provider });
    return { ok: true, message };
  }

  return { send, share, show, locked };
}

function list(names) {
  return names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export function validateText(text, { allowEmpty = false } = {}) {
  if (typeof text !== 'string' || (!allowEmpty && !text.trim())) throw new Error('Write a message in the chat composer first.');
  if (text.length > 60000) throw new Error('Keep shared text under 60,000 characters for this prototype.');
}
