(() => {
  'use strict';
  const adapter = globalThis.AISplitAdapters;
  if (!adapter || globalThis.__aiSplitBridgeContentLoaded) return;
  globalThis.__aiSplitBridgeContentLoaded = true;

  const handlers = {
    ASB_READ_DRAFT: () => adapter.readPrompt(),
    ASB_PREPARE: message => adapter.preflight(message),
    ASB_STAGE: message => adapter.stage(message),
    ASB_VALIDATE: message => adapter.validate(message),
    ASB_COMMIT: message => adapter.commit(message),
    ASB_CANCEL: message => adapter.cancel(message),
    ASB_INSERT: message => adapter.insert(message),
    ASB_CAN_LEAVE: () => adapter.canLeave(),
  };
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === 'ASB_REFRESH') {
      refresh().then(() => respond({ ok: true }), () => respond({ ok: false }));
      return true;
    }
    if (!Object.hasOwn(handlers, message?.type)) return false;
    Promise.resolve().then(() => handlers[message.type](message)).then(respond, error => respond({
      ok: false, error: error.message || 'This chat could not complete the action.', retry: !!error.retry,
    }));
    return true;
  });

  const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘⇧↩' : 'Ctrl+Shift+Enter';
  const SHAPES = {
    both: [['path', { d: 'M4 7h9.5M10.5 4l3 3-3 3M4 13h12M13 10l3 3-3 3' }]],
    chevron: [['path', { d: 'M6 12l4-4 4 4' }]],
    share: [['path', { d: 'M8.5 5H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2.5M11 4h5v5M16 4l-6.5 6.5' }]],
    check: [['path', { d: 'M5 10.5l3.2 3L15 6.5' }]],
    left: [['rect', { x: '3', y: '4.5', width: '14', height: '11', rx: '2.5' }], ['path', { class: 'fill', d: 'M5.5 4.5H10v11H5.5A2.5 2.5 0 0 1 3 13V7a2.5 2.5 0 0 1 2.5-2.5z' }]],
    right: [['rect', { x: '3', y: '4.5', width: '14', height: '11', rx: '2.5' }], ['path', { class: 'fill', d: 'M10 4.5h4.5A2.5 2.5 0 0 1 17 7v6a2.5 2.5 0 0 1-2.5 2.5H10z' }]],
  };
  // Each site gets its own palette and shapes; on the page, the control also borrows the size,
  // corner shape and ink of the site's neighbouring button (--size, --radius, --ink).
  const CSS = `
    * { box-sizing:border-box; }
    .root { /* ChatGPT */
      --bg:#fff; --fg:#0d0d0d; --muted:#5d5d5d; --line:rgba(13,13,13,.1); --hover:rgba(13,13,13,.05);
      --accent:#0d0d0d; --on-accent:#fff; --danger:#e02e2a;
      --shadow:0 0 0 1px rgba(13,13,13,.04),0 12px 32px rgba(0,0,0,.12); --menu-border:1px solid var(--line);
      --menu-radius:16px; --item-radius:10px; --primary-radius:999px; --pill-radius:999px; --share-radius:8px;
      --pill-border:1px solid color-mix(in srgb,currentColor 15%,transparent); --pill-bg:transparent; --pill-weight:500; }
    .root[data-theme=dark] { --bg:#353535; --fg:#ececec; --muted:#b4b4b4; --line:rgba(255,255,255,.1); --hover:rgba(255,255,255,.08);
      --accent:#fff; --on-accent:#0d0d0d; --danger:#ff8583; --shadow:0 12px 32px rgba(0,0,0,.45); }
    .root[data-provider=claude] {
      --bg:#fff; --fg:#141413; --muted:#73726c; --line:rgba(31,30,29,.15); --hover:#f5f4ed;
      --accent:#c6613f; --on-accent:#fff; --danger:#b53333; --shadow:0 4px 24px rgba(0,0,0,.07); --menu-border:.5px solid var(--line);
      --menu-radius:12px; --item-radius:8px; --primary-radius:8px; --pill-radius:8px; --share-radius:6px;
      --pill-border:.5px solid color-mix(in srgb,currentColor 30%,transparent); --pill-weight:400; }
    .root[data-provider=claude][data-theme=dark] { --bg:#30302e; --fg:#faf9f5; --muted:#9c9a92; --line:rgba(222,220,209,.15);
      --hover:rgba(222,220,209,.07); --accent:#d97757; --on-accent:#fff; --danger:#f0a08c; --shadow:0 4px 24px rgba(0,0,0,.3); }
    .root[data-provider=gemini] {
      --bg:#f0f4f9; --fg:#1f1f1f; --muted:#444746; --line:rgba(31,31,31,.12); --hover:rgba(31,31,31,.08);
      --accent:#0b57d0; --on-accent:#fff; --danger:#b3261e; --menu-border:0;
      --shadow:0 1px 2px rgba(0,0,0,.3),0 2px 6px 2px rgba(0,0,0,.15);
      --menu-radius:16px; --item-radius:12px; --primary-radius:999px; --pill-radius:999px; --share-radius:999px;
      --pill-border:0; --pill-bg:color-mix(in srgb,currentColor 9%,transparent); }
    .root[data-provider=gemini][data-theme=dark] { --bg:#282a2c; --fg:#e3e3e3; --muted:#c4c7c5; --line:rgba(227,227,227,.12);
      --hover:rgba(227,227,227,.08); --accent:#a8c7fa; --on-accent:#062e6f; --danger:#f2b8b5;
      --shadow:0 1px 2px rgba(0,0,0,.4),0 2px 6px 2px rgba(0,0,0,.25); }
    .root[data-provider=grok] {
      --bg:#fff; --fg:#0a0a0a; --muted:#6b6b6b; --line:rgba(0,0,0,.08); --hover:rgba(0,0,0,.05);
      --accent:#0a0a0a; --on-accent:#fff; --shadow:0 8px 30px rgba(0,0,0,.1);
      --menu-radius:20px; --item-radius:12px; --share-radius:999px;
      --pill-border:1px solid color-mix(in srgb,currentColor 12%,transparent); }
    .root[data-provider=grok][data-theme=dark] { --bg:#1f1f1f; --fg:#fafafa; --muted:#a3a3a3; --line:rgba(255,255,255,.1);
      --hover:rgba(255,255,255,.07); --accent:#fafafa; --on-accent:#0a0a0a; --shadow:0 8px 30px rgba(0,0,0,.5); }

    .composer,.share { display:inline-flex; align-items:center; }
    button { font:inherit; color:inherit; cursor:pointer; -webkit-font-smoothing:antialiased; }
    button:disabled { cursor:default; opacity:.45; }
    button:focus-visible { outline:2px solid color-mix(in srgb,currentColor 40%,transparent); outline-offset:1px; }
    .icon { width:18px; height:18px; flex:none; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
    .icon .fill { fill:currentColor; stroke:none; }

    .pill { display:inline-flex; align-items:stretch; height:var(--size,36px); margin-inline-end:6px; overflow:hidden; color:var(--ink,inherit);
      border:var(--pill-border); border-radius:var(--radius,var(--pill-radius)); background:var(--pill-bg); }
    .floating .pill { margin:0; background:var(--bg); color:var(--fg); box-shadow:var(--shadow); }
    .pill button { display:inline-flex; align-items:center; gap:6px; border:0; background:transparent; font-size:14px; font-weight:var(--pill-weight,500); white-space:nowrap; }
    .pill .send { padding:0 10px 0 12px; } .pill .more { padding:0 9px 0 8px; border-left:1px solid color-mix(in srgb,currentColor 12%,transparent); }
    .pill .more .icon { width:16px; height:16px; }
    .pill button:not(:disabled):hover,.share-button:hover { background:color-mix(in srgb,currentColor 8%,transparent); }
    .share-button { display:inline-flex; align-items:center; gap:6px; height:var(--size,32px); padding:0 10px 0 8px; border:0;
      border-radius:var(--radius,var(--share-radius)); background:transparent; color:var(--ink,inherit); font-size:13px; white-space:nowrap; }

    .menu,.toast { position:fixed; inset:auto; margin:0; border:var(--menu-border); background:var(--bg); color:var(--fg);
      box-shadow:var(--shadow); font-family:var(--font,system-ui,sans-serif); -webkit-font-smoothing:antialiased; }
    .menu { width:304px; max-height:min(440px,calc(100vh - 24px)); overflow:auto; overscroll-behavior:contain; scrollbar-width:thin; scrollbar-color:color-mix(in srgb,currentColor 22%,transparent) transparent; padding:6px; border-radius:var(--menu-radius); font-size:14px; line-height:1.35; }
    .heading { margin:0; padding:8px 10px 6px; font-size:12.5px; font-weight:500; color:var(--muted); }
    .item { display:flex; align-items:center; gap:2px; }
    .row { flex:1; min-width:0; display:flex; align-items:center; gap:10px; min-height:46px; padding:6px 10px; border:0; border-radius:var(--item-radius);
      background:none; color:inherit; text-align:left; }
    button.row:not(:disabled):hover,.show:hover,.link:hover { background:var(--hover); }
    .tick { width:18px; height:18px; flex:none; display:grid; place-items:center; color:var(--accent); }
    .tick .icon { width:18px; height:18px; stroke-width:2; visibility:hidden; }
    [aria-checked=true] .tick .icon { visibility:visible; }
    .label { flex:1; min-width:0; } .name { display:block; }
    .detail { display:block; margin-top:1px; font-size:12.5px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .show { flex:none; display:grid; place-items:center; width:36px; height:36px; border:0; border-radius:var(--item-radius); background:none; color:var(--muted); }
    .show:hover { color:var(--fg); }
    .footer { margin:4px -6px -6px; padding:10px 10px 8px; border-top:1px solid var(--line); }
    .primary { width:100%; height:40px; border:0; border-radius:var(--primary-radius); background:var(--accent); color:var(--on-accent); font-weight:500; }
    .primary:not(:disabled):hover { background:color-mix(in srgb,var(--accent) 88%,var(--bg)); }
    .link { width:100%; margin-top:4px; padding:8px; border:0; border-radius:var(--item-radius); background:none; font-size:13px; }
    .hint { margin:0; padding:8px 10px 2px; font-size:12px; line-height:1.4; color:var(--muted); text-align:center; }
    .menu > .hint { padding-bottom:6px; }
    .toast { max-width:340px; padding:11px 15px; border-radius:min(var(--menu-radius),14px); font-size:13.5px; line-height:1.45; }
    .toast.error { color:var(--danger); }
  `;

  function el(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  function button(className, text = '') {
    const node = el('button', className, text);
    node.type = 'button';
    return node;
  }
  function icon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'icon');
    for (const [tag, attributes] of SHAPES[name]) {
      const shape = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
      svg.append(shape);
    }
    return svg;
  }
  function label(name, detail) {
    const node = el('span', 'label');
    node.append(el('span', 'name', name), el('span', 'detail', detail));
    return node;
  }
  // A custom tag keeps the sites' generic span/div styles off the injected controls.
  function host(kind) {
    const node = document.createElement('ai-split-bridge');
    node.setAttribute('data-ai-split-bridge', kind);
    const shadow = node.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = CSS;
    const root = el('div', `root ${kind}`);
    root.dataset.provider = adapter.provider;
    shadow.append(style, root);
    // Keeps the caret in the site's composer and any selected reply text intact.
    root.addEventListener('mousedown', event => { if (kind !== 'layer') event.preventDefault(); });
    return { node, root };
  }
  // Follows the site's own light or dark theme, which may differ from the system setting.
  function appearance() {
    const channels = style => (style.color.match(/[\d.]+/g) || []).map(Number);
    let style = getComputedStyle(adapter.styleSource?.() || document.body || document.documentElement);
    if (channels(style)[3] === 0) style = getComputedStyle(document.body || document.documentElement);
    const [r = 0, g = 0, b = 0] = channels(style);
    // A browser-default serif means the site never set a UI font on that element.
    const font = /^(("?)Times( New Roman)?\2|serif)\s*(,|$)/i.test(style.fontFamily) ? 'system-ui, sans-serif' : style.fontFamily;
    return { theme: 0.299 * r + 0.587 * g + 0.114 * b > 150 ? 'dark' : 'light', font };
  }
  function paint(root, look = appearance()) {
    root.dataset.theme = look.theme;
    root.style.setProperty('--font', look.font);
  }
  // Matches the height and corner shape of the site's neighbouring button, and its ink when it is a plain icon button.
  function borrow(root, node, [min, max], fallback) {
    const site = node && (node.matches('button') ? node : node.querySelector('button'));
    const height = site?.getBoundingClientRect().height || 0;
    root.style.setProperty('--size', height >= min && height <= max ? `${Math.round(height)}px` : fallback);
    if (!site) return;
    const style = getComputedStyle(site);
    const radius = parseFloat(style.borderTopLeftRadius) || 0;
    if (!radius || !height) root.style.removeProperty('--radius');
    else root.style.setProperty('--radius', (style.borderTopLeftRadius.endsWith('%') ? radius >= 50 : radius >= height / 2 - 1) ? '999px' : `${radius}px`);
    // A filled button (such as Send) has ink meant for its own background, so it is not borrowed.
    const clear = /^(transparent|rgba\(.*,\s*0\))$/.test(style.backgroundColor);
    if (clear && style.color) root.style.setProperty('--ink', style.color); else root.style.removeProperty('--ink');
  }
  const list = names => names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const capital = side => side[0].toUpperCase() + side.slice(1);

  // Menus and notices live in the top layer so composer containers with clipping cannot hide them.
  const layer = host('layer');
  layer.node.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');
  const notice = el('div', 'toast');
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  for (const [node, mode] of [[menu, 'auto'], [notice, 'manual']]) {
    if (typeof node.showPopover === 'function') node.setAttribute('popover', mode);
    else node.hidden = true;
  }
  layer.root.append(menu, notice);
  document.documentElement.append(layer.node);
  const isOpen = node => typeof node.showPopover === 'function' ? node.matches(':popover-open') : !node.hidden;
  function openLayer(node) {
    if (isOpen(node)) return;
    if (typeof node.showPopover === 'function') node.showPopover(); else node.hidden = false;
  }
  function closeLayer(node) {
    if (!isOpen(node)) return;
    if (typeof node.hidePopover === 'function') node.hidePopover(); else node.hidden = true;
  }
  function place(node, anchor, above) {
    const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : { top: innerHeight - 24, bottom: innerHeight - 24, left: innerWidth - 24, right: innerWidth - 24 };
    node.style.maxHeight = '';
    const { offsetWidth: width, offsetHeight: height } = node;
    const room = { above: rect.top - 16, below: innerHeight - rect.bottom - 16 };
    let side = above ? 'above' : 'below';
    if (height > room[side]) side = room.above > room.below ? 'above' : 'below';
    if (height > room[side]) node.style.maxHeight = `${Math.max(120, Math.floor(room[side]))}px`;
    const top = side === 'above' ? Math.max(8, rect.top - 8 - node.offsetHeight) : rect.bottom + 8;
    const left = rect.left + rect.right < innerWidth ? rect.left : rect.right - width;
    node.style.top = `${Math.round(top)}px`;
    node.style.left = `${Math.round(Math.min(Math.max(8, left), innerWidth - width - 8))}px`;
  }

  let context = null, pending = false, menuAnchor = null, menuAbove = true, dismissedBy = null, noticeTimer, refreshSequence = 0;
  const chosen = new Map();
  const choiceKey = chat => `${chat.id}|${chat.provider}|${chat.side || ''}`;
  const available = chat => !chat.asleep && !chat.loading;
  const isChosen = chat => available(chat) && (chosen.get(choiceKey(chat)) ?? !!chat.side);
  const targets = () => (context?.chats || []).filter(isChosen);
  function sendLabel(count) {
    if (!count) return 'Send to…';
    if (count === 1) return 'Send both';
    return count === context.chats.filter(available).length ? 'Send all' : `Send to ${count + 1}`;
  }

  async function request(message) {
    let result;
    try { result = await chrome.runtime.sendMessage(message); }
    catch (error) {
      throw new Error(/context invalidated/i.test(error.message) ? 'The extension was updated. Refresh this page to reconnect.' : 'Could not reach the extension. Refresh this page and try again.');
    }
    if (!result?.ok) throw new Error(result?.error || 'This action could not be completed.');
    return result;
  }
  async function refresh() {
    const sequence = ++refreshSequence;
    const next = await request({ type: 'ASB_CONTEXT' });
    if (sequence !== refreshSequence) return;
    context = next;
    const keys = new Set(context.chats.map(choiceKey));
    for (const key of chosen.keys()) if (!keys.has(key)) chosen.delete(key);
    scan();
  }

  function toast(anchor, text, error = false) {
    clearTimeout(noticeTimer);
    notice.textContent = text;
    notice.classList.toggle('error', error);
    paint(layer.root);
    openLayer(notice);
    place(notice, anchor, true);
    noticeTimer = setTimeout(() => closeLayer(notice), error ? 9000 : 4500);
  }
  notice.addEventListener('click', () => closeLayer(notice));

  async function run(anchor, action) {
    if (pending) return;
    pending = true;
    renderComposer();
    try {
      const result = await action();
      toast(anchor, result.message, !!result.partial);
    } catch (error) {
      toast(anchor, error.message, true);
    } finally {
      pending = false;
      renderComposer();
      refresh().catch(() => {});
    }
  }

  // ---------- Send from this composer ----------
  const composer = host('composer');
  const pill = el('div', 'pill');
  const sendButton = button('send');
  const sendText = el('span', 'text');
  sendButton.append(icon('both'), sendText);
  const moreButton = button('more');
  moreButton.append(icon('chevron'));
  moreButton.setAttribute('aria-label', 'Choose chats to send to');
  moreButton.setAttribute('aria-haspopup', 'menu');
  pill.append(sendButton, moreButton);
  composer.root.append(pill);
  let composerFloating = false;

  function renderComposer(look) {
    const shown = !!context?.chats.length && composer.node.isConnected;
    composer.node.style.cssText = !shown ? 'display:none' : composerFloating
      ? 'display:inline-flex;position:fixed;right:20px;bottom:96px;z-index:2147483646' : 'display:inline-flex;align-items:center;flex:none';
    composer.root.classList.toggle('floating', composerFloating);
    if (!shown) return;
    paint(composer.root, look);
    const picked = targets();
    sendText.textContent = pending ? 'Working…' : sendLabel(picked.length);
    sendButton.title = picked.length ? `Send here and to ${list(picked.map(chat => chat.name))} (${SHORTCUT})` : 'Choose the chats to send to';
    sendButton.disabled = moreButton.disabled = pending;
  }

  function sendNow() {
    const picked = targets();
    if (!picked.length) return toggleMenu(moreButton, renderSendMenu, true);
    closeLayer(menu);
    return run(pill, () => request({ type: 'ASB_SEND', targetIds: picked.map(chat => chat.id) }));
  }

  function showButton(choice, name) {
    const node = button('show');
    const side = context.peer.side;
    node.append(icon(side));
    node.title = `Show ${name} on the ${side}`;
    node.setAttribute('aria-label', node.title);
    node.disabled = pending;
    node.addEventListener('click', () => {
      closeLayer(menu);
      run(menuAnchor, () => request({ type: 'ASB_SHOW', ...choice }));
    });
    return node;
  }

  const titled = (spot, chat) => chat.title && chat.title !== chat.name ? `${spot} · ${chat.title}` : spot;
  function where(chat) {
    return titled(chat.side ? `${capital(chat.side)} side` : chat.asleep ? 'Asleep · open its tab first' : chat.loading ? 'Loading…' : 'Other tab', chat);
  }

  function renderSendMenu() {
    menu.replaceChildren(el('p', 'heading', 'Send this prompt to'));
    for (const chat of context.chats) {
      const item = el('div', 'item');
      const row = button('row');
      row.setAttribute('role', 'menuitemcheckbox');
      row.setAttribute('aria-checked', String(isChosen(chat)));
      row.disabled = pending || !available(chat);
      row.title = chat.title;
      const tick = el('span', 'tick');
      tick.append(icon('check'));
      row.append(label(chat.name, where(chat)), tick);
      row.addEventListener('click', () => {
        chosen.set(choiceKey(chat), !isChosen(chat));
        renderSendMenu();
        renderComposer();
      });
      item.append(row);
      if (!chat.side && context.peer) item.append(showButton({ targetId: chat.id }, chat.name));
      menu.append(item);
    }
    if (context.peer) {
      for (const entry of context.closed) {
        const item = el('div', 'item');
        const row = el('div', 'row');
        row.append(label(entry.name, entry.remembered ? 'Earlier chat' : 'Not open'));
        item.append(row, showButton({ provider: entry.provider }, entry.name));
        menu.append(item);
      }
    }
    const footer = el('div', 'footer');
    const count = targets().length;
    const go = button('primary', count ? sendLabel(count) : 'Choose a chat');
    go.disabled = pending || !count;
    go.addEventListener('click', sendNow);
    footer.append(go);
    if (!shares.size) {
      const latest = button('link', 'Share this chat’s latest reply…');
      latest.addEventListener('click', () => {
        let reply;
        try { reply = adapter.getResponse(); } catch (error) { closeLayer(menu); return toast(pill, error.message, true); }
        renderShareMenu(reply);
        place(menu, menuAnchor, menuAbove);
      });
      footer.append(latest);
    }
    footer.append(el('p', 'hint', `${SHORTCUT} sends to the checked chats`));
    menu.append(footer);
  }

  async function toggleMenu(trigger, render, above) {
    const wasOpen = dismissedBy === trigger || (isOpen(menu) && menuAnchor === trigger);
    dismissedBy = null;
    if (wasOpen) return closeLayer(menu);
    try { await refresh(); } catch (error) { return toast(trigger, error.message, true); }
    menuAnchor = trigger;
    menuAbove = above;
    paint(layer.root);
    render();
    openLayer(menu);
    place(menu, trigger, above);
  }
  // A click on the trigger of an open menu first light-dismisses it; remember that so the click doesn't reopen it.
  moreButton.addEventListener('pointerdown', () => { dismissedBy = isOpen(menu) && menuAnchor === moreButton ? moreButton : null; });
  sendButton.addEventListener('click', sendNow);
  moreButton.addEventListener('click', () => toggleMenu(moreButton, renderSendMenu, true));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !event.shiftKey || !(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return;
    if (!targets().length || !adapter.ownsEditor(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    sendNow();
  }, true);

  // ---------- Share a reply ----------
  const shares = new Map();

  function renderShareMenu(reply) {
    const other = context.peer?.side;
    const draft = context.shareMode === 'draft';
    const what = reply.partial ? 'the selected text' : 'this reply';
    menu.replaceChildren(el('p', 'heading', draft ? `Share ${what} with` : `Send ${what} to`));
    const add = (name, detail, disabled, choice) => {
      const row = button('row');
      row.setAttribute('role', 'menuitem');
      row.disabled = pending || disabled;
      row.append(label(name, detail));
      row.addEventListener('click', () => {
        closeLayer(menu);
        run(menuAnchor, () => request({ type: 'ASB_SHARE', ...choice, reply: reply.text }));
      });
      menu.append(row);
    };
    for (const chat of context.chats) {
      const direct = !!chat.side || !other;
      add(chat.name, direct ? where(chat) : titled(`Opens on the ${other}`, chat), direct && !available(chat), { targetId: chat.id });
    }
    if (other) {
      for (const entry of context.closed) {
        add(entry.name, `Opens on the ${other} · ${entry.remembered ? 'earlier chat' : 'new chat'}`, false, { provider: entry.provider });
      }
    }
    menu.append(el('p', 'hint', draft
      ? 'Added as a draft for you to review and send.'
      : 'Sent right away with your share message.'));
  }

  function shareHost(response) {
    const view = host('share');
    const trigger = button('share-button');
    trigger.append(icon('share'), el('span', '', 'Share with…'));
    trigger.title = 'Share this reply with another chat';
    trigger.addEventListener('pointerdown', () => { dismissedBy = isOpen(menu) && menuAnchor === trigger ? trigger : null; });
    trigger.addEventListener('click', () => {
      let reply;
      try { reply = adapter.replyText(response); } catch (error) { return toast(trigger, error.message, true); }
      toggleMenu(trigger, () => renderShareMenu(reply), false);
    });
    view.root.append(trigger);
    return view;
  }

  function canShare() {
    return !!context && (context.chats.length > 0 || (!!context.peer && context.closed.length > 0));
  }

  // ---------- Keep controls beside the sites' own buttons ----------
  function mountComposer(look) {
    const anchor = adapter.composerAnchor();
    const node = composer.node;
    composerFloating = false;
    if (anchor) {
      if (node.parentNode !== anchor.parent || node.nextSibling !== anchor.before) anchor.parent.insertBefore(node, anchor.before);
      borrow(composer.root, anchor.before || anchor.parent.querySelector('button'), [28, 48], '36px');
    } else {
      let hasComposer = true;
      try { adapter.getDraft(); } catch { hasComposer = false; }
      composerFloating = hasComposer;
      if (!hasComposer) node.remove();
      else if (node.parentNode !== document.documentElement) document.documentElement.append(node);
    }
    renderComposer(look);
  }

  function mountShares(look) {
    const seen = new Set();
    const shown = canShare();
    for (const { parent, before, response } of adapter.replyAnchors()) {
      let view = shares.get(response);
      if (!view) shares.set(response, view = shareHost(response));
      seen.add(response);
      if (view.node.parentNode !== parent || view.node.nextSibling !== before) parent.insertBefore(view.node, before);
      borrow(view.root, parent.querySelector('button'), [24, 44], '32px');
      view.node.style.cssText = shown ? 'display:inline-flex;align-items:center;flex:none' : 'display:none';
      paint(view.root, look);
    }
    for (const [response, view] of shares) {
      if (!seen.has(response)) { view.node.remove(); shares.delete(response); }
    }
  }

  function scan() {
    if (!context) return;
    const look = appearance();
    mountComposer(look);
    mountShares(look);
  }
  let scanTimer = null;
  new MutationObserver(() => {
    if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 250);
  }).observe(document.documentElement, { childList: true, subtree: true });
  addEventListener('scroll', () => {
    if (isOpen(menu) && menuAnchor) requestAnimationFrame(() => place(menu, menuAnchor, menuAbove));
  }, { capture: true, passive: true });
  addEventListener('resize', () => closeLayer(menu));

  refresh().catch(() => {});
})();
