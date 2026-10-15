import { DEFAULT_SHARE_MESSAGE, loadSettings, saveSettings } from './settings.js';

const $ = selector => document.querySelector(selector);
const status = $('#status');

async function send(type, values = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...values });
  if (!response?.ok) throw new Error(response?.error || 'The extension did not respond. Try reopening this popup.');
  return response;
}

function report(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

async function refresh() {
  const result = await send('ASB_LIST');
  const previous = [$('#left').value, $('#right').value];
  for (const selector of ['#left', '#right']) {
    const select = $(selector);
    select.replaceChildren(new Option('Choose an open chat…', ''));
    for (const tab of result.tabs) select.add(new Option(`${tab.name} · ${tab.title.slice(0, 65)}`, String(tab.id)));
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
  $('#pair').disabled = result.tabs.length < 2;
  $('#capability').textContent = result.peer
    ? `Side by side with ${result.peer.name}`
    : result.canManageSplit ? 'Choose two chats to put side by side.'
      : 'Right-click an AI chat tab and choose Split View to pair it.';
}

async function action(button, callback) {
  button.disabled = true;
  try { const result = await callback(); report(result.message); await refresh(); }
  catch (error) { report(error.message, true); }
  finally { button.disabled = false; }
}

$('#pair-form').addEventListener('submit', event => {
  event.preventDefault();
  action($('#pair'), () => send('ASB_PAIR', { leftId: Number($('#left').value), rightId: Number($('#right').value) }));
});
document.querySelectorAll('[data-provider]').forEach(button => button.addEventListener('click', () => {
  action(button, () => send('ASB_OPEN', { provider: button.dataset.provider }));
}));
refresh().catch(error => report(error.message, true));

// ---------- Share settings ----------
const message = $('#share-message');
const sendNow = $('#send-now');
const count = () => { $('#count').textContent = `${message.value.length.toLocaleString()} / ${message.maxLength.toLocaleString()}`; };
const describeMode = () => {
  $('#mode-detail').textContent = sendNow.checked ? 'The reply is sent to the chat you pick.' : 'The reply is added as a draft for you to review first.';
};
let saveTimer = null;
async function save(changes) {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await saveSettings(chrome.storage.sync, changes);
    $('#saved').textContent = 'Saved';
  } catch (error) {
    $('#saved').textContent = `Not saved: ${error.message}`;
  }
}
loadSettings(chrome.storage.sync).then(settings => {
  sendNow.checked = settings.shareMode === 'send';
  message.value = settings.shareMessage;
  describeMode();
  count();
}, error => { $('#saved').textContent = `Could not load settings: ${error.message}`; });
sendNow.addEventListener('change', () => {
  describeMode();
  save({ shareMode: sendNow.checked ? 'send' : 'draft' });
});
message.addEventListener('input', () => {
  $('#saved').textContent = '';
  count();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save({ shareMessage: message.value }), 400);
});
document.querySelectorAll('[data-insert]').forEach(button => button.addEventListener('click', () => {
  message.focus();
  message.setRangeText(button.dataset.insert, message.selectionStart, message.selectionEnd, 'end');
  message.dispatchEvent(new Event('input'));
}));
// The popup can close at any moment, so typing is saved as soon as focus leaves or the popup hides.
const flush = () => { if (saveTimer !== null) save({ shareMessage: message.value }); };
message.addEventListener('blur', () => {
  flush();
  // An emptied message is stored as the default, so show what will actually be sent.
  if (!message.value.trim()) {
    message.value = DEFAULT_SHARE_MESSAGE;
    count();
  }
});
addEventListener('pagehide', flush);
$('#reset-message').addEventListener('click', () => {
  message.value = DEFAULT_SHARE_MESSAGE;
  count();
  save({ shareMessage: DEFAULT_SHARE_MESSAGE });
});
$('#share-settings').addEventListener('submit', event => event.preventDefault());
