import { defaultMessages, loadSettings, readSettings, saveSettings } from './settings.js';

// popup.html loads the translations as plain scripts before this module.
const i18n = globalThis.AISplitI18n;
const { t } = i18n;
const $ = selector => document.querySelector(selector);
const status = $('#status');

// Static text in popup.html carries data-i18n markers, and its English wording is the key.
// Once translated, each marker keeps that wording so the text can change language again.
function localize() {
  document.documentElement.lang = i18n.language;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = i18n.t(node.dataset.i18n ||= node.textContent);
  for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = i18n.t(node.dataset.i18nTitle ||= node.title);
  for (const node of document.querySelectorAll('[data-i18n-label]')) node.label = i18n.t(node.dataset.i18nLabel ||= node.label);
  for (const node of document.querySelectorAll('[data-i18n-rich]')) {
    // Only the <b> markers of a translation become elements; the rest is inserted as text.
    const parts = i18n.t(node.dataset.i18nRich ||= node.innerHTML).split(/<b>(.*?)<\/b>/);
    node.replaceChildren(...parts.map((part, index) => {
      if (index % 2 === 0) return part;
      const bold = document.createElement('b');
      bold.textContent = part;
      return bold;
    }));
  }
}

async function send(type, values = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...values });
  if (!response?.ok) throw new Error(response?.error || t('The extension did not respond. Try reopening this popup.'));
  return response;
}

function report(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

// The assistants are read from the "Open an assistant" buttons, so the popup names them in one place.
const assistants = Array.from(document.querySelectorAll('[data-provider]'), button => ({ provider: button.dataset.provider, name: button.textContent }));
const NEW_CHAT = 'new:';

async function refresh() {
  const result = await send('ASB_LIST');
  const previous = [$('#left').value, $('#right').value];
  for (const selector of ['#left', '#right']) {
    const select = $(selector);
    select.replaceChildren(new Option(t('Choose a chat…'), ''));
    for (const tab of result.tabs) select.add(new Option(`${tab.name} · ${tab.title.slice(0, 65)}`, String(tab.id)));
    // A side can also be an assistant that is not open yet; Create split opens it first.
    const unopened = document.createElement('optgroup');
    unopened.label = t('Open a new chat');
    for (const { provider, name } of assistants) unopened.append(new Option(t('New {name} chat', { name }), NEW_CHAT + provider));
    select.append(unopened);
  }
  if (result.peer) {
    const ids = [result.activeId, result.peer.id];
    const pair = result.tabs.filter(tab => ids.includes(tab.id)).sort((a, b) => a.index - b.index);
    $('#left').value = String(pair[0]?.id || '');
    $('#right').value = String(pair[1]?.id || '');
  } else {
    $('#left').value = previous[0] || String(result.activeId || result.tabs[0]?.id || '');
    const other = result.tabs.find(tab => String(tab.id) !== $('#left').value);
    $('#right').value = previous[1] || String(other?.id || '');
  }
  $('#pair-section').hidden = !result.canManageSplit;
  // The pair made last time is remembered by assistant, so one click can open it again.
  const names = [result.lastPair?.left, result.lastPair?.right].map(provider => assistants.find(item => item.provider === provider)?.name);
  const again = $('#pair-last');
  again.hidden = !result.canManageSplit || names.some(name => !name);
  if (!again.hidden) {
    const [left, right] = names;
    again.textContent = t('Open {left} + {right}', { left, right });
    again.title = t('{left} on the left and {right} on the right, as last time. An open chat is used as it is; a missing one is opened.', { left, right });
  }
  $('#capability').textContent = result.peer
    ? t('Side by side with {name}', { name: result.peer.name })
    : result.canManageSplit ? t('Choose two chats to put side by side.')
      : t('Right-click an AI chat tab and choose Split View to pair it.');
}

async function action(button, callback, working = '') {
  button.disabled = true;
  if (working) report(working);
  try { const result = await callback(); report(result.message); await refresh(); }
  catch (error) { report(error.message, true); }
  finally { button.disabled = false; }
}

$('#pair-form').addEventListener('submit', event => {
  event.preventDefault();
  const sides = [['left', $('#left').value], ['right', $('#right').value]];
  if (sides.some(([, value]) => !value)) return report(t('Choose a chat for each side.'), true);
  const isNew = value => value.startsWith(NEW_CHAT);
  const choice = Object.fromEntries(sides.map(([side, value]) => isNew(value)
    ? [`${side}Provider`, value.slice(NEW_CHAT.length)] : [`${side}Id`, Number(value)]));
  const working = sides.some(([, value]) => isNew(value)) ? t('Opening the chat and creating the split…') : '';
  action($('#pair'), () => send('ASB_PAIR', choice), working);
});
$('#pair-last').addEventListener('click', () => {
  action($('#pair-last'), () => send('ASB_PAIR_LAST'), t('Opening the chat and creating the split…'));
});
document.querySelectorAll('[data-provider]').forEach(button => button.addEventListener('click', () => {
  action(button, () => send('ASB_OPEN', { provider: button.dataset.provider }));
}));
refresh().catch(error => report(error.message, true));

// ---------- Share settings ----------
const message = $('#share-message');
const sendNow = $('#send-now');
const kind = $('#share-kind');
const templates = {
  conversation: { key: 'conversationMessage', label: () => t('Message with selected messages'), placeholder: '{content}' },
  comparison: { key: 'comparisonMessage', label: () => t('Comparison instructions'), placeholder: '{answers}' },
  reviewCommon: { key: 'reviewGuidance', label: () => t('Instructions for all cross-reviews') },
};
const current = () => templates[kind.value];
// The default for the chosen kind of message, written in the interface language.
const fallback = () => defaultMessages(i18n.language)[current().key];
const count = () => { $('#count').textContent = `${message.value.length.toLocaleString()} / ${message.maxLength.toLocaleString()}`; };
const describeMode = () => {
  $('#mode-detail').textContent = sendNow.checked ? t('Send shared messages, comparisons and cross-reviews immediately.') : t('Add shared messages, comparisons and cross-reviews as drafts.');
};
const pendingChanges = {};
let settings, saveTimer = null, revision = 0, saveQueue = Promise.resolve();
function showMessage() {
  const template = current();
  message.value = settings[template.key]?.trim() ? settings[template.key] : fallback();
  $('#message-label').textContent = template.label();
  const common = kind.value === 'reviewCommon';
  message.placeholder = common ? t('For example, cite evidence for each criticism.') : '';
  $('#template-hint').textContent = common ? t('Applied to both chats in every cross-review.') : t('Insert');
  if (common) message.setAttribute('aria-describedby', 'template-hint');
  else message.removeAttribute('aria-describedby');
  const comparing = kind.value === 'comparison';
  $('#assistant-placeholder').hidden = comparing || common;
  const insert = $('#content-placeholder');
  insert.hidden = common;
  if (!common) {
    insert.textContent = insert.dataset.insert = template.placeholder;
    insert.title = comparing ? t('Insert both labelled answers here. If omitted, they go at the end.') : t('The shared text. Without it, the text goes at the end');
  }
  count();
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!settings) return;
  // Include every local edit, and finish writes in order. Switching templates or
  // changing Send right away must not cancel a message still waiting to save.
  const changes = { ...pendingChanges }, savedRevision = revision;
  saveQueue = saveQueue.then(async () => {
    try {
      await saveSettings(chrome.storage.sync, changes, i18n.language);
      for (const [key, value] of Object.entries(changes)) {
        if (pendingChanges[key] === value) delete pendingChanges[key];
      }
      if (savedRevision === revision) $('#saved').textContent = t('Saved');
    } catch (error) {
      if (savedRevision === revision) $('#saved').textContent = t('Not saved: {error}', { error: error.message });
    }
  });
  return saveQueue;
}

// ---------- Interface language ----------
const language = $('#language');
// Everything on screen is rewritten, and messages nobody customized change language too.
function showLanguage() {
  localize();
  language.value = i18n.choice;
  if (settings) {
    settings = readSettings(settings, i18n.language);
    $('#saved').textContent = '';
    describeMode();
    showMessage();
  }
  refresh().catch(error => report(error.message, true));
}
language.addEventListener('change', () => {
  const choice = language.value;
  i18n.choose(choice);
  chrome.storage.sync.set({ language: choice }).catch(error => { $('#saved').textContent = t('Not saved: {error}', { error: error.message }); });
});
localize();
i18n.follow(chrome, showLanguage).then(() => {
  language.value = i18n.choice;
  return loadSettings(chrome.storage.sync, i18n.language);
}).then(stored => {
  settings = stored;
  sendNow.checked = settings.shareMode === 'send';
  sendNow.disabled = false;
  $('#share-settings').querySelectorAll('input, select, textarea, button').forEach(control => { control.disabled = false; });
  describeMode();
  showMessage();
}, error => { $('#saved').textContent = t('Could not load settings: {error}', { error: error.message }); });
sendNow.addEventListener('change', () => {
  describeMode();
  pendingChanges.shareMode = settings.shareMode = sendNow.checked ? 'send' : 'draft';
  revision++;
  save();
});
message.addEventListener('input', () => {
  pendingChanges[current().key] = settings[current().key] = message.value;
  revision++;
  $('#saved').textContent = '';
  count();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
});
document.querySelectorAll('[data-insert]').forEach(button => button.addEventListener('click', () => {
  message.focus();
  if (message.value.length - (message.selectionEnd - message.selectionStart) + button.dataset.insert.length > message.maxLength) return;
  message.setRangeText(button.dataset.insert, message.selectionStart, message.selectionEnd, 'end');
  message.dispatchEvent(new Event('input'));
}));
// The popup can close at any moment, so typing is saved as soon as focus leaves or the popup hides.
const flush = () => { if (saveTimer !== null) save(); };
kind.addEventListener('change', () => { flush(); showMessage(); });
message.addEventListener('blur', () => {
  flush();
  // An emptied message is stored as the default, so show what will actually be sent.
  if (!message.value.trim()) {
    settings[current().key] = message.value = fallback();
    count();
  }
});
addEventListener('pagehide', flush);
$('#reset-message').addEventListener('click', () => {
  pendingChanges[current().key] = settings[current().key] = message.value = fallback();
  revision++;
  count();
  save();
});
$('#share-settings').addEventListener('submit', event => event.preventDefault());
