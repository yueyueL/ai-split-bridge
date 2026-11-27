import './i18n.js';
import './i18n-zh-CN.js';
import { createTabManager } from './tabs.js';
import { createBridge, validateFiles } from './bridge.js';
import { describe, providerFor, PROVIDERS } from './providers.js';
import { composeShare, loadSettings } from './settings.js';

const i18n = globalThis.AISplitI18n;
const { t } = i18n;
// The service worker can be started by any request, so each one waits for the saved language.
const languageReady = i18n.follow(chrome);
const manager = createTabManager(chrome);
const bridge = createBridge(chrome, manager);

// The share message and mode are read here, never taken from the page, so a site cannot change what is sent.
async function shareReply(source, choice, reply, files = [], kind = 'reply') {
  if (!['reply', 'prompt', 'conversation'].includes(kind)) throw new Error(t('Choose a prompt, reply, or conversation to share.'));
  validateFiles(files);
  if (typeof reply !== 'string' || (!reply.trim() && !files.length)) throw new Error(t('This selection has no text or files to share.'));
  const settings = await loadSettings(chrome.storage.sync, i18n.language);
  const text = composeShare(settings, { assistant: PROVIDERS[providerFor(source.url)].name, reply, kind }, i18n.language);
  return bridge.share(source.id, choice, text, { send: settings.shareMode === 'send', files });
}

// The last pair made from the popup is kept by assistant, not by conversation.
async function lastPair() {
  const { lastPair: saved } = await chrome.storage.sync.get('lastPair').catch(() => ({}));
  const known = saved && typeof saved === 'object'
    && [saved.left, saved.right].every(provider => typeof provider === 'string' && Object.hasOwn(PROVIDERS, provider));
  return known ? { left: saved.left, right: saved.right } : null;
}

async function handle(message, sender) {
  await languageReady;
  if (!message || typeof message.type !== 'string' || sender.id !== chrome.runtime.id) throw new Error(t('Unsupported request.'));
  if (sender.tab) {
    if (sender.frameId !== 0 || !providerFor(sender.url)) throw new Error(t('Only the main AI chat page can use the bridge.'));
    const source = await manager.supported(sender.tab.id);
    if (providerFor(source.url) !== providerFor(sender.url)) throw new Error(t('The chat changed. Refresh and try again.'));
    if (message.type === 'ASB_CONTEXT') {
      const { source: unused, ...context } = await manager.context(source.id);
      return { ...context, shareMode: (await loadSettings(chrome.storage.sync, i18n.language)).shareMode };
    }
    const compareChoice = { peerId: message.peerId, peerProvider: message.peerProvider, targetId: message.targetId, turns: message.turns };
    if (message.type === 'ASB_COMPARE_STATUS') return bridge.compareStatus(source.id, compareChoice);
    if (message.type === 'ASB_REVIEW_STATUS') return bridge.compareStatus(source.id, compareChoice, 'Cross-review');
    const choice = { targetId: message.targetId, provider: message.provider };
    // The clicked chat is always the source; content scripts cannot act on behalf of another tab.
    return bridge.locked(source.windowId, async () => {
      switch (message.type) {
        case 'ASB_COMPARE':
        case 'ASB_CROSS_REVIEW':
        case 'ASB_REVISE': {
          const settings = await loadSettings(chrome.storage.sync, i18n.language);
          const menu = message.type === 'ASB_COMPARE' ? t('Compare') : t('Cross-review');
          if (settings.shareMode !== message.expectedMode) throw new Error(t('Sharing settings changed. Open {menu} again to confirm the delivery mode.', { menu }));
          if (message.type === 'ASB_CROSS_REVIEW') return bridge.crossReview(source.id, compareChoice, message.action, settings);
          if (message.type === 'ASB_REVISE') return bridge.revise(source.id, compareChoice, message.reviewId, settings);
          return bridge.compare(source.id, compareChoice, settings);
        }
        case 'ASB_SEND': return bridge.send(source.id, message.targetIds);
        case 'ASB_SHARE': return shareReply(source, choice, message.reply, message.files, message.kind);
        case 'ASB_SHOW': return bridge.show(source.id, choice);
        default: throw new Error(t('Unsupported chat action.'));
      }
    });
  }
  if (sender.url !== chrome.runtime.getURL('popup.html')) throw new Error(t('Open the extension popup to manage tabs.'));
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const windowId = tabs[0]?.windowId;
  if (message.type === 'ASB_LIST') {
    const active = tabs.find(tab => tab.active);
    let context = null;
    if (active && providerFor(active.url)) context = await manager.context(active.id);
    return {
      ok: true, tabs: tabs.map(describe).filter(Boolean), activeId: active?.id, canManageSplit: manager.canManageSplit(),
      peer: context?.peer ?? null, lastPair: await lastPair(),
    };
  }
  if (message.type === 'ASB_PAIR') {
    // Each side is an open chat in this window, or an assistant for the extension to open.
    const [left, right] = [[message.leftId, message.leftProvider], [message.rightId, message.rightProvider]].map(([id, provider]) => {
      if (provider !== undefined) {
        if (!Object.hasOwn(PROVIDERS, provider)) throw new Error(t('Unknown assistant.'));
        return { provider };
      }
      if (!tabs.some(tab => tab.id === id)) throw new Error(t('Choose chats in this window.'));
      return id;
    });
    const result = await bridge.locked(windowId, () => manager.pair(left, right, windowId));
    // Remembered for the popup's one-click button. The split stands even if this cannot be saved.
    const [leftProvider, rightProvider] = [left, right].map(side => typeof side === 'number' ? providerFor(tabs.find(tab => tab.id === side).url) : side.provider);
    await chrome.storage.sync.set({ lastPair: { left: leftProvider, right: rightProvider } }).catch(() => {});
    return result;
  }
  if (message.type === 'ASB_PAIR_LAST') {
    const pair = await lastPair();
    if (!pair) throw new Error(t('Create a split from this popup once first. It then remembers that pair.'));
    return bridge.locked(windowId, () => manager.pairAssistants(pair.left, pair.right, windowId));
  }
  if (message.type === 'ASB_OPEN') {
    if (!Object.hasOwn(PROVIDERS, message.provider)) throw new Error(t('Unknown assistant.'));
    await chrome.tabs.create({ url: PROVIDERS[message.provider].url, windowId, active: false });
    return { ok: true, message: t('{name} opened in a new tab. Sign in if needed.', { name: PROVIDERS[message.provider].name }) };
  }
  throw new Error(t('Unsupported popup action.'));
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(respond, error => respond({ ok: false, error: error.message || t('The action could not be completed.') }));
  return true;
});

chrome.windows.onRemoved.addListener(windowId => {
  chrome.storage.session.remove([`urls:${windowId}`, `recent:${windowId}`]).catch(() => {});
});

let refreshTimer;
function refreshControls() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs.filter(tab => providerFor(tab.url) && !tab.discarded && !tab.frozen).map(tab =>
      chrome.tabs.sendMessage(tab.id, { type: 'ASB_REFRESH' }, { frameId: 0 })));
  }, 150);
}
chrome.tabs.onUpdated.addListener((_id, change) => {
  if ('splitViewId' in change || 'url' in change || 'title' in change || 'discarded' in change || change.status === 'complete') refreshControls();
});
chrome.tabs.onMoved.addListener(refreshControls);
chrome.tabs.onAttached.addListener(refreshControls);
chrome.tabs.onDetached.addListener(refreshControls);
chrome.tabs.onCreated.addListener(refreshControls);
chrome.tabs.onRemoved.addListener(refreshControls);
chrome.tabs.onActivated.addListener(refreshControls);
chrome.storage.onChanged.addListener((_changes, area) => { if (area === 'session' || area === 'sync') refreshControls(); });
