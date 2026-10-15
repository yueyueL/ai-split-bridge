import { createTabManager } from './tabs.js';
import { createBridge } from './bridge.js';
import { describe, providerFor, PROVIDERS } from './providers.js';
import { composeShare, loadSettings } from './settings.js';

const manager = createTabManager(chrome);
const bridge = createBridge(chrome, manager);

// The share message and mode are read here, never taken from the page, so a site cannot change what is sent.
async function shareReply(source, choice, reply) {
  if (typeof reply !== 'string' || !reply.trim()) throw new Error('This reply has no text to share.');
  const settings = await loadSettings(chrome.storage.sync);
  const text = composeShare(settings.shareMessage, { assistant: PROVIDERS[providerFor(source.url)].name, reply });
  return bridge.share(source.id, choice, text, { send: settings.shareMode === 'send' });
}

async function handle(message, sender) {
  if (!message || typeof message.type !== 'string' || sender.id !== chrome.runtime.id) throw new Error('Unsupported request.');
  if (sender.tab) {
    if (sender.frameId !== 0 || !providerFor(sender.url)) throw new Error('Only the main AI chat page can use the bridge.');
    const source = await manager.supported(sender.tab.id);
    if (providerFor(source.url) !== providerFor(sender.url)) throw new Error('The chat changed. Refresh and try again.');
    if (message.type === 'ASB_CONTEXT') {
      const { source: unused, ...context } = await manager.context(source.id);
      return { ...context, shareMode: (await loadSettings(chrome.storage.sync)).shareMode };
    }
    const choice = { targetId: message.targetId, provider: message.provider };
    // The clicked chat is always the source; content scripts cannot act on behalf of another tab.
    return bridge.locked(source.windowId, () => {
      switch (message.type) {
        case 'ASB_SEND': return bridge.send(source.id, message.targetIds);
        case 'ASB_SHARE': return shareReply(source, choice, message.reply);
        case 'ASB_SHOW': return bridge.show(source.id, choice);
        default: throw new Error('Unsupported chat action.');
      }
    });
  }
  if (sender.url !== chrome.runtime.getURL('popup.html')) throw new Error('Open the extension popup to manage tabs.');
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const windowId = tabs[0]?.windowId;
  if (message.type === 'ASB_LIST') {
    const active = tabs.find(tab => tab.active);
    let context = null;
    if (active && providerFor(active.url)) context = await manager.context(active.id);
    return { ok: true, tabs: tabs.map(describe).filter(Boolean), activeId: active?.id, canManageSplit: manager.canManageSplit(), peer: context?.peer ?? null };
  }
  if (message.type === 'ASB_PAIR') {
    if (!tabs.some(t => t.id === message.leftId) || !tabs.some(t => t.id === message.rightId)) throw new Error('Choose chats in this window.');
    return bridge.locked(windowId, () => manager.pair(message.leftId, message.rightId));
  }
  if (message.type === 'ASB_OPEN') {
    if (!Object.hasOwn(PROVIDERS, message.provider)) throw new Error('Unknown assistant.');
    await chrome.tabs.create({ url: PROVIDERS[message.provider].url, windowId, active: false });
    return { ok: true, message: `${PROVIDERS[message.provider].name} opened in a new tab. Sign in if needed.` };
  }
  throw new Error('Unsupported popup action.');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(respond, error => respond({ ok: false, error: error.message || 'The action could not be completed.' }));
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
