(() => {
  'use strict';
  if (globalThis.AISplitReplyFiles) return;
  const { t } = globalThis.AISplitI18n;
  // download-capture.js runs in the page's own world, without the translations, and reports in English.
  const captureError = message => ({
    'The file exceeds 20 MB.': t('The file exceeds 20 MB.'),
    'The download expired or was refused.': t('The download expired or was refused.'),
    'The site returned a page instead of the file.': t('The site returned a page instead of the file.'),
    'The download could not be read.': t('The download could not be read.'),
  })[message] ?? message;
  const MAX_FILES = 10;
  const MAX_BYTES = 32 * 1024 * 1024;
  const cleanName = value => String(value || 'generated-file').split(/[\\/]/).at(-1).replace(/[\x00-\x1f]/g, '').trim().slice(0, 255) || 'generated-file';
  const label = node => node.getAttribute('aria-label') || node.getAttribute('title') || node.textContent.trim();
  const visible = node => {
    if (!node.isConnected || node.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };

  function dialogs() {
    const roots = [document];
    // Claude renders its export dialog in a same-origin artifact shell. Never read
    // the cross-origin user-content frame nested inside that shell.
    for (const frame of document.querySelectorAll('iframe[src]')) {
      try {
        const url = new URL(frame.getAttribute('src'), location.href);
        if (url.origin === location.origin && url.pathname.startsWith('/code/artifact/') && frame.contentDocument) roots.push(frame.contentDocument);
      } catch { /* inaccessible frame */ }
    }
    return roots.flatMap(root => [...root.querySelectorAll('[role="dialog"], dialog')]).filter(visible);
  }

  // Only explicit downloads count. Ordinary citations, even links ending in .pdf, stay text.
  function list(scope) {
    const files = [], seen = new Set(), keys = new Map();
    const attribute = ['data-chatgpt-selection-message-id', 'data-message-id', 'data-turn-key'].find(name => scope.hasAttribute(name));
    const source = { element: scope, ...(attribute ? { attribute, value: scope.getAttribute(attribute) } : {}) };
    const add = (key, name, element, kind = 'download', matchName) => {
      // Distinct cards can legitimately have the same title (for example a
      // revision of notes.md). Only deduplicate the same download control.
      if (seen.has(element)) return;
      seen.add(element);
      const occurrence = keys.get(key) || 0;
      keys.set(key, occurrence + 1);
      files.push({ key: `${key}#${occurrence}`, identity: key, source, name: cleanName(name), element, kind, ...(matchName ? { matchName } : {}) });
    };
    if (location.hostname === 'gemini.google.com') {
      for (const card of scope.querySelectorAll('section[data-test-id="generated-file-chip"]')) {
        if (!visible(card)) continue;
        const control = card.querySelector('a[download][href][data-test-id="download-button"], button[data-test-id="download-button"]');
        const name = control?.getAttribute('download') || card.querySelector('[data-test-id="file-name"]')?.textContent.trim() || card.getAttribute('aria-label');
        if (!name) continue;
        const downloadable = control && visible(control) && !control.matches(':disabled, [aria-disabled="true"]');
        add(`gemini-file:${name}`, name, control || card, downloadable ? 'download' : 'unavailable', name);
      }
    }
    for (const link of scope.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href');
      let url;
      try { url = new URL(href, location.href); } catch { continue; }
      if (visible(link) && (link.hasAttribute('download') || /^(sandbox:|blob:)/.test(href)
        || (url.origin === location.origin && /^\/api\/.*\/download-file$/.test(url.pathname)))) {
        let path;
        try { path = decodeURIComponent(new URL(href, location.href).pathname); } catch { path = href; }
        const name = link.getAttribute('download') || (path.includes('.') ? path.split('/').at(-1) : link.textContent);
        add(href, name, link);
      }
    }
    // Claude's ordinary outputs (CSV, notebooks, archives, images, Office files,
    // source code, and others) have native file cards, independently of Docs.
    for (const card of scope.querySelectorAll('[data-testid="file-card-block"]')) {
      // Compact cards use a span with role=button; the larger artifact card uses
      // a native button. Both carry the same stable test id and accessible name.
      const view = card.querySelector('[data-testid="file-card-open"]');
      if (!view || !visible(card)) continue;
      const title = label(view).replace(/^View /, '');
      const download = [...card.querySelectorAll('button, [role="button"], a[download]')].find(node =>
        node.closest('[data-testid="file-card-block"]') === card
        && (node.hasAttribute('download') || /^Download(?:\s|$)/i.test(label(node)))
        && !/^Download all\b/i.test(label(node)));
      // The visible format label is just a filename hint. The actual download's
      // name and MIME type take precedence, with no restriction to these formats.
      const extension = [...card.querySelectorAll('*')].filter(node => {
        const control = node.closest('button, [role="button"]');
        return !control || control === view;
      })
        .map(node => node.textContent.trim()).map(text => text.match(/(?:^|[·•])\s*([A-Z][A-Z0-9]{0,11})$/)?.[1])
        .find(text => text && text !== title);
      const name = /\.[a-z0-9]{1,12}$/i.test(title) || !extension ? title : `${title}.${extension.toLowerCase()}`;
      const kind = download ? 'download' : card.getAttribute('data-sheet-kind') === 'markdown' ? 'claude-markdown' : 'unavailable';
      add(`file:${title}:${extension || card.getAttribute('data-sheet-kind')}`, name, download || view, kind, title);
    }
    // Current ChatGPT resource cards put the file beside the markdown, with no href.
    for (const preview of scope.querySelectorAll('button[aria-label^="Open preview of "]')) {
      if (!visible(preview)) continue;
      const name = label(preview).slice('Open preview of '.length);
      const row = preview.parentElement;
      const download = row.querySelector('button[aria-label="Download file"]');
      // Inline references to an uploaded file also say "Open preview of ...".
      // They are citations, not generated output cards.
      if (!download && !row.classList.contains('group/resource-row')) continue;
      add(`card:${name}`, name, download || preview, download ? 'download' : 'unavailable');
    }
    // Claude Docs exports are reached through the card's own Share/export dialog.
    // Use only cards with that control; source-document citations are not generated outputs.
    for (const card of scope.querySelectorAll('[data-sheet-kind="doc"]')) {
      const share = card.querySelector('button[data-testid="frame-card-share"]');
      const view = card.querySelector('button[data-testid="frame-card-open"]');
      if (share && view && visible(card)) {
        const title = label(view).replace(/^View /, '');
        add(`doc:${title}`, `${title}.docx`, share, 'claude-doc');
      }
    }
    return files;
  }

  async function waitFor(find, message = t('The document export controls did not open.')) {
    const end = Date.now() + 8000;
    do {
      const found = find();
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < end);
    throw new Error(message);
  }

  // Markdown artifacts have no inline Download button. Use the selected file's
  // native viewer → More options → Download as MD, retaining its original bytes.
  const panes = () => [...document.querySelectorAll('[data-testid="chat-side-pane"]')].filter(visible);
  const fileTitle = text => String(text || '').replace(/\s*[·•]\s*(?:MD|Markdown)(?:\s+controls)?\s*$/i, '').trim().toLowerCase();
  function markdownViewer(title) {
    const matches = panes().flatMap(pane => [...pane.querySelectorAll('[role="toolbar"]')]
      .filter(toolbar => fileTitle(toolbar.getAttribute('aria-label')) === fileTitle(title)
        || [...toolbar.querySelectorAll('h1, h2, h3, [role="heading"]')].some(heading => fileTitle(heading.textContent) === fileTitle(title)))
      .map(toolbar => ({ pane, toolbar })));
    return matches.length === 1 ? matches[0] : null;
  }

  async function markdownDownload(file, cleanup) {
    const title = file.matchName;
    const selected = () => file.element.getAttribute('aria-pressed') === 'true' || file.element.getAttribute('aria-current') === 'true';
    // Titles can repeat across revisions. A matching heading alone does not
    // prove the viewer belongs to this card; the card must also be selected.
    let viewer = selected() ? markdownViewer(title) : null;
    if (!viewer) {
      const before = panes();
      const previous = [...document.querySelectorAll('[data-testid="file-card-open"][aria-pressed="true"], [data-testid="file-card-open"][aria-current="true"]')]
        .find(node => visible(node) && markdownViewer(label(node).replace(/^View /, '')));
      file.element.click();
      cleanup.viewer = () => {
        const current = markdownViewer(title);
        if (!current || !selected()) return; // The user has since chosen a different file.
        if (previous?.isConnected) previous.click();
        else if (!before.length) [...current.toolbar.querySelectorAll('button')].find(node => label(node) === 'Close')?.click();
      };
      viewer = await waitFor(() => selected() && markdownViewer(title), t('The selected Markdown file did not open in Claude’s viewer.'));
    }
    const more = [...viewer.toolbar.querySelectorAll('button, [role="button"]')].find(node => label(node) === 'More options');
    if (!more || more.disabled || more.getAttribute('aria-disabled') === 'true') throw new Error(t('The Markdown viewer has no available More options control.'));
    const menuBefore = [...document.querySelectorAll('[role="menu"]')].filter(visible);
    const ownMenu = () => {
      const id = more.getAttribute('aria-controls');
      const controlled = id && document.getElementById(id);
      if (id) return controlled?.matches('[role="menu"]') && visible(controlled) ? controlled : null;
      const opened = [...document.querySelectorAll('[role="menu"]')].filter(node => visible(node) && !menuBefore.includes(node));
      return opened.length === 1 ? opened[0] : null;
    };
    if (!ownMenu()) {
      if (menuBefore.length) throw new Error(t('Close the open menu before sharing this Markdown file.'));
      more.click();
      cleanup.menu = () => { if (more.isConnected && ownMenu() && more.getAttribute('aria-expanded') === 'true') more.click(); };
    }
    return waitFor(() => {
      if (!selected() || markdownViewer(title)?.pane !== viewer.pane) throw new Error(t('The selected Markdown viewer changed before download.'));
      const menu = ownMenu();
      return menu && [...menu.querySelectorAll('[role="menuitem"], button')].find(node =>
        /^Download as (MD|Markdown)$/i.test(label(node)) && !node.disabled && node.getAttribute('aria-disabled') !== 'true');
    }, t('Claude did not offer Download as MD for this file.'));
  }

  async function expand(scope) {
    for (const control of scope.querySelectorAll('button[aria-controls][aria-expanded="false"]')) {
      const count = label(control).match(/^(\d+) more$/i);
      const card = control.parentElement;
      const selector = 'button[aria-label^="Open preview of "]';
      const previews = () => [...card.querySelectorAll(selector)].filter(visible).length;
      if (!count || !previews()) continue;
      const expected = previews() + Number(count[1]);
      control.click();
      await waitFor(() => control.getAttribute('aria-expanded') === 'true' && previews() >= expected);
    }
  }

  async function currentFile(file) {
    const { source } = file;
    if (!source) {
      if (!file.element.isConnected) throw new Error(t('The reply changed. Open Share again.'));
      return file;
    }
    const scope = source.attribute ? [...document.querySelectorAll(`[${source.attribute}]`)]
      .find(node => node.getAttribute(source.attribute) === source.value) : source.element;
    if (!scope?.isConnected) throw new Error(t('The reply changed. Open Share again.'));
    await expand(scope);
    const available = list(scope);
    // Reordering equal-name cards must not silently change the selected file.
    const matches = available.filter(item => item.identity === file.identity);
    const current = available.find(item => item.element === file.element)
      || (matches.length === 1 ? matches[0] : !file.identity ? available.find(item => item.key === file.key) : null);
    if (!current) throw new Error(t('The file is no longer in this reply. Open Share again.'));
    return current;
  }

  function capture(element, name, matchName) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const attr = 'data-asb-file-capture';
      const finish = (error, file) => {
        clearTimeout(timer);
        document.removeEventListener('asb-file-result', receive);
        element.removeAttribute(attr);
        error ? reject(new Error(captureError(error))) : resolve(file);
      };
      const receive = event => {
        let result;
        try { result = JSON.parse(event.detail); } catch { return; }
        if (result.id !== id) return;
        finish(result.error, result.file);
      };
      const timer = setTimeout(() => finish(t('The file download could not be read. Refresh this AI tab after updating the extension.')), 35_000);
      document.addEventListener('asb-file-result', receive);
      element.setAttribute(attr, id);
      document.dispatchEvent(new CustomEvent('asb-file-request', { detail: JSON.stringify({ id, name, matchName }) }));
    });
  }

  async function read(files) {
    if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error(t('Share up to 10 generated files at a time. Nothing was sent.'));
    const pageKey = () => {
      const url = new URL(location.href);
      url.hash = '';
      if (url.hostname === 'claude.ai') url.searchParams.delete('artifact');
      return url.href;
    };
    const page = pageKey();
    const copies = [];
    let total = 0;
    for (const file of files) {
      let dialog;
      const cleanup = {};
      try {
        if (pageKey() !== page) throw new Error(t('The reply changed. Open Share again.'));
        const current = await currentFile(file);
        if (current.kind === 'unavailable') throw new Error(t('The file card has no download control.'));
        let download = current.element;
        if (current.kind === 'claude-doc') {
          if (dialogs().length) throw new Error(t('Close the open dialog before sharing a document.'));
          current.element.click();
          const title = label(current.element).replace(/^Share /, '');
          dialog = await waitFor(() => dialogs().find(node => node.getAttribute('aria-label') === title
            || node.querySelector('h1, h2, [role="heading"]')?.textContent.trim() === title));
          const exportTab = [...dialog.querySelectorAll('[role="radio"], button')].find(node => label(node) === 'Export');
          if (!exportTab) throw new Error(t('Could not find the document Export tab.'));
          exportTab.click();
          download = await waitFor(() => [...dialog.querySelectorAll('button')].find(node => /^Word\b/.test(label(node)) && /\.docx/.test(label(node))));
        }
        if (current.kind === 'claude-markdown') download = await markdownDownload(current, cleanup);
        if (pageKey() !== page) throw new Error(t('The reply changed. Open Share again.'));
        await currentFile(file);
        const copy = await capture(download, file.name, file.matchName);
        if (pageKey() !== page) throw new Error(t('The reply changed while its file was being read.'));
        await currentFile(file);
        if (!copy || typeof copy.data !== 'string') throw new Error(t('The file contents were unavailable.'));
        total += copy.data.length / 4 * 3 - (copy.data.endsWith('==') ? 2 : copy.data.endsWith('=') ? 1 : 0);
        if (total > MAX_BYTES) throw new Error(t('Generated files exceed the 32 MB total limit.'));
        copies.push(copy);
      } catch (error) {
        throw new Error(t('Nothing was sent. {file}: {error} Download and attach this file manually, or uncheck generated files to share text only.', { file: file.name, error: error.message }));
      } finally {
        if (pageKey() === page) {
          cleanup.menu?.();
          cleanup.viewer?.();
        }
        // Close only the export dialog opened by this action.
        [...(dialog?.querySelectorAll('button') || [])].find(node => label(node) === 'Close')?.click();
      }
    }
    return copies;
  }

  globalThis.AISplitReplyFiles = Object.freeze({ list, read, expand });
})();
