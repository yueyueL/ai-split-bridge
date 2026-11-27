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

  // User uploads and generated reply files have different controls. Only inspect
  // the caller's single user turn. A preview image can be resized or cropped.
  const promptCardSelector = [
    '[data-testid="attachment-preview"]', '[data-testid="attachment"]', '[data-testid="file-thumbnail"]',
    '[data-testid="file-preview"]', '[data-testid="file-pill"]', '[data-testid="attachment-chip"]',
    '[data-testid="user-file-preview"]', '[data-testid="message-attachment"]',
    '[data-testid="file-card-block"]', '[data-testid="uploaded-file"]', '[data-testid="image-attachment"]',
    '[data-test-id="uploaded-file"]', '[data-test-id="file-preview"]', '[data-cds-attachment]',
    'file-preview', 'image-preview', 'attachment-preview', 'user-query-file', 'user-query-file-preview',
    'uploader-file-preview', 'gem-attachment', '[role="list"][aria-label="Conversation attachments"] > [role="listitem"]',
  ].join(',');
  const attachmentControl = 'button, [role="button"], a[href]';
  const filenameLike = value => /\.[\p{L}\p{N}]{1,12}$/u.test(value) && !/[\n\r]/.test(value);
  const previewLabel = /^(?:open (?:a )?preview of|(?:open|preview|view|uploaded) (?:file|image|attachment))[: ]+(.+)$/i;
  const ignoredPromptArea = 'form, [contenteditable="true"], [data-message-author-role="assistant"], model-response, [data-testid="assistant-message"], [data-testid*="citation"], [data-ai-split-bridge]';

  function promptCards(scope) {
    const cards = new Set(scope.querySelectorAll(promptCardSelector));
    if (scope.matches(promptCardSelector)) cards.add(scope);
    // Some transcript layouts show only a named native download link. Limit
    // these standalone links to provider upload resources outside the prose.
    for (const link of scope.querySelectorAll('a[download][href]')) {
      if (link.closest('p, pre, blockquote') || !link.getAttribute('download')) continue;
      const url = promptDownloadURL(link);
      if (url && (url.protocol === 'blob:' || /\/(?:files?|uploads?|attachments?|estuary)\//i.test(url.pathname))) cards.add(link);
    }
    // Other transcript layouts expose just a preview button or a keyboard-
    // focusable tile with a filename and a file-type badge in either order.
    const candidates = 'button, [role="button"], [tabindex="0"], img[alt^="Uploaded image" i]';
    for (const node of scope.querySelectorAll(candidates)) {
      if (node.closest(promptCardSelector) || node.closest('p, pre, blockquote, [role="toolbar"]')) continue;
      const title = node.getAttribute('aria-label') || node.getAttribute('alt') || '';
      const leaves = [...node.querySelectorAll('span, div')].filter(el => !el.childElementCount && el.textContent.trim())
        .map(el => el.textContent.trim());
      const fileTile = leaves.length >= 2 && leaves.length <= 3 && leaves.some(text => filenameLike(text) || /…/.test(text))
        && leaves.some(text => /^(?:[A-Z0-9]{1,10}|Document|Image|Spreadsheet|Presentation|Archive|Audio|Video)$/.test(text));
      if (!previewLabel.test(title) && !/^uploaded image$/i.test(title) && !fileTile) continue;
      // An inline reference to a file is a link in the prompt body. Only an
      // explicit upload image inside a link represents a native attachment.
      const link = node.closest('a[href]');
      if (link && !node.matches('img[alt^="Uploaded image" i]')) continue;
      const parent = node.parentElement;
      const row = parent !== scope && parent?.children.length === 2 && [...parent.children].some(sibling =>
        sibling !== node && sibling.matches(attachmentControl) && isDownloadControl(sibling)) ? parent : node;
      cards.add(link || row);
    }
    return [...cards].filter(card => {
      if (card.closest(ignoredPromptArea)) return false;
      for (let parent = card.parentElement; parent && scope.contains(parent); parent = parent.parentElement) {
        if (cards.has(parent)) return false;
      }
      return true;
    }).sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  }

  function promptDownloadURL(control) {
    const href = control.getAttribute('href');
    if (!href) return null;
    try {
      const url = new URL(href, location.href);
      if (url.protocol === 'data:' || (url.protocol === 'blob:' && url.origin === location.origin)) return url;
      if (url.protocol !== 'https:') return null;
      if (url.origin === location.origin) return url;
      const cdn = {
        'chatgpt.com': /(^|\.)oaiusercontent\.com$/,
        'claude.ai': /(^|\.)claudeusercontent\.com$/,
        'gemini.google.com': /(^|\.)googleusercontent\.com$/,
        'grok.com': /^assets\.(?:grok\.com|x\.ai)$/,
      }[location.hostname];
      return cdn?.test(url.hostname) ? url : null;
    } catch { return null; }
  }

  function isDownloadControl(control) {
    if (control.matches(':disabled, [aria-disabled="true"]')) return false;
    const title = label(control);
    if (control.matches('a[href]') && !promptDownloadURL(control)) return false;
    return control.hasAttribute('download') || control.matches('[data-testid="download-button"], [data-test-id="download-button"]')
      || (/^download(?:\s|$)/i.test(title) && !/^download all\b/i.test(title));
  }

  function promptFileName(card, control) {
    const named = '[data-filename], [data-file-name], [data-testid="file-name"], [data-test-id="file-name"]';
    const item = card.matches(named) ? card : card.querySelector(named);
    const accessible = [card, ...card.querySelectorAll('[aria-label], img[alt]')].map(node =>
      (node.getAttribute('aria-label') || node.getAttribute('alt') || '').trim());
    const namedText = item?.getAttribute('data-filename') || item?.getAttribute('data-file-name') || item?.textContent.trim();
    const text = [card, ...card.querySelectorAll('span, div, p, strong')].filter(node => !node.childElementCount)
      .map(node => node.textContent.trim()).filter(filenameLike);
    const title = card.getAttribute('title')?.trim();
    const labelledNames = accessible.map(name => name.match(previewLabel)?.[1]
      || (filenameLike(name) ? name.replace(/^(?:open|preview|view|download)\s+/i, '') : ''));
    const names = [control?.getAttribute('download'), namedText, ...labelledNames,
      filenameLike(title || '') && title, ...text].filter(Boolean);
    // Tooltip labels can also contain a generic description of an unnamed image.
    const full = names.find(name => !/…|\.\.\./.test(name) && !/^(?:(?:uploaded|attached) )?(?:file|image|attachment)$/i.test(name));
    return { name: full ? cleanName(full) : cleanName(names[0] || t('Attached file')), nameKnown: Boolean(full) };
  }

  // React may recycle a mounted transcript row when the user scrolls. Verify
  // the native turn IDs even if the scope and the download button still exist.
  const turnAttributes = ['data-turn-id', 'data-turn-key', 'data-message-id', 'data-chatgpt-selection-message-id', 'data-content-search-unit-key'];
  function promptTurnIdentity(scope) {
    return JSON.stringify(turnAttributes.map(attr => {
      const selector = `[${attr}]`;
      return (scope.closest(selector) || scope.querySelector(selector))?.getAttribute(attr);
    }).concat(scope.closest('[data-test-id="user-query"]')?.parentElement?.id));
  }

  function listPrompt(scope) {
    const source = { element: scope, page: location.href.split('#')[0], turn: promptTurnIdentity(scope) };
    const occurrences = new Map();
    return promptCards(scope).filter(visible).map(card => {
      const control = [card, ...card.querySelectorAll(attachmentControl)].find(node => node.matches(attachmentControl)
        && !node.closest('[hidden], [inert], [aria-hidden="true"]') && isDownloadControl(node));
      const { name, nameKnown } = promptFileName(card, control);
      const identity = JSON.stringify([name, card.getAttribute('data-file-id'), control?.getAttribute('href')]);
      const occurrence = occurrences.get(identity) || 0;
      occurrences.set(identity, occurrence + 1);
      return { key: `upload:${identity}#${occurrence}`, identity, source, name, nameKnown, element: control || card,
        card, kind: control ? 'download' : 'unavailable', promptAttachment: true, ...(nameKnown ? { matchName: name } : {}) };
    });
  }

  function stripPromptFiles(clone) {
    for (const card of promptCards(clone)) {
      if (card === clone) clone.replaceChildren();
      else card.remove();
    }
    return clone;
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

  function currentPromptFile(file) {
    const { source } = file;
    if (!source?.element.isConnected || source.page !== location.href.split('#')[0] || source.turn !== promptTurnIdentity(source.element)) return null;
    return listPrompt(source.element).find(item => item.element === file.element && item.card === file.card && item.identity === file.identity);
  }

  const isCurrentPromptFile = file => !!currentPromptFile(file);

  async function currentFile(file) {
    const { source } = file;
    if (file.promptAttachment) {
      const current = currentPromptFile(file);
      if (!current) throw new Error(t('The prompt attachment changed. Open Share again.'));
      return current;
    }
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

  async function read(files, readLocal) {
    const includesPrompt = Array.isArray(files) && files.some(file => file.promptAttachment || file.kind === 'local-prompt');
    if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error(includesPrompt
      ? t('Share up to 10 files at a time. Nothing was sent.') : t('Share up to 10 generated files at a time. Nothing was sent.'));
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
        let copy;
        if (file.kind === 'local-prompt') {
          if (!readLocal) throw new Error(t('This chat does not expose the original attachment.'));
          copy = await readLocal(file);
        } else {
          const current = await currentFile(file);
          if (current.kind === 'unavailable') throw new Error(current.promptAttachment
            ? t('This chat does not expose the original attachment.') : t('The file card has no download control.'));
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
          copy = await capture(download, file.name, file.matchName);
        }
        if (pageKey() !== page) throw new Error(t('The reply changed while its file was being read.'));
        if (file.kind !== 'local-prompt') await currentFile(file);
        if (!copy || typeof copy.data !== 'string') throw new Error(t('The file contents were unavailable.'));
        const size = copy.data.length / 4 * 3 - (copy.data.endsWith('==') ? 2 : copy.data.endsWith('=') ? 1 : 0);
        if (size > 20 * 1024 * 1024) throw new Error(t('The file exceeds 20 MB.'));
        total += size;
        if (total > MAX_BYTES) throw new Error(includesPrompt ? t('The selected files exceed the 32 MB total limit.')
          : t('Generated files exceed the 32 MB total limit.'));
        copies.push(copy);
      } catch (error) {
        const detail = { file: file.name, error: error.message };
        throw new Error(file.promptAttachment || file.kind === 'local-prompt'
          ? t('Nothing was sent. {file}: {error} Open the share menu to choose the original file, or uncheck files to share text only.', detail)
          : t('Nothing was sent. {file}: {error} Download and attach this file manually, or uncheck generated files to share text only.', detail));
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

  globalThis.AISplitReplyFiles = Object.freeze({ list, listPrompt, stripPromptFiles, isCurrentPromptFile, read, expand });
})();
