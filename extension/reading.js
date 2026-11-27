(() => {
  'use strict';
  const turns = globalThis.AISplitReadingTurns;
  const width = globalThis.AISplitReadingWidth;
  const adapter = globalThis.AISplitAdapters;
  if (!turns || !width || !adapter || globalThis.AISplitReading) return;
  const i18n = globalThis.AISplitI18n;
  const { t } = i18n;

  const local = chrome.storage.local;
  const prefix = `reading:${location.origin}:`;
  // Each bookmark or fold has its own key so two tabs can independently edit the same chat.
  const savedKeys = new Set();
  let wide = false, tools = false, initialized = false;
  let page = '', saved = false, records = [], hidden = new Set(), bookmarks = new Set();
  const writes = new Map();
  const pageToken = () => location.pathname + (new URLSearchParams(location.search).get('temporary-chat') === 'true' ? '?temporary-chat' : '');
  const savedPath = {
    chatgpt: /\/c\/[^/]+\/?$/, claude: /\/chat\/[^/]+\/?$/,
    gemini: /\/(?:app\/[^/]+|gem\/[^/]+\/[^/]+)\/?$/, grok: /\/c\/[^/]+\/?$/,
  }[adapter.provider];
  const group = () => `${prefix}${encodeURIComponent(page)}:`;
  function restorePage() {
    hidden = new Set();
    bookmarks = new Set();
    if (!saved) return;
    const start = group();
    for (const key of savedKeys) {
      if (key.startsWith(start + 'h:')) hidden.add(key.slice(start.length + 2));
      if (key.startsWith(start + 'b:')) bookmarks.add(key.slice(start.length + 2));
    }
  }
  function toggle(kind, key, originPage) {
    if (!tools || originPage !== pageToken() || originPage !== page) return;
    const set = kind === 'h' ? hidden : bookmarks;
    const add = !set.has(key);
    if (add) set.add(key); else set.delete(key);
    if (saved) {
      const name = `${group()}${kind}:${key}`;
      if (add) savedKeys.add(name); else savedKeys.delete(name);
      // Queue edits to the same key in click order. Storage changes for other keys remain independent.
      const next = (writes.get(name) || Promise.resolve()).then(() => add ? local.set({ [name]: true }) : local.remove(name));
      const done = next.catch(async () => {
        if (writes.get(name) !== done) return;
        const stored = await local.get(name).catch(() => ({}));
        if (stored[name]) savedKeys.add(name); else savedKeys.delete(name);
        if (page === originPage) {
          restorePage();
          refresh();
          globalThis.AISplitReading.notify?.(t('Could not save your reading change. Try again.'));
        }
      }).finally(() => {
        if (writes.get(name) !== done) return;
        writes.delete(name);
        if (page !== originPage) return;
        // Another open copy of this chat may have changed this same marker.
        if (set.has(key) !== savedKeys.has(name)) { restorePage(); refresh(); }
      });
      writes.set(name, done);
    }
    refresh();
  }
  function refresh() {
    if (!initialized) return;
    const current = pageToken();
    if (page !== current) {
      turns.clear();
      page = current;
      saved = savedPath?.test(location.pathname) && !current.endsWith('?temporary-chat');
      restorePage();
      records = [];
    }
    if (tools) records = turns.render({ hidden: [...hidden], bookmarks: [...bookmarks],
      onToggleHidden: ({ key }) => toggle('h', key, current),
      onToggleBookmark: ({ key }) => toggle('b', key, current),
    });
    if (wide) width.refresh();
  }
  function preferences(options) {
    wide = options.readingWide === true;
    tools = options.readingTools === true;
    width.setEnabled(wide);
    if (!tools) { turns.clear(); records = []; }
  }
  const ready = Promise.all([local.get(['readingWide', 'readingTools']), local.getKeys()]).then(([options, keys]) => {
    for (const key of keys) if (key.startsWith(prefix)) savedKeys.add(key);
    preferences(options);
    initialized = true;
    refresh();
  });
  ready.catch(() => {}); // The popup reports a storage error if a request cannot be served.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    ready.then(() => {
      let changed = false;
      if (changes.readingWide || changes.readingTools) {
        preferences({ readingWide: changes.readingWide ? changes.readingWide.newValue : wide,
          readingTools: changes.readingTools ? changes.readingTools.newValue : tools });
        changed = true;
      }
      let pageEdited = false;
      for (const [key, delta] of Object.entries(changes)) {
        if (!key.startsWith(prefix)) continue;
        if (delta.newValue === true) savedKeys.add(key); else savedKeys.delete(key);
        if (!writes.has(key) && saved && key.startsWith(group())) pageEdited = true;
      }
      if (pageEdited) restorePage();
      if (changed || pageEdited) refresh();
    }).catch(() => {});
  });
  async function handle(message) {
    await ready;
    refresh();
    if (message.type === 'ASB_READING_LIST') {
      const items = records.filter(record => bookmarks.has(record.key)).map(({ key, role, label }) => ({ key, role, label }));
      return { ok: true, page, items, total: bookmarks.size };
    }
    if (message.page !== page || !tools || !bookmarks.has(message.key)) {
      throw new Error(t('The conversation or bookmark changed. Reopen the popup and choose the message again.'));
    }
    const found = await turns.jump(message.key);
    if (!found || message.page !== pageToken()) {
      throw new Error(t('This message is not available yet. Load earlier messages in this chat and reopen Bookmarks.'));
    }
    return { ok: true };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html') ||
      !['ASB_READING_LIST', 'ASB_READING_JUMP'].includes(message?.type)) return false;
    handle(message).then(respond, error => respond({ ok: false, error: error.message }));
    return true;
  });
  globalThis.navigation?.addEventListener('currententrychange', refresh);
  addEventListener('popstate', refresh);
  i18n.onChange(refresh);
  globalThis.AISplitReading = { refresh, notify: null };
})();
