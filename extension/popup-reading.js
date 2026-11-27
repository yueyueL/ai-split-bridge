import { providerFor } from './providers.js';

const i18n = globalThis.AISplitI18n;
const { t } = i18n;
const wide = document.getElementById('readingWide');
const tools = document.getElementById('readingTools');
const index = document.getElementById('reading-index');
const items = document.getElementById('reading-items');
const detail = document.getElementById('reading-detail');
let revision = 0;
async function refreshBookmarks() {
  const version = ++revision;
  index.hidden = !tools.checked;
  items.replaceChildren();
  detail.textContent = '';
  if (!tools.checked) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (version !== revision) return;
    if (!providerFor(tab?.url)) { detail.textContent = t('Open an AI chat to see its bookmarks.'); return; }
    const request = values => chrome.tabs.sendMessage(tab.id, values, { frameId: 0 });
    const result = await request({ type: 'ASB_READING_LIST' });
    if (version !== revision) return;
    if (!result?.ok) throw new Error();
    for (const record of result.items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${record.role === 'user' ? t('You') : t('Reply')} · ${record.label}`;
      button.title = button.textContent;
      button.addEventListener('click', async () => {
        for (const row of items.children) row.disabled = true;
        detail.textContent = t('Finding message…');
        try {
          const jump = await request({ type: 'ASB_READING_JUMP', page: result.page, key: record.key });
          if (!jump?.ok) throw new Error(jump?.error || t('Reopen the popup and try again.'));
          window.close();
        } catch (error) {
          detail.textContent = error.message;
          for (const row of items.children) row.disabled = false;
        }
      });
      items.append(button);
    }
    if (!result.total) detail.textContent = t('Use the bookmark icon beside a message to find it here.');
    else if (result.total > result.items.length) detail.textContent = t('Scroll through the chat to load earlier bookmarks, then reopen this list.');
  } catch { if (version === revision) detail.textContent = t('Refresh this AI tab and reopen the popup to see its bookmarks.'); }
}
for (const input of [wide, tools]) {
  input.addEventListener('change', async () => {
    document.getElementById('reading-error').textContent = '';
    input.disabled = true;
    try {
      await chrome.storage.local.set({ [input.id]: input.checked });
      if (input === tools) await refreshBookmarks();
    } catch {
      input.checked = !input.checked;
      document.getElementById('reading-error').textContent = t('Could not save this reading preference.');
    } finally { input.disabled = false; }
  });
}
chrome.storage.local.get(['readingWide', 'readingTools']).then(options => {
  wide.checked = options.readingWide === true;
  tools.checked = options.readingTools === true;
  wide.disabled = tools.disabled = false;
  refreshBookmarks();
}).catch(() => { document.getElementById('reading-error').textContent = t('Could not load reading preferences.'); });
i18n.onChange(() => { if (!tools.disabled) refreshBookmarks(); });
