import './i18n.js';
import { PROVIDERS, providerFor, describe, hasSplit, conversationKey } from './providers.js';

const { t } = globalThis.AISplitI18n;

export function createTabManager(api) {
  const canManageSplit = () => typeof api.tabs.createSplit === 'function' && typeof api.tabs.unsplit === 'function';
  const tabMemoryKey = windowId => `recent:${windowId}`;
  const urlMemoryKey = windowId => `urls:${windowId}`;
  const otherSide = side => side === 'left' ? 'right' : 'left';
  const stored = async key => (await api.storage.session.get(key))[key] || {};

  async function supported(id) {
    if (!Number.isInteger(id)) throw new Error(t('Choose an AI chat tab.'));
    const tab = await api.tabs.get(id);
    if (!providerFor(tab.url)) throw new Error(t('Open ChatGPT, Claude, Gemini, or Grok first.'));
    if (tab.pendingUrl && tab.pendingUrl !== tab.url) throw new Error(t('Wait for the chat tab to finish navigating.'));
    return tab;
  }

  async function waitForNewTab(id, provider, stillLoading = t('The new assistant is still loading. Your original split is unchanged. Try again once it loads.')) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const tab = await api.tabs.get(id);
      if (providerFor(tab.url) === provider && (!tab.pendingUrl || tab.pendingUrl === tab.url)) return tab;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(stillLoading);
  }

  // Opens an assistant in a background tab. Beside an open chat it takes that chat's window,
  // pinned state and tab group, which Chrome requires of the two tabs in a split.
  async function openChat(provider, beside, windowId) {
    const tab = await api.tabs.create({
      url: PROVIDERS[provider].url, windowId: beside ? beside.windowId : windowId, active: false, ...(beside && { pinned: beside.pinned }),
    });
    if (beside && beside.groupId !== -1) await api.tabs.group({ tabIds: [tab.id], groupId: beside.groupId });
    return tab;
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
    if (a.id === b.id) throw new Error(t('Choose two different tabs.'));
    if (a.windowId !== b.windowId) throw new Error(t('Both chats must be in the same Chrome window.'));
    if (a.pinned !== b.pinned || a.groupId !== b.groupId) {
      throw new Error(t('Use tabs in the same tab group with the same pinned state.'));
    }
  }

  // Chrome uses tab-strip order, not the order of IDs passed to createSplit.
  async function arrange(leftId, rightId) {
    const left = await supported(leftId);
    const right = await supported(rightId);
    compatible(left, right);
    if (hasSplit(left) || hasSplit(right)) throw new Error(t('A chosen tab is already in another split.'));
    if (right.index !== left.index + 1) {
      await api.tabs.move(rightId, { index: right.index < left.index ? left.index : left.index + 1 });
    }
    const [a, b] = await Promise.all([supported(leftId), supported(rightId)]);
    compatible(a, b);
    if (b.index !== a.index + 1) throw new Error(t('Tabs moved during setup. Try again once they stop moving.'));
    return api.tabs.createSplit([leftId, rightId]);
  }

  // Each side is the ID of an open chat's tab, or { provider } for an assistant to open first.
  async function pair(leftChoice, rightChoice, windowId) {
    const choices = [leftChoice, rightChoice];
    const isNew = choice => typeof choice !== 'number';
    if (choices.some(choice => isNew(choice) && !Object.hasOwn(PROVIDERS, choice?.provider))) throw new Error(t('Choose a supported assistant.'));
    // Everything that could refuse the split is checked before a tab is opened.
    const open = await Promise.all(choices.map(choice => isNew(choice) ? null : supported(choice)));
    const chosen = open.filter(Boolean);
    if (chosen.length === 2) {
      const [left, right] = chosen;
      if (left.id === right.id || left.windowId !== right.windowId) throw new Error(t('Choose two different AI tabs in this window.'));
      if (hasSplit(left) && left.splitViewId === right.splitViewId) return { ok: true, message: t('These chats are already side by side.') };
    }
    if (!canManageSplit()) throw new Error(t('This Chrome version can’t create splits for extensions. Right-click a chat tab and use Chrome’s Split View option.'));
    if (chosen.some(hasSplit)) throw new Error(t('Remove the chosen tabs from their existing splits first.'));
    if (chosen.length === 2) compatible(...chosen);

    const tabs = [];
    for (const [side, choice] of choices.entries()) tabs.push(open[side] || await openChat(choice.provider, chosen[0], windowId));
    const [left, right] = await Promise.all(tabs.map((tab, side) => open[side] ? tab
      : waitForNewTab(tab.id, choices[side].provider, t('The new chat has not finished opening. If it asks you to sign in, do that first, then create the split again.'))));
    if (!open[0] && open[1]) {
      // arrange() brings the right tab to the left one. Here the right one is the chat that was
      // already open, so the new tab goes to it instead and that chat keeps its place.
      const [opened, kept] = await Promise.all([api.tabs.get(left.id), api.tabs.get(right.id)]);
      await api.tabs.move(opened.id, { index: opened.index < kept.index ? kept.index - 1 : kept.index });
    }
    await arrange(left.id, right.id);
    await remember([left, right]);
    await api.tabs.update(left.id, { active: true });
    return { ok: true, message: t('Split View ready.') };
  }

  async function navigatePane(state, provider, incoming) {
    const { source } = state;
    const name = PROVIDERS[provider].name, outgoing = PROVIDERS[state.provider].name;
    const key = urlMemoryKey(source.windowId);
    const urls = await stored(key);
    const destination = incoming?.url || (providerFor(urls[provider]) === provider ? urls[provider] : PROVIDERS[provider].url);
    if (destination === source.url) return { ok: true, tabId: source.id, provider, message: t('{name} is already there.', { name }) };
    // Conversation URLs stay in browser-session storage, never chat transcripts.
    if (conversationKey(source.url) || !conversationKey(urls[state.provider])) {
      await api.storage.session.set({ [key]: { ...urls, [state.provider]: source.url } });
    }
    const fresh = await context(source.id);
    if (fresh.peer?.id !== state.peer.id || fresh.source.splitViewId !== source.splitViewId || fresh.source.url !== source.url) {
      throw new Error(t('The split changed while switching. Try again from the current split.'));
    }
    let ready;
    try { ready = await api.tabs.sendMessage(source.id, { type: 'ASB_CAN_LEAVE' }, { frameId: 0 }); }
    catch { throw new Error(t('Refresh {name} before switching it.', { name: outgoing })); }
    if (!ready?.ok) throw new Error(ready?.error || t('Finish or clear {name}’s draft before switching.', { name: outgoing }));
    await api.tabs.update(source.id, { url: destination });
    return {
      ok: true, tabId: source.id, provider, previousPage: ready.page,
      message: state.side === 'left'
        ? t('{name} is opening on the left. {previous}’s chat is remembered here.', { name, previous: outgoing })
        : t('{name} is opening on the right. {previous}’s chat is remembered here.', { name, previous: outgoing }),
    };
  }

  async function swapIn(state, provider, incoming) {
    const { source } = state;
    const name = PROVIDERS[provider].name;
    const peer = await supported(state.peer.id);
    if (!incoming) {
      if (state.provider === provider) return { ok: true, tabId: source.id, provider, message: t('{name} is already there.', { name }) };
      const all = await api.tabs.query({ windowId: source.windowId });
      const remembered = await stored(tabMemoryKey(source.windowId));
      const candidates = all.filter(tab => tab.id !== source.id && tab.id !== peer.id &&
        providerFor(tab.url) === provider && !hasSplit(tab) &&
        tab.pinned === source.pinned && tab.groupId === source.groupId);
      candidates.sort((a, b) => Number(b.id === remembered[provider]) - Number(a.id === remembered[provider]) ||
        (b.lastAccessed || 0) - (a.lastAccessed || 0));
      incoming = candidates[0];
      if (!incoming) incoming = await waitForNewTab((await openChat(provider, source)).id, provider);
    } else if (hasSplit(incoming)) {
      throw new Error(t('That chat is in another split. Remove it from that split first.'));
    }
    compatible(peer, incoming);
    await remember([source, incoming]);
    const [freshSource, freshPeer, freshIncoming] = await Promise.all([
      supported(source.id), supported(peer.id), supported(incoming.id),
    ]);
    if (freshSource.splitViewId !== source.splitViewId || freshPeer.splitViewId !== source.splitViewId || hasSplit(freshIncoming)
      || (freshSource.index < freshPeer.index) !== (source.index < peer.index)) {
      throw new Error(t('The split changed while switching. Try again from the current split.'));
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
      throw new Error(restored
        ? t('Could not switch: {error}. The original split was restored.', { error: error.message })
        : t('Could not switch: {error}. Your chats are still open; restore the split using Chrome’s tab menu.', { error: error.message }));
    }
    await api.tabs.update(incoming.id, { active: true });
    return {
      ok: true, tabId: incoming.id, provider,
      message: state.side === 'left'
        ? t('{name} is now on the left. The previous chat stays open in its tab.', { name })
        : t('{name} is now on the right. The previous chat stays open in its tab.', { name }),
    };
  }

  // Pairs two assistants by name. An open chat that is not in a split is used as it is;
  // an assistant with no such chat is opened.
  async function pairAssistants(leftProvider, rightProvider, windowId) {
    if (![leftProvider, rightProvider].every(provider => Object.hasOwn(PROVIDERS, provider))) throw new Error(t('Choose a supported assistant.'));
    const tabs = await api.tabs.query({ windowId });
    const active = tabs.find(tab => tab.active);
    if (active && hasSplit(active)) {
      const shown = tabs.filter(tab => tab.splitViewId === active.splitViewId).map(tab => providerFor(tab.url)).sort();
      if (shown.length === 2 && shown.join() === [leftProvider, rightProvider].sort().join()) {
        return { ok: true, message: t('These chats are already side by side.') };
      }
    }
    // The chat in front comes first, then the one used most recently.
    const free = tabs.filter(tab => !hasSplit(tab) && !(tab.pendingUrl && tab.pendingUrl !== tab.url))
      .sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0) || a.index - b.index);
    const left = free.find(tab => providerFor(tab.url) === leftProvider);
    // Chrome only splits tabs with the same pinned state and tab group, so a chat elsewhere stays where it is.
    const right = free.find(tab => providerFor(tab.url) === rightProvider && tab.id !== left?.id
      && (!left || (tab.pinned === left.pinned && tab.groupId === left.groupId)));
    return pair(left ? left.id : { provider: leftProvider }, right ? right.id : { provider: rightProvider }, windowId);
  }

  // Replaces the chat shown in one pane with another assistant or a specific open chat.
  async function replace(paneId, { provider, tabId } = {}) {
    const state = await context(paneId);
    if (!state.peer) throw new Error(t('Put two AI chats side by side in Chrome’s Split View first.'));
    let incoming = null;
    if (tabId !== undefined) {
      incoming = await supported(tabId);
      if (incoming.windowId !== state.source.windowId) throw new Error(t('Choose a chat in this window.'));
      if (incoming.id === paneId) return { ok: true, tabId: paneId, provider: state.provider, message: t('That chat is already there.') };
      if (incoming.id === state.peer.id) throw new Error(t('That chat is already on the other side.'));
      provider = providerFor(incoming.url);
    } else if (!Object.hasOwn(PROVIDERS, provider)) {
      throw new Error(t('Choose a supported assistant.'));
    }
    return canManageSplit() ? swapIn(state, provider, incoming) : navigatePane(state, provider, incoming);
  }

  return { context, pair, pairAssistants, replace, supported, canManageSplit };
}
