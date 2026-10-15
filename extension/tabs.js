import { PROVIDERS, providerFor, describe, hasSplit, conversationKey } from './providers.js';

export function createTabManager(api) {
  const canManageSplit = () => typeof api.tabs.createSplit === 'function' && typeof api.tabs.unsplit === 'function';
  const tabMemoryKey = windowId => `recent:${windowId}`;
  const urlMemoryKey = windowId => `urls:${windowId}`;
  const otherSide = side => side === 'left' ? 'right' : 'left';
  const stored = async key => (await api.storage.session.get(key))[key] || {};

  async function supported(id) {
    if (!Number.isInteger(id)) throw new Error('Choose an AI chat tab.');
    const tab = await api.tabs.get(id);
    if (!providerFor(tab.url)) throw new Error('Open ChatGPT, Claude, Gemini, or Grok first.');
    if (tab.pendingUrl && tab.pendingUrl !== tab.url) throw new Error('Wait for the chat tab to finish navigating.');
    return tab;
  }

  async function waitForNewTab(id, provider) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const tab = await api.tabs.get(id);
      if (providerFor(tab.url) === provider && (!tab.pendingUrl || tab.pendingUrl === tab.url)) return tab;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('The new assistant is still loading. Your original split is unchanged. Try again once it loads.');
  }

  async function context(id) {
    const source = await supported(id);
    const tabs = await api.tabs.query({ windowId: source.windowId });
    const peerTab = hasSplit(source) ? tabs.find(tab => tab.id !== id && tab.splitViewId === source.splitViewId) : undefined;
    const peer = describe(peerTab);
    const side = peer ? (source.index < peerTab.index ? 'left' : 'right') : null;
    const seen = new Set([conversationKey(source.url)].filter(Boolean));
    const chats = [];
    // The visible peer comes first so it wins over a hidden copy of the same conversation.
    for (const tab of [peerTab, ...tabs.filter(tab => tab !== peerTab)]) {
      const chat = tab && tab.id !== id && describe(tab);
      if (!chat) continue;
      const key = conversationKey(tab.url);
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      chats.push({ ...chat, side: tab === peerTab ? otherSide(side) : null });
    }
    const urls = canManageSplit() ? {} : await stored(urlMemoryKey(source.windowId));
    const present = new Set([providerFor(source.url), ...chats.map(chat => chat.provider)]);
    const closed = Object.keys(PROVIDERS).flatMap(provider => {
      const key = conversationKey(urls[provider]);
      const remembered = !!key && key.startsWith(`${provider}:`) && !seen.has(key);
      return remembered || !present.has(provider) ? [{ provider, name: PROVIDERS[provider].name, remembered }] : [];
    });
    return {
      ok: true, source, selfId: id, provider: providerFor(source.url),
      native: hasSplit(source), side, peer: chats.find(chat => chat.side) || null,
      canManageSplit: canManageSplit(), switchMode: canManageSplit() ? 'tabs' : 'navigate',
      chats, closed,
    };
  }

  async function remember(tabs) {
    const key = tabMemoryKey(tabs[0].windowId);
    const recent = await stored(key);
    for (const tab of tabs) recent[providerFor(tab.url)] = tab.id;
    await api.storage.session.set({ [key]: recent });
  }

  function compatible(a, b) {
    if (a.id === b.id) throw new Error('Choose two different tabs.');
    if (a.windowId !== b.windowId) throw new Error('Both chats must be in the same Chrome window.');
    if (a.pinned !== b.pinned || a.groupId !== b.groupId) {
      throw new Error('Use tabs in the same tab group with the same pinned state.');
    }
  }

  // Chrome uses tab-strip order, not the order of IDs passed to createSplit.
  async function arrange(leftId, rightId) {
    const left = await supported(leftId);
    const right = await supported(rightId);
    compatible(left, right);
    if (hasSplit(left) || hasSplit(right)) throw new Error('A chosen tab is already in another split.');
    if (right.index !== left.index + 1) {
      await api.tabs.move(rightId, { index: right.index < left.index ? left.index : left.index + 1 });
    }
    const [a, b] = await Promise.all([supported(leftId), supported(rightId)]);
    compatible(a, b);
    if (b.index !== a.index + 1) throw new Error('Tabs moved during setup. Try again once they stop moving.');
    return api.tabs.createSplit([leftId, rightId]);
  }

  async function pair(leftId, rightId) {
    const [left, right] = await Promise.all([supported(leftId), supported(rightId)]);
    if (left.id === right.id || left.windowId !== right.windowId) throw new Error('Choose two different AI tabs in this window.');
    if (hasSplit(left) && left.splitViewId === right.splitViewId) return { ok: true, message: 'These chats are already side by side.' };
    if (!canManageSplit()) throw new Error('This Chrome version can’t create splits for extensions. Right-click a chat tab and use Chrome’s Split View option.');
    if (hasSplit(left) || hasSplit(right)) throw new Error('Remove the chosen tabs from their existing splits first.');
    compatible(left, right);
    await arrange(leftId, rightId);
    await remember([left, right]);
    await api.tabs.update(leftId, { active: true });
    return { ok: true, message: 'Split View ready.' };
  }

  async function navigatePane(state, provider, incoming) {
    const { source } = state;
    const name = PROVIDERS[provider].name, outgoing = PROVIDERS[state.provider].name;
    const key = urlMemoryKey(source.windowId);
    const urls = await stored(key);
    const destination = incoming?.url || (providerFor(urls[provider]) === provider ? urls[provider] : PROVIDERS[provider].url);
    if (destination === source.url) return { ok: true, tabId: source.id, provider, message: `${name} is already there.` };
    // Conversation URLs stay in browser-session storage, never chat transcripts.
    if (conversationKey(source.url) || !conversationKey(urls[state.provider])) {
      await api.storage.session.set({ [key]: { ...urls, [state.provider]: source.url } });
    }
    const fresh = await context(source.id);
    if (fresh.peer?.id !== state.peer.id || fresh.source.splitViewId !== source.splitViewId || fresh.source.url !== source.url) {
      throw new Error('The split changed while switching. Try again from the current split.');
    }
    let ready;
    try { ready = await api.tabs.sendMessage(source.id, { type: 'ASB_CAN_LEAVE' }, { frameId: 0 }); }
    catch { throw new Error(`Refresh ${outgoing} before switching it.`); }
    if (!ready?.ok) throw new Error(ready?.error || `Finish or clear ${outgoing}’s draft before switching.`);
    await api.tabs.update(source.id, { url: destination });
    return {
      ok: true, tabId: source.id, provider, previousPage: ready.page,
      message: `${name} is opening on the ${state.side}. ${outgoing}’s chat is remembered here.`,
    };
  }

  async function swapIn(state, provider, incoming) {
    const { source } = state;
    const name = PROVIDERS[provider].name;
    const peer = await supported(state.peer.id);
    if (!incoming) {
      if (state.provider === provider) return { ok: true, tabId: source.id, provider, message: `${name} is already there.` };
      const all = await api.tabs.query({ windowId: source.windowId });
      const remembered = await stored(tabMemoryKey(source.windowId));
      const candidates = all.filter(tab => tab.id !== source.id && tab.id !== peer.id &&
        providerFor(tab.url) === provider && !hasSplit(tab) &&
        tab.pinned === source.pinned && tab.groupId === source.groupId);
      candidates.sort((a, b) => Number(b.id === remembered[provider]) - Number(a.id === remembered[provider]) ||
        (b.lastAccessed || 0) - (a.lastAccessed || 0));
      incoming = candidates[0];
      if (!incoming) {
        incoming = await api.tabs.create({ url: PROVIDERS[provider].url, windowId: source.windowId, active: false, pinned: source.pinned });
        if (source.groupId !== -1) await api.tabs.group({ tabIds: [incoming.id], groupId: source.groupId });
        incoming = await waitForNewTab(incoming.id, provider);
      }
    } else if (hasSplit(incoming)) {
      throw new Error('That chat is in another split. Remove it from that split first.');
    }
    compatible(peer, incoming);
    await remember([source, incoming]);
    const [freshSource, freshPeer, freshIncoming] = await Promise.all([
      supported(source.id), supported(peer.id), supported(incoming.id),
    ]);
    if (freshSource.splitViewId !== source.splitViewId || freshPeer.splitViewId !== source.splitViewId || hasSplit(freshIncoming)
      || (freshSource.index < freshPeer.index) !== (source.index < peer.index)) {
      throw new Error('The split changed while switching. Try again from the current split.');
    }
    compatible(freshSource, freshPeer);
    compatible(freshPeer, freshIncoming);
    const leftSide = freshSource.index < freshPeer.index;
    await api.tabs.unsplit(source.splitViewId);
    try {
      await arrange(leftSide ? incoming.id : peer.id, leftSide ? peer.id : incoming.id);
    } catch (error) {
      let restored = false;
      try {
        await arrange(leftSide ? source.id : peer.id, leftSide ? peer.id : source.id);
        restored = true;
      } catch { /* Both conversation tabs remain open even if Chrome cannot restore the layout. */ }
      throw new Error(`Could not switch: ${error.message}. ${restored ? 'The original split was restored.' : 'Your chats are still open; restore the split using Chrome’s tab menu.'}`);
    }
    await api.tabs.update(incoming.id, { active: true });
    return { ok: true, tabId: incoming.id, provider, message: `${name} is now on the ${state.side}. The previous chat stays open in its tab.` };
  }

  // Replaces the chat shown in one pane with another assistant or a specific open chat.
  async function replace(paneId, { provider, tabId } = {}) {
    const state = await context(paneId);
    if (!state.peer) throw new Error('Put two AI chats side by side in Chrome’s Split View first.');
    let incoming = null;
    if (tabId !== undefined) {
      incoming = await supported(tabId);
      if (incoming.windowId !== state.source.windowId) throw new Error('Choose a chat in this window.');
      if (incoming.id === paneId) return { ok: true, tabId: paneId, provider: state.provider, message: 'That chat is already there.' };
      if (incoming.id === state.peer.id) throw new Error('That chat is already on the other side.');
      provider = providerFor(incoming.url);
    } else if (!Object.hasOwn(PROVIDERS, provider)) {
      throw new Error('Choose a supported assistant.');
    }
    return canManageSplit() ? swapIn(state, provider, incoming) : navigatePane(state, provider, incoming);
  }

  return { context, pair, replace, supported, canManageSplit };
}
