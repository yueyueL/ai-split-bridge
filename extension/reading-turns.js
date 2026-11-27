(() => {
  'use strict';
  if (globalThis.AISplitReadingTurns) return;
  const i18n = globalThis.AISplitI18n;
  const { t } = i18n;

  const nativeIds = ['data-message-id', 'data-chatgpt-selection-message-id', 'data-turn-key', 'data-turn-id', 'data-response-id'];
  const idSelector = nativeIds.map(name => `[${name}]`).join(',');
  const turnSelector = '[data-turn-key], [data-turn-id], [data-testid^="conversation-turn-"], model-response, user-query, .message-bubble';
  const ignoreText = 'button, [role="button"], [role="toolbar"], [data-ai-split-bridge], [hidden], [aria-hidden="true"], svg, script, style, time, .sr-only, .visually-hidden';
  const views = new Map();
  const remembered = new Map();
  let current = new Map(), options, stylesheet, observer, pendingJump;

  function digest(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return hash >>> 0;
  }

  function nativeId(element) {
    if (element.matches("[data-test-id='model-response']")) {
      const answer = element.querySelector("[data-model-response-turn-id]");
      if (answer?.dataset.modelResponseTurnId) return 'gemini-response/' + answer.dataset.modelResponseTurnId;
    }
    const marker = element.closest(idSelector) || element.querySelector(idSelector);
    if (!marker) return '';
    const attr = nativeIds.find(name => marker.getAttribute(name));
    return attr ? `${attr}/${marker.getAttribute(attr)}` : '';
  }

  function describe(element, role, promptKey, id) {
    // A response can still be streaming. If it has no provider ID, the
    // preceding prompt gives it a stable identity while its text grows.
    const context = role === 'assistant' ? promptKey : '';
    const identity = id || context;
    let body = element;
    if (element.matches("[data-test-id='model-response']")) {
      body = element.querySelector("[data-testid='collapsible-response-content']") || element.querySelector("[data-model-response-turn-id]") || element;
    } else if (element.matches("[data-test-id='user-query']")) {
      body = element.querySelector("[data-testid='user-prompt-content']") || element;
    }
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        return node.matches(ignoreText) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      },
    });
    const chunks = [];
    let length = 0;
    while (walker.nextNode()) {
      const part = walker.currentNode.textContent.trim();
      if (!part) continue;
      chunks.push(identity ? part.slice(0, 120) : part);
      length += part.length;
      if (identity && length >= 120) break;
    }
    const text = chunks.join(' ').replace(/\s+/g, ' ') || element.querySelector('[data-testid="file-card-open"]')?.getAttribute('aria-label') || '';
    const label = text.length > 85 ? text.slice(0, 84).trimEnd() + '…' : text;
    const value = identity || text;
    const source = id ? 'id' : context ? 'prompt' : 'text';
    return { base: `${role}/${source}/${digest(value).toString(36)}-${value.length}`, label };
  }

  // Reuse previews and action rows for unchanged messages in long chats.
  // Native edits and streamed text invalidate only the affected message.
  function invalidate(records) {
    for (const change of records) {
      if (change.type === 'childList' && [...change.addedNodes, ...change.removedNodes].every(node => node.nodeType === 1 && node.hasAttribute('data-ai-split-bridge'))) continue;
      const target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
      for (let node = target; node; node = node.parentElement) {
        const view = views.get(node);
        if (view) { view.description = null; view.row = null; }
      }
    }
  }

  function styles() {
    if (stylesheet?.isConnected) return;
    stylesheet = document.createElement('style');
    stylesheet.dataset.aiSplitBridge = 'reading';
    // Keep the message in its original DOM so the site's state, Copy and Share
    // still work. CSS interactivity makes its clipped descendants unfocusable.
    stylesheet.textContent = `
      [data-asb-reading-collapsed] { display: block !important; box-sizing: border-box !important; height: 0 !important; min-height: 0 !important; max-height: 0 !important; padding-block: 0 !important; margin-block: 0 !important; border-block-width: 0 !important; overflow: clip !important; flex-grow: 0 !important; interactivity: inert; pointer-events: none !important; }
      [data-asb-reading-target] { outline: 2px solid currentColor !important; outline-offset: 2px; scroll-margin-block-start: clamp(48px, 8vh, 96px); }
    `;
    (document.head || document.documentElement).append(stylesheet);
  }

  const marks = {
    bookmark: 'M6 4h12v17l-6-4-6 4z',
    fold: 'm6 15 6-6 6 6',
    unfold: 'm6 9 6 6 6-6',
  };
  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', marks[name]);
    svg.append(path);
    return svg;
  }

  function button(action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.action = action;
    return button;
  }

  function makeView(element) {
    const host = document.createElement('span');
    host.dataset.aiSplitBridge = 'reading';
    host.dataset.asbReadingUi = '';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { display: inline-flex !important; vertical-align: middle; align-items: center; max-width: 100%; flex: none; color: inherit; }
      button { font: 12px/1.3 system-ui, sans-serif; color: inherit; background: transparent; border: 0; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 25px; padding: 3px 5px; cursor: pointer; }
      :host([data-chatgpt-reply]) button { color: var(--text-secondary, var(--text-primary, CanvasText)); -webkit-text-fill-color: currentColor; }
      button:hover, button:focus-visible { background: color-mix(in srgb, currentColor 10%, transparent); }
      button:focus-visible { outline: 2px solid currentColor; }
      svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linejoin: round; stroke-linecap: round; }
      [aria-pressed="true"] svg { fill: currentColor; }
      :host([data-folded]) { margin: 3px 0; border-radius: 7px; background: color-mix(in srgb, currentColor 7%, transparent); }
    `;
    const fold = button('fold'), mark = button('bookmark');
    mark.append(icon('bookmark'));
    const view = { element, host, fold, mark };
    fold.onclick = event => { event.stopPropagation(); options?.onToggleHidden(view.record); };
    mark.onclick = event => { event.stopPropagation(); options?.onToggleBookmark(view.record); };
    root.append(style, fold, mark);
    return view;
  }

  // Use native action rows where available. Some sites put these outside the
  // actual message, so a small inline group is the fallback.
  function toolbar(boundary) {
    const copies = boundary.querySelectorAll('button[aria-label^="Copy" i], button[data-copy-message], button[data-testid="copy-turn-action-button"], button[data-testid="action-bar-copy"], button[data-test-id="copy-button"]');
    for (const copy of copies) {
      if (copy.closest('pre, code, [data-testid="file-card-block"]') || /code|link/i.test(copy.getAttribute('aria-label') || '')) continue;
      for (let row = copy.parentElement; row && row !== boundary; row = row.parentElement) {
        if (row.querySelector('p, pre, [contenteditable="true"], [data-testid="file-card-block"]')) break;
        if (row.matches('[role="toolbar"]') || row.querySelectorAll('button').length >= 2) return row;
      }
    }
    return boundary;
  }

  function dispose(view) {
    view.host.remove();
    view.boundary?.removeAttribute('data-asb-reading-collapsed');
    view.boundary?.removeAttribute('data-asb-reading-target');
    clearTimeout(view.highlight);
  }

  function keys(items) { return new Set(Array.from(items || [], item => typeof item === 'string' ? item : item.key)); }

  // Virtualized chats remove old turns as you scroll. Keep an offset only for
  // bookmarks measured in this page session. The storage keys contain no text.
  function remember(view) {
    const target = view.collapsed ? view.host : view.boundary;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    let scroller = target.parentElement;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /^(auto|scroll|overlay)$/.test(getComputedStyle(scroller).overflowY))) {
      scroller = scroller.parentElement;
    }
    const root = document.scrollingElement || document.documentElement;
    scroller ||= root;
    const origin = scroller === root ? 0 : scroller.getBoundingClientRect().top + scroller.clientTop;
    const top = scroller.scrollTop + rect.top - origin;
    remembered.set(view.record.key, { record: view.record, scroller, top, extent: scroller.scrollHeight });
  }

  function render(state) {
    options = state;
    styles();
    if (!observer) {
      observer = new MutationObserver(invalidate);
      observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    } else invalidate(observer.takeRecords());
    const hidden = keys(state.hidden), bookmarks = keys(state.bookmarks);
    for (const key of remembered.keys()) if (!bookmarks.has(key)) remembered.delete(key);
    // A provider can clone a whole turn while re-rendering. cloneNode carries
    // marker attributes but cannot copy our shadow controls or event handlers.
    for (const host of document.querySelectorAll('[data-asb-reading-ui]')) if (!host.shadowRoot) host.remove();
    const adapter = globalThis.AISplitAdapters;
    const entries = adapter?.messageElements({ withReplyTools: true }) || [];
    const active = new Set(entries.map(entry => entry.element));
    for (const [element, view] of views) if (!active.has(element)) { dispose(view); views.delete(element); }
    // A single native turn wrapper can hold both a question and its answer.
    // Only fold the wrapper when it belongs to precisely one message.
    const wrappers = new Map(), wrapperCounts = new Map();
    for (const { element } of entries) {
      const wrapper = element.closest(turnSelector);
      if (!wrapper || wrapper === document.body || wrapper.querySelector('textarea, [contenteditable="true"], main, nav, aside')) continue;
      wrappers.set(element, wrapper);
      wrapperCounts.set(wrapper, 0);
    }
    for (const { element } of entries) {
      for (let node = element; node; node = node.parentElement) {
        if (wrapperCounts.has(node)) wrapperCounts.set(node, wrapperCounts.get(node) + 1);
      }
    }
    const occurrences = new Map();
    let promptKey = '';
    current = new Map();
    for (const { element, role, toolbar: replyBar } of entries) {
      let view = views.get(element);
      if (!view) { view = makeView(element); views.set(element, view); }
      const context = role === 'assistant' ? promptKey : '';
      const id = nativeId(element);
      if (!view.description || view.context !== context || view.id !== id || view.role !== role) {
        view.description = describe(element, role, context, id);
        view.context = context;
        view.id = id;
      }
      const { base, label } = view.description;
      const ordinal = occurrences.get(base) || 0;
      occurrences.set(base, ordinal + 1);
      const record = { key: `${base}/${ordinal}`, label, role };
      if (role === 'user') promptKey = record.key;
      const collapsed = hidden.has(record.key), marked = bookmarks.has(record.key);
      const prompt = role === 'user', language = i18n.language;
      const chatgptReply = role === 'assistant' && adapter.provider === 'chatgpt';
      view.host.toggleAttribute('data-chatgpt-reply', chatgptReply);
      const wrapper = wrappers.get(element);
      const boundary = wrapperCounts.get(wrapper) === 1 ? wrapper : element;
      if (view.boundary !== boundary) {
        view.boundary?.removeAttribute('data-asb-reading-collapsed');
        view.row = null;
      }
      view.boundary = boundary;
      view.record = record;
      current.set(record.key, view);
      if (view.collapsed !== collapsed || view.role !== role || view.language !== language) {
        const title = collapsed ? (prompt ? t('Show prompt') : t('Show reply')) : (prompt ? t('Hide prompt') : t('Hide reply'));
        view.fold.replaceChildren(icon(collapsed ? 'unfold' : 'fold'));
        if (collapsed || chatgptReply) view.fold.append(document.createTextNode(collapsed ? title : t('Hide')));
        view.fold.title = title;
        view.fold.setAttribute('aria-label', title);
        view.fold.setAttribute('aria-expanded', String(!collapsed));
        view.host.toggleAttribute('data-folded', collapsed);
      }
      if (view.marked !== marked || view.role !== role || view.language !== language) {
        const title = marked ? t('Remove bookmark') : prompt ? t('Bookmark prompt') : t('Bookmark reply');
        view.mark.title = title;
        view.mark.setAttribute('aria-label', title);
        view.mark.setAttribute('aria-pressed', String(marked));
      }
      if (collapsed) {
        if (view.host.nextSibling !== boundary || view.host.parentElement !== boundary.parentElement) boundary.before(view.host);
      } else if (chatgptReply) {
        // A ChatGPT answer may itself contain an editor with Copy, Save as Page
        // and Open editor. Mount only in the reply's own actions, or directly
        // after the reply when the native action row has not mounted.
        if (replyBar && !replyBar.closest('[hidden], [inert], [aria-hidden="true"]')) {
          if (view.host.parentElement !== replyBar) replyBar.prepend(view.host);
        } else if (boundary.nextElementSibling !== view.host) boundary.after(view.host);
      } else {
        if (!view.row || !boundary.contains(view.row)) view.row = toolbar(boundary);
        if (view.host.parentElement !== view.row) view.row.append(view.host);
      }
      boundary.toggleAttribute('data-asb-reading-collapsed', collapsed);
      Object.assign(view, { collapsed, marked, role, language });
      if (marked) remember(view);
    }
    const records = Array.from(current.values(), view => view.record);
    for (const [key, anchor] of remembered) {
      if (!current.has(key) && anchor.scroller.isConnected) records.push(anchor.record);
    }
    return records;
  }

  function reveal(view) {
    if (view.collapsed) options.onToggleHidden(view.record);
    // The controller re-renders after updating storage. The placeholder has
    // the same location if that write is still pending.
    const target = view.boundary.hasAttribute('data-asb-reading-collapsed') ? view.host : view.boundary;
    view.boundary.setAttribute('data-asb-reading-target', '');
    target.scrollIntoView?.({ block: 'start', inline: 'nearest', behavior: 'instant' });
    clearTimeout(view.highlight);
    view.highlight = setTimeout(() => view.boundary.removeAttribute('data-asb-reading-target'), 1500);
    return true;
  }

  function loaded(key) {
    const view = current.get(key);
    return view?.element.isConnected && view.boundary.isConnected && nativeId(view.element) === view.id ? view : null;
  }

  function scrollTo(scroller, top) {
    if (typeof scroller.scrollTo === 'function') scroller.scrollTo({ top, behavior: 'instant' });
    else scroller.scrollTop = top;
  }

  async function recover(key, anchor) {
    const { scroller, top, extent } = anchor;
    const initialTop = scroller.scrollTop, page = location.href;
    const step = Math.max(160, (scroller.clientHeight || innerHeight) * 0.65);
    const controller = new AbortController();
    pendingJump = controller;
    const stop = () => controller.abort();
    const listener = { capture: true, passive: true, signal: controller.signal };
    for (const type of ['wheel', 'touchstart', 'pointerdown', 'pagehide']) addEventListener(type, stop, listener);
    addEventListener('keydown', event => {
      if (['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', ' '].includes(event.key)) stop();
    }, listener);
    const active = () => !controller.signal.aborted && scroller.isConnected && page === location.href && remembered.has(key);
    // An earlier portion of the transcript may have been loaded or resized since
    // the bookmark was measured. Try a few offsets within the same scroll pane.
    const positions = new Set([top, top + scroller.scrollHeight - extent, top - step, top + step].map(Math.round));
    try {
      for (const position of positions) {
        if (!active()) return false;
        scrollTo(scroller, position);
        for (let i = 0; i < 9 && active(); i++) {
          // The normal DOM refresh populates current as native turns remount.
          // Looking up the key here does not scan the document while scrolling.
          const view = loaded(key);
          if (view) return reveal(view);
          await new Promise(resolve => setTimeout(resolve, 80));
        }
      }
      if (active()) scrollTo(scroller, initialTop);
      return false;
    } finally {
      controller.abort();
      if (pendingJump === controller) pendingJump = null;
    }
  }

  function jump(key) {
    pendingJump?.abort();
    const view = loaded(key);
    if (view) return reveal(view);
    const anchor = remembered.get(key);
    return anchor?.scroller.isConnected ? recover(key, anchor) : false;
  }

  function clear() {
    pendingJump?.abort();
    remembered.clear();
    for (const view of views.values()) dispose(view);
    views.clear(); current.clear();
    options = null;
    observer?.disconnect();
    observer = null;
    stylesheet?.remove();
  }

  globalThis.AISplitReadingTurns = Object.freeze({ render, jump, clear });
})();
