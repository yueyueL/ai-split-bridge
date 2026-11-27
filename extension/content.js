(() => {
  'use strict';
  const adapter = globalThis.AISplitAdapters;
  if (!adapter || globalThis.__aiSplitBridgeContentLoaded) return;
  globalThis.__aiSplitBridgeContentLoaded = true;
  const i18n = globalThis.AISplitI18n;
  const { t } = i18n;

  const handlers = {
    ASB_COMPARE_STATUS: () => adapter.compareStatus(),
    ASB_COMPARE_READ: message => adapter.readCompareAnswer(message),
    ASB_COMPARE_CHECK: message => adapter.checkCompareAnswer(message),
    ASB_REVIEW_RESULT: message => adapter.reviewResult(message),
    ASB_READ_DRAFT: () => adapter.readPrompt(),
    ASB_PREPARE: message => adapter.preflight(message),
    ASB_STAGE: message => adapter.stage(message),
    ASB_VALIDATE: message => adapter.validate(message),
    ASB_COMMIT: message => adapter.commit(message),
    ASB_KEEP: message => adapter.keep(message),
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
      ok: false, error: error.message || t('This chat could not complete the action.'), retry: !!error.retry,
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

    .root { font-family:var(--font,system-ui,sans-serif); color:var(--fg); -webkit-text-fill-color:currentColor; visibility:visible; }
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
    .share-actions,.review-actions { display:inline-flex; align-items:center; }
    .share-actions.paired .share-primary,.review-actions .cross-review { padding-inline-end:3px; }
    .share-actions .share-options,.review-actions .review-options { min-width:24px; padding:0 4px; justify-content:center; }
    .share-options[hidden] { display:none; }
    .share-options .icon,.review-options .icon { width:14px; height:14px; transform:rotate(180deg); }
    @media (max-width:640px) {
      .root.share { flex-wrap:wrap; max-width:100%; }
      .share-button { padding-inline:6px; }
    }

    .menu,.toast { position:fixed; inset:auto; margin:0; border:var(--menu-border); background:var(--bg); color:var(--fg);
      box-shadow:var(--shadow); font-family:var(--font,system-ui,sans-serif); -webkit-font-smoothing:antialiased; }
    .menu { width:min(304px,calc(100vw - 16px)); max-height:min(440px,calc(100vh - 24px)); overflow-x:hidden; overflow-y:auto; overscroll-behavior:contain; scrollbar-width:thin; scrollbar-color:color-mix(in srgb,currentColor 22%,transparent) transparent; padding:6px; border-radius:var(--menu-radius); font-size:14px; line-height:1.35; }
    .heading { margin:0; padding:8px 10px 6px; font-size:12.5px; font-weight:500; color:var(--muted); }
    .item { display:flex; align-items:center; gap:2px; }
    .row { flex:1; min-width:0; display:flex; align-items:center; gap:10px; min-height:46px; padding:6px 10px; border:0; border-radius:var(--item-radius);
      background:none; color:inherit; text-align:left; }
    .menu > .row { width:100%; }
    .share-destination { display:block; width:calc(100% - 20px); margin:0 10px 6px; border:1px solid var(--line); border-radius:var(--item-radius);
      padding:6px; color:var(--fg); background:var(--bg); font:inherit; }
    .action-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:4px 10px; }
    .action-head .heading { padding:0; }
    .action-head .link { width:auto; margin:0; padding:4px 6px; }
    .action-list { max-height:180px; overflow-y:auto; overscroll-behavior:contain; }
    .action-list .row { width:100%; min-height:32px; overflow-wrap:anywhere; }
    .action-list .name { flex:1; } .action-list .detail { flex:none; }
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
    .file-option { display:flex; align-items:center; gap:7px; padding:6px 10px 2px; font-size:13px; color:var(--fg); cursor:pointer; }
    .file-option input { margin:0; accent-color:var(--accent); }
    .prompt-originals { margin:4px 10px 8px; font-size:12px; color:var(--muted); }
    .prompt-originals label { display:block; overflow-wrap:anywhere; margin-top:6px; }
    .prompt-originals input { display:block; max-width:100%; margin-top:4px; color:var(--fg); font:inherit; }
    .instructions { margin:4px 10px 6px; padding:5px 0 7px; border-bottom:1px solid var(--line); }
    .instructions summary { color:var(--fg); cursor:pointer; padding:4px 0; font-size:13px; }
    .instruction-list { max-height:104px; overflow-y:auto; overscroll-behavior:contain; }
    .instructions .file-option { padding-inline:0; overflow-wrap:anywhere; }
    .instructions textarea { display:block; width:100%; margin-top:6px; padding:7px 8px; min-height:34px; max-height:120px; field-sizing:content; resize:vertical;
      font:inherit; font-size:13px; color:inherit; background:transparent; border:1px solid var(--line); border-radius:8px; }
    .instruction-hint { margin:6px 0 0; font-size:12px; color:var(--muted); }
    .instructions textarea::placeholder { color:var(--muted); }
    .menu > .link { margin-block:3px; }
    .body-hint { padding-block-end:8px; text-align:start; }
    .file-names { margin:0 10px 5px; padding:3px 0 9px; border-bottom:1px solid var(--line); color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
    .message-list { max-height:260px; overflow:auto; overscroll-behavior:contain; }
    .message-choice { display:flex; align-items:flex-start; gap:9px; padding:9px 10px; border-radius:var(--item-radius); cursor:pointer; }
    .message-choice:hover { background:var(--hover); }
    .message-choice input { margin:3px 0 0; accent-color:var(--accent); flex:none; }
    .message-choice .detail { white-space:normal; display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
    .selection-actions { display:flex; gap:4px; padding:0 6px 5px; }
    .selection-actions .link { width:auto; margin:0; padding:5px 8px; font-size:12px; }
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
    const [r, g, b, alpha] = (style.color.match(/[\d.]+/g) || []).map(Number);
    const lightness = .299 * r + .587 * g + .114 * b;
    const dark = (root.dataset.theme || appearance().theme) === 'dark';
    const readable = dark ? lightness > 80 : lightness < 175;
    if (clear && style.color && readable && style.color !== 'transparent' && (alpha === undefined || alpha > .25)) root.style.setProperty('--ink', style.color);
    else root.style.removeProperty('--ink');
  }

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
    if (!count) return t('Send to…');
    if (count === 1) return t('Send both');
    return count === context.chats.filter(available).length ? t('Send all') : t('Send to {count}', { count: count + 1 });
  }

  async function request(message) {
    let result;
    try { result = await chrome.runtime.sendMessage(message); }
    catch (error) {
      throw new Error(/context invalidated/i.test(error.message) ? t('The extension was updated. Refresh this page to reconnect.') : t('Could not reach the extension. Refresh this page and try again.'));
    }
    if (!result?.ok) throw new Error(result?.error || t('This action could not be completed.'));
    return result;
  }
  async function refresh() {
    const sequence = ++refreshSequence;
    const next = await request({ type: 'ASB_CONTEXT' });
    if (sequence !== refreshSequence) return;
    context = next;
    if (isOpen(menu)) {
      if (openInstructions?.node.isConnected) openInstructions.update();
      if (openActions?.node.isConnected) openActions.update();
    }
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
  moreButton.setAttribute('aria-haspopup', 'menu');
  pill.append(sendButton, moreButton);
  composer.root.append(pill);
  let composerFloating = false, controlsBusy = false;

  function renderComposer(look) {
    if (controlsBusy !== pending) {
      controlsBusy = pending;
      for (const trigger of [compareButton, quickReview, reviewOptions]) trigger.disabled = pending;
      for (const views of [shares, prompts]) for (const view of views.values()) view.setBusy(pending);
    }
    const shown = !!context && composer.node.isConnected;
    const solo = !context?.chats.length;
    moreButton.hidden = solo;
    moreButton.style.display = solo ? 'none' : '';
    composer.node.style.cssText = !shown ? 'display:none' : composerFloating
      ? 'display:inline-flex;position:fixed;right:20px;bottom:96px;z-index:2147483646' : 'display:inline-flex;align-items:center;flex:none';
    composer.root.classList.toggle('floating', composerFloating);
    if (!shown) return;
    paint(composer.root, look);
    const picked = targets();
    sendText.textContent = pending ? t('Working…') : solo ? t('Summarize…') : sendLabel(picked.length);
    sendButton.title = solo ? t('Summarize this chat') : picked.length
      ? t('Send here and to {names} ({shortcut})', { names: i18n.list(picked.map(chat => chat.name)), shortcut: SHORTCUT })
      : t('Choose the chats to send to');
    sendButton.disabled = moreButton.disabled = pending;
  }

  function sendNow() {
    if (!context?.chats.length) return toggleMenu(sendButton, renderSummaryMenu, true);
    const picked = targets();
    if (!picked.length) return toggleMenu(moreButton, renderSendMenu, true);
    closeLayer(menu);
    return run(pill, () => request({ type: 'ASB_SEND', targetIds: picked.map(chat => chat.id) }));
  }

  function showButton(choice, name) {
    const node = button('show');
    const side = context.peer.side;
    node.append(icon(side));
    node.title = side === 'left' ? t('Show {name} on the left', { name }) : t('Show {name} on the right', { name });
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
    const spot = chat.side === 'left' ? t('Left side') : chat.side ? t('Right side')
      : chat.asleep ? t('Asleep · open its tab first') : chat.loading ? t('Loading…') : t('Other tab');
    return titled(spot, chat);
  }

  function renderSendMenu() {
    menu.replaceChildren(el('p', 'heading', t('Send this prompt to')));
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
        row.append(label(entry.name, entry.remembered ? t('Earlier chat') : t('Not open')));
        item.append(row, showButton({ provider: entry.provider }, entry.name));
        menu.append(item);
      }
    }
    const footer = el('div', 'footer');
    const count = targets().length;
    const go = button('primary', count ? sendLabel(count) : t('Choose a chat'));
    go.disabled = pending || !count;
    go.addEventListener('click', sendNow);
    footer.append(go);
    const summary = button('link summarize', t('Summarize this chat…'));
    summary.disabled = pending;
    summary.addEventListener('click', renderSummaryMenu);
    footer.append(summary);
    const handoff = button('link share-context', t('Share latest reply as context…'));
    handoff.disabled = pending;
    handoff.addEventListener('click', () => shareLatest(true));
    footer.append(handoff);
    // Gemini can expose action bars for older turns before the newest one has any controls.
    if (!shares.size || adapter.provider === 'gemini') {
      const latest = button('link', t('Share this chat’s latest reply…'));
      latest.addEventListener('click', () => shareLatest(false));
      footer.append(latest);
    }
    if (adapter.messages && adapter.readMessages) {
      const select = button('link select-messages', t('Select messages…'));
      select.disabled = pending;
      select.addEventListener('click', () => {
        try { renderMessagePicker(); } catch (error) { closeLayer(menu); toast(pill, error.message, true); }
      });
      footer.append(select);
    }
    for (const [action, title] of [['compare', t('Compare latest answers…')], ['cross-review', t('Cross-review…')]]) {
      const link = button(`link ${action}`, title);
      link.disabled = pending;
      link.addEventListener('click', () => renderPairMenu(action));
      footer.append(link);
    }
    footer.append(el('p', 'hint', t('{shortcut} sends to the checked chats', { shortcut: SHORTCUT })));
    menu.append(footer);
  }

  async function shareLatest(handoff) {
    const anchor = menuAnchor, page = location.href;
    try {
      const reply = await (adapter.readResponse ? adapter.readResponse() : adapter.getResponse());
      if (!isOpen(menu) || menuAnchor !== anchor || location.href !== page) return;
      renderShareMenu(reply, { handoff });
      place(menu, anchor, menuAbove);
    } catch (error) {
      closeLayer(menu);
      toast(anchor, error.message, true);
    }
  }

  function renderSummaryMenu() {
    const page = location.href;
    const heading = el('p', 'heading', t('Summarize this chat'));
    const hint = el('p', 'hint body-hint', t('Ask this assistant for a handoff with the context, decisions, key outputs, and next steps.'));
    const generate = button('primary', t('Generate summary'));
    const draft = button('link', t('Add as a draft'));
    for (const [trigger, send] of [[generate, true], [draft, false]]) {
      trigger.disabled = pending;
      trigger.addEventListener('click', () => {
        const anchor = menuAnchor;
        closeLayer(menu);
        run(anchor, async () => {
          if (location.href !== page) throw new Error(t('The conversation changed. Open the action again.'));
          return request({ type: 'ASB_SUMMARIZE', send, page });
        });
      });
    }
    menu.replaceChildren(heading, hint, generate, draft);
    place(menu, menuAnchor, menuAbove);
  }

  // The worker loads bodies for the selected IDs. The page receives only their titles.
  let openInstructions;
  function instructionOptions(kind) {
    const node = el('details', 'instructions');
    const title = el('summary');
    const list = el('div', 'instruction-list');
    const text = el('textarea');
    text.rows = 1;
    text.maxLength = 2000;
    text.placeholder = t('One-time instruction');
    text.setAttribute('aria-label', t('One-time instruction'));
    const hint = el('p', 'instruction-hint');
    node.append(title, list, text, hint);
    const overrides = new Map();
    let previous;
    function labelSelection() {
      const picked = list.querySelectorAll(':checked').length;
      title.textContent = picked ? t('Extra instructions · {count} selected', { count: picked }) : t('Extra instructions');
    }
    function update() {
      const items = (context.instructions || []).filter(item => item.kind === kind);
      const signature = JSON.stringify(items);
      if (signature === previous) return;
      previous = signature;
      const focus = node.getRootNode().activeElement;
      const focusedId = list.contains(focus) ? focus.value : null;
      list.replaceChildren(...items.map(item => {
        const row = el('label', 'file-option');
        const box = el('input');
        box.type = 'checkbox';
        box.value = item.id;
        box.checked = overrides.get(item.id) ?? !!item.useByDefault;
        box.addEventListener('change', () => {
          overrides.set(item.id, box.checked);
          labelSelection();
        });
        row.append(box, document.createTextNode(item.title));
        return row;
      }));
      if (focusedId) Array.from(list.querySelectorAll('input')).find(box => box.value === focusedId)?.focus({ preventScroll: true });
      hint.hidden = items.length > 0;
      hint.textContent = t('Save reusable instructions in the extension popup.');
      labelSelection();
      if (node.isConnected && isOpen(menu)) place(menu, menuAnchor, menuAbove);
    }
    update();
    node.addEventListener('toggle', () => {
      if (node.isConnected && isOpen(menu)) place(menu, menuAnchor, menuAbove);
    });
    openInstructions = { node, update };
    return {
      node,
      read: () => {
        const instructionIds = Array.from(list.querySelectorAll(':checked'), box => box.value);
        const instructionText = text.value.trim();
        return { instructionIds, ...(instructionText && { instructionText }) };
      },
    };
  }

  // Names and IDs are enough to run a chosen action. The worker resolves its current prompt.
  let openActions;
  function addActionButton(kind) {
    const add = button('link add-action', t('Add action…'));
    add.addEventListener('click', async () => {
      if (pending || add.disabled) return;
      add.disabled = true;
      const anchor = menuAnchor;
      closeLayer(menu);
      try { await request({ type: 'ASB_OPEN_ACTION_EDITOR', kind }); }
      catch (error) { toast(anchor, error.message, true); }
      finally { add.disabled = false; }
    });
    return add;
  }
  function actionRows(kind, invoke, enabled = () => true) {
    const node = el('div', 'workflow-actions');
    const head = el('div', 'action-head');
    head.append(el('span', 'heading', t('Actions')), addActionButton(kind));
    const list = el('div', 'action-list');
    node.append(head, list);
    let last;
    function update() {
      const actions = (context.actions || []).filter(action => action.kind === kind);
      const signature = JSON.stringify(actions);
      if (signature !== last) {
        last = signature;
        const focused = list.getRootNode().activeElement;
        const focusedId = list.contains(focused) ? focused.dataset.actionId : null;
        list.replaceChildren(...actions.map(action => {
          const row = button('row');
          row.dataset.actionId = action.id;
          row.setAttribute('role', 'menuitem');
          row.append(el('span', 'name', action.title));
          if (action.isDefault) row.append(el('span', 'detail', t('Default')));
          row.addEventListener('click', () => {
            if (row.isConnected && isOpen(menu) && !pending && enabled()) invoke(action.id);
          });
          return row;
        }));
        if (focusedId) Array.from(list.children).find(row => row.dataset.actionId === focusedId)?.focus({ preventScroll: true });
      }
      for (const row of list.children) row.disabled = !enabled();
      if (node.isConnected && isOpen(menu)) place(menu, menuAnchor, menuAbove);
    }
    update();
    openActions = { node, update };
    return openActions;
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
  sendButton.addEventListener('pointerdown', () => {
    if (!context?.chats.length) dismissedBy = isOpen(menu) && menuAnchor === sendButton ? sendButton : null;
  });
  sendButton.addEventListener('click', sendNow);
  moreButton.addEventListener('click', () => toggleMenu(moreButton, renderSendMenu, true));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !event.shiftKey || !(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return;
    if (!targets().length || !adapter.ownsEditor(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    sendNow();
  }, true);

  // ---------- Work with the latest answers in this split ----------
  function samePair(previous, page) {
    return location.href === page && context.native && context.peer && previous.peer &&
      context.peer.id === previous.peer.id && context.peer.provider === previous.peer.provider &&
      context.side === previous.side && context.shareMode === previous.shareMode;
  }
  function pairButton(action, quick = false) {
    const trigger = button(`share-button ${action}`);
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.addEventListener('pointerdown', () => {
      dismissedBy = isOpen(menu) && menuAnchor === trigger ? trigger : null;
    });
    trigger.addEventListener('click', () => {
      if (pending) return;
      const previous = { ...context }, page = location.href;
      toggleMenu(trigger, () => renderPairMenu(action, quick && samePair(previous, page) ? 'quick' : 'choose'), false);
    });
    return trigger;
  }
  const compareButton = pairButton('compare');
  const quickReview = pairButton('cross-review', true);
  const reviewOptions = pairButton('cross-review');
  reviewOptions.className = 'share-button review-options';
  reviewOptions.append(icon('chevron'));
  const reviewGroup = el('span', 'review-actions');
  reviewGroup.append(quickReview, reviewOptions);
  // These controls are built once, so their words are set here and again when the language changes.
  function labelControls() {
    moreButton.setAttribute('aria-label', t('Choose chats and conversation actions'));
    compareButton.textContent = t('Compare');
    quickReview.textContent = t('Cross-review');
    for (const [trigger, title] of [
      [compareButton, t('Compare the latest answers from both sides')],
      [quickReview, t('Cross-review both answers')],
      [reviewOptions, t('Choose a cross-review action or revise an answer')],
    ]) {
      trigger.title = title;
      trigger.setAttribute('aria-label', title);
    }
  }
  labelControls();

  async function renderPairMenu(action, mode = 'choose') {
    const crossReview = action === 'cross-review';
    const name = crossReview ? t('Cross-review') : t('Compare');
    const previous = { ...context };
    const { selfId, side, peer, shareMode } = previous;
    const page = location.href;
    const heading = el('p', 'heading', crossReview ? t('Cross-review latest answers') : t('Compare latest answers'));
    const note = el('p', 'hint');
    note.setAttribute('role', 'status');
    menu.replaceChildren(heading, note);
    if (!context.native || !peer) {
      note.textContent = crossReview ? t('Open two AI chats in Chrome Split View to cross-review their answers.')
        : t('Open two AI chats in Chrome Split View to compare their answers.');
      if (crossReview) menu.append(actionRows('review', null, () => false).node);
      place(menu, menuAnchor, menuAbove);
      return;
    }
    note.textContent = t('Checking both chats for completed answers…');
    place(menu, menuAnchor, menuAbove);
    let status;
    try { status = await request({ type: crossReview ? 'ASB_REVIEW_STATUS' : 'ASB_COMPARE_STATUS', peerId: peer.id }); }
    catch (error) { status = { ready: false, message: error.message }; }
    if (!note.isConnected || !isOpen(menu)) return;
    if (!status.ready) {
      note.textContent = status.message || t('Wait for a completed answer on each side.');
      const retry = button('link', t('Check again'));
      retry.addEventListener('click', () => renderPairMenu(action));
      menu.append(retry);
      if (crossReview) menu.append(actionRows('review', null, () => false).node);
      place(menu, menuAnchor, menuAbove);
      return;
    }

    function submit(message) {
      closeLayer(menu);
      return run(menuAnchor, async () => {
        await refresh();
        if (!samePair(previous, page)) throw new Error(t('The chats or sharing settings changed. Open {menu} again.', { menu: name }));
        return request({ peerId: peer.id, peerProvider: peer.provider, expectedMode: shareMode, ...message });
      });
    }
    function addChoice(title, detail, message) {
      const row = button('row');
      row.setAttribute('role', 'menuitem');
      row.append(label(title, detail));
      row.addEventListener('click', () => submit(message));
      menu.insertBefore(row, note);
    }
    const revision = crossReview && status.revision;
    if (crossReview && !revision && mode === 'quick') {
      return submit({ type: 'ASB_CROSS_REVIEW', turns: status.turns });
    }
    if (crossReview && (!revision || mode === 'again')) {
      heading.textContent = t('How should the assistants review each other?');
      const extras = instructionOptions('review');
      const actions = actionRows('review', actionId => submit({
        type: 'ASB_CROSS_REVIEW', actionId, turns: status.turns, ...extras.read(),
      }));
      menu.insertBefore(actions.node, note);
      menu.insertBefore(extras.node, note);
      note.textContent = shareMode === 'draft'
        ? t('Adds the selected action and the other answer as a draft in each chat.')
        : t('Each assistant receives the selected action and the other assistant’s answer.');
    } else {
      const self = { id: selfId, side, name: adapter.name };
      heading.textContent = revision ? t('Revise an answer') : t('Who should compare the two latest answers?');
      for (const chat of (side === 'left' ? [self, peer] : [peer, self])) {
        const message = revision ? { type: 'ASB_REVISE', reviewId: revision.reviewId, turns: revision.turns }
          : { type: 'ASB_COMPARE', turns: status.turns };
        addChoice(chat.name, where(chat), { ...message, targetId: chat.id });
      }
      if (revision) {
        note.textContent = shareMode === 'draft'
          ? t('Both critiques are ready. Choose a chat to draft a revision request using the other assistant’s critique.')
          : t('Both critiques are ready. Choose a chat to revise its original answer using the other assistant’s critique.');
        const again = button('link', t('Cross-review the latest replies again…'));
        again.addEventListener('click', () => renderPairMenu(action, 'again'));
        menu.append(again, addActionButton('review'));
      } else {
        note.textContent = shareMode === 'draft'
          ? t('Choosing a reviewer adds an editable comparison prompt to that chat.')
          : t('Choosing a reviewer sends both answers to that chat for comparison.');
      }
    }
    place(menu, menuAnchor, menuAbove);
  }

  // ---------- Share a reply ----------
  const shares = new Map();
  const prompts = new Map();

  function renderMessagePicker() {
    const messages = adapter.messages();
    const page = location.href;
    const picked = new Set();
    menu.replaceChildren(el('p', 'heading', t('Select messages to share')));
    const choices = el('div', 'message-list');
    choices.setAttribute('role', 'group');
    choices.setAttribute('aria-label', t('Conversation messages'));
    const controls = el('div', 'selection-actions');
    const all = button('link', t('Select all'));
    const clear = button('link', t('Clear'));
    controls.append(all, clear);
    const footer = el('div', 'footer');
    const next = button('primary', t('Choose messages'));
    next.disabled = true;
    const back = button('link', t('Back'));
    back.addEventListener('click', () => { renderSendMenu(); place(menu, menuAnchor, menuAbove); });
    const update = () => {
      next.disabled = pending || !picked.size;
      next.textContent = !picked.size ? t('Choose messages') : picked.size === 1 ? t('Share 1 message…') : t('Share {count} messages…', { count: picked.size });
    };
    const checks = messages.map((message, index) => {
      const row = el('label', 'message-choice');
      const checkbox = el('input');
      checkbox.type = 'checkbox';
      const who = message.role === 'user' ? t('You') : adapter.name;
      checkbox.setAttribute('aria-label', `${index + 1}. ${who}: ${message.text || t('Files')}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) picked.add(message.element); else picked.delete(message.element);
        update();
      });
      row.append(checkbox, label(who, message.text || t('Files')));
      choices.append(row);
      return checkbox;
    });
    all.disabled = clear.disabled = !messages.length;
    all.addEventListener('click', () => { messages.forEach((message, index) => { picked.add(message.element); checks[index].checked = true; }); update(); });
    clear.addEventListener('click', () => { picked.clear(); checks.forEach(checkbox => { checkbox.checked = false; }); update(); });
    next.addEventListener('click', async () => {
      if (pending || !picked.size) return;
      pending = true;
      renderComposer();
      checks.forEach(checkbox => { checkbox.disabled = true; });
      all.disabled = clear.disabled = next.disabled = back.disabled = true;
      next.textContent = t('Preparing…');
      let reply;
      try {
        const changed = () => new Error(t('This conversation changed. Open Select messages again.'));
        if (location.href !== page) throw changed();
        reply = await adapter.readMessages(messages.filter(message => picked.has(message.element)).map(message => message.element));
        if (location.href !== page) throw changed();
      } catch (error) {
        reply = null;
        closeLayer(menu);
        toast(menuAnchor, error.message, true);
      } finally {
        pending = false;
        renderComposer();
      }
      if (reply) { renderShareMenu({ ...reply, conversation: true }); place(menu, menuAnchor, menuAbove); }
    });
    footer.append(next, back);
    menu.append(controls, choices, el('p', 'hint', messages.length
      ? t('Only messages currently loaded in this chat are listed. They keep their original order.')
      : t('No messages are loaded in this chat yet.')), footer);
    place(menu, menuAnchor, menuAbove);
  }

  function renderShareMenu(reply, { handoff = false, includeFiles = true, originals = new Map() } = {}) {
    const page = location.href;
    const previous = { ...context };
    const peer = quickSharePeer();
    const other = context.peer?.side;
    const draft = context.shareMode === 'draft';
    const heading = handoff ? t('Share as context with') : draft
      ? (reply.conversation ? t('Share the selected messages with') : reply.prompt ? t('Share this prompt with')
        : reply.partial ? t('Share the selected text with') : t('Share this reply with'))
      : (reply.conversation ? t('Send the selected messages to') : reply.prompt ? t('Send this prompt to')
        : reply.partial ? t('Send the selected text to') : t('Send this reply to'));
    menu.replaceChildren(el('p', 'heading', heading));
    if (reply.files?.length && !reply.partial) {
      const option = el('label', 'file-option');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = includeFiles;
      checkbox.disabled = !(reply.textWithoutFiles ?? reply.text)?.trim();
      const count = reply.files.length;
      const include = reply.prompt || reply.conversation
        ? (count === 1 ? t('Include 1 file') : t('Include {count} files', { count }))
        : (count === 1 ? t('Include 1 generated file') : t('Include {count} generated files', { count }));
      option.append(checkbox, document.createTextNode(` ${include}`));
      menu.append(option, el('p', 'file-names', reply.files.map(file => file.name).join(', ')));
      const uploads = reply.files.filter(file => file.promptAttachment && file.kind !== 'local-prompt');
      const pickers = el('div', 'prompt-originals');
      if (uploads.length) {
        const alternatives = el('details');
        alternatives.append(el('summary', '', t('Choose original files…')));
        for (const descriptor of uploads) {
          const caption = t('Choose original for {file}', { file: descriptor.name });
          const label = el('label', '', caption);
          const input = el('input');
          input.type = 'file';
          input.setAttribute('aria-label', caption);
          const status = el('span', '', originals.get(descriptor)?.name);
          status.setAttribute('role', 'status');
          input.addEventListener('change', () => {
            originals.delete(descriptor);
            status.textContent = '';
            const file = input.files[0];
            if (!file) return;
            if (descriptor.nameKnown && descriptor.name !== file.name) {
              status.textContent = t('Choose the file named {file}.', { file: descriptor.name });
              input.value = '';
              return;
            }
            originals.set(descriptor, file);
          });
          label.append(input, status);
          if (descriptor.kind === 'unavailable') pickers.append(label);
          else alternatives.append(label);
        }
        if (alternatives.children.length > 1) pickers.append(alternatives);
        pickers.hidden = !includeFiles;
        menu.append(pickers);
      }
      checkbox.addEventListener('change', () => {
        includeFiles = checkbox.checked;
        pickers.hidden = !includeFiles;
      });
    }
    const opens = other === 'left' ? t('Opens on the left') : t('Opens on the right');
    const destinations = context.chats.map(chat => {
      const direct = !!chat.side || !other;
      return { name: chat.name, detail: direct ? where(chat) : titled(opens, chat),
        disabled: direct && !available(chat), choice: { targetId: chat.id }, chat };
    });
    if (other) {
      for (const entry of context.closed) {
        destinations.push({ name: entry.name, detail: `${opens} · ${entry.remembered ? t('earlier chat') : t('new chat')}`,
          choice: { provider: entry.provider } });
      }
    }

    if (handoff || reply.conversation) {
      for (const { name, detail, disabled, choice } of destinations) {
        const row = button('row');
        row.setAttribute('role', 'menuitem');
        row.disabled = pending || disabled;
        row.append(label(name, detail));
        row.addEventListener('click', () => {
          closeLayer(menu);
          run(menuAnchor, () => sendShare(reply, choice, page, { handoff, includeFiles, originals }));
        });
        menu.append(row);
      }
    } else {
      const kind = reply.prompt ? 'prompt' : 'reply';
      const target = el('select', 'share-destination');
      target.setAttribute('aria-label', heading);
      target.add(new Option(t('Choose a chat…'), ''));
      let selected = '';
      destinations.forEach(({ name, detail, disabled, chat }, index) => {
        const option = new Option(`${name} · ${detail}`, String(index));
        option.disabled = !!disabled;
        target.add(option);
        if (peer && chat?.id === peer.id && !option.disabled) selected = option.value;
      });
      target.value = selected;
      const extras = instructionOptions(kind);
      const actions = actionRows(kind, actionId => {
        const { choice, chat } = destinations[Number(target.value)];
        const options = { actionId, expectedMode: previous.shareMode, ...choice };
        if (chat && chat.id === peer?.id) Object.assign(options, { peerId: peer.id, peerProvider: peer.provider, page });
        const instructions = extras.read();
        closeLayer(menu);
        run(menuAnchor, async () => {
          await refresh();
          if (location.href !== page || previous.shareMode !== context.shareMode || previous.peer?.id !== context.peer?.id
            || previous.peer?.provider !== context.peer?.provider || previous.side !== context.side) {
            throw new Error(t('The chats or sharing settings changed. Open {menu} again.', { menu: t('Share') }));
          }
          if (chat && !context.chats.some(current => current.id === chat.id && current.provider === chat.provider)) {
            throw new Error(t('That chat closed or changed. Open Share again.'));
          }
          return sendShare(reply, options, page, { includeFiles, instructions, originals });
        });
      }, () => target.value !== '');
      target.addEventListener('change', actions.update);
      menu.insertBefore(target, menu.children[1] || null);
      menu.append(actions.node, extras.node);
    }
    if (!handoff && reply.conversation) {
      const useContext = button('link share-context', t('Share as context…'));
      useContext.addEventListener('click', () => {
        if (location.href !== page) {
          closeLayer(menu);
          return toast(menuAnchor, t('The conversation changed. Open the action again.'), true);
        }
        renderShareMenu(reply, { handoff: true, includeFiles, originals });
        place(menu, menuAnchor, menuAbove);
      });
      menu.append(useContext);
    }
    menu.append(el('p', 'hint', draft
      ? t('Added as a draft for you to review and send.')
      : handoff || reply.conversation ? t('Sent right away as conversation context.')
      : reply.prompt ? t('Sent right away as your prompt.')
      : t('Sent right away with your share message.')));
  }

  async function sendShare(reply, choice, page, { handoff = false, includeFiles = true, instructions, originals } = {}) {
    const checkPage = () => {
      if (location.href !== page) throw new Error(t('The conversation changed. Open the action again.'));
    };
    checkPage();
    let files = [];
    if (includeFiles && !reply.partial && reply.files?.length) {
      const selected = originals?.size ? reply.files.map(file => originals.has(file)
        ? { ...file, kind: 'local-prompt', pickedFile: originals.get(file) } : file) : reply.files;
      files = await adapter.readReplyFiles(selected);
    }
    checkPage();
    const kind = handoff ? 'handoff' : reply.conversation ? 'conversation' : reply.prompt ? 'prompt' : undefined;
    const text = includeFiles ? reply.text : reply.textWithoutFiles ?? reply.text;
    return request({ type: 'ASB_SHARE', ...choice, reply: text, ...(kind && { kind }), ...(files.length && { files }), ...instructions });
  }

  const quickSharePeer = () => context?.native && context.peer && available(context.peer) ? context.peer : null;
  function shareHost(response, prompt = false) {
    const view = host('share');
    const group = el('span', 'share-actions');
    const primary = button('share-button share-primary');
    const caption = el('span');
    primary.append(icon('share'), caption);
    const options = button('share-button share-options');
    options.title = t('Choose a chat and action');
    options.setAttribute('aria-label', options.title);
    options.setAttribute('aria-haspopup', 'menu');
    options.append(icon('chevron'));
    view.node.dataset.shareRole = prompt ? 'user' : 'assistant';

    async function read(page) {
      const reply = prompt ? { ...await adapter.readMessage(response), prompt: true }
        : adapter.readReply ? await adapter.readReply(response) : adapter.replyText(response);
      if (location.href !== page || !response.isConnected) throw new Error(t('The conversation changed. Open the action again.'));
      return reply;
    }
    async function openOptions(trigger) {
      try {
        const page = location.href;
        const reply = await read(page);
        await toggleMenu(trigger, () => {
          if (location.href !== page) throw new Error(t('The conversation changed. Open the action again.'));
          renderShareMenu(reply);
        }, false);
      } catch (error) { toast(trigger, error.message, true); }
    }
    for (const trigger of [primary, options]) {
      trigger.addEventListener('pointerdown', () => { dismissedBy = isOpen(menu) && menuAnchor === trigger ? trigger : null; });
    }
    options.addEventListener('click', () => { if (!pending) openOptions(options); });
    primary.addEventListener('click', () => {
      if (pending) return;
      const peer = quickSharePeer();
      if (!peer) return openOptions(primary);
      const page = location.href, previous = context;
      closeLayer(menu);
      run(primary, async () => {
        const reply = await read(page);
        await refresh();
        if (!samePair(previous, page) || !quickSharePeer()) throw new Error(t('That chat closed or changed. Open Share again.'));
        return sendShare(reply, {
          targetId: peer.id, peerId: peer.id, peerProvider: peer.provider, expectedMode: previous.shareMode, page,
        }, page);
      });
    });
    group.append(primary, options);
    view.root.append(group);
    view.setBusy = busy => { primary.disabled = options.disabled = busy; };
    let lastPeerName, lastMode, lastAction;
    view.update = () => {
      const peer = quickSharePeer();
      const peerName = peer?.name || '';
      const preferred = context.actions?.find(action => action.kind === (prompt ? 'prompt' : 'reply') && action.isDefault);
      if (peerName === lastPeerName && context.shareMode === lastMode && preferred?.title === lastAction) return;
      lastAction = preferred?.title;
      lastPeerName = peerName;
      lastMode = context.shareMode;
      group.classList.toggle('paired', !!peer);
      options.hidden = !peer;
      if (peer) {
        const draft = context.shareMode === 'draft', name = peer.name;
        caption.textContent = draft ? t('Draft for {name}', { name }) : t('Share to {name}', { name });
        primary.title = draft ? t('Add a draft to {name}', { name }) : t('Send to {name}', { name });
        if (preferred) primary.title += ' · ' + t('Default action: {name}', { name: preferred.title });
        primary.removeAttribute('aria-haspopup');
      } else {
        caption.textContent = t('Share with…');
        primary.title = prompt ? t('Share this prompt with another chat') : t('Share this reply with another chat');
        primary.setAttribute('aria-haspopup', 'menu');
      }
      view.setBusy(pending);
    };
    return view;
  }

  function canShare() {
    return !!context && (context.chats.length > 0 || (!!context.peer && context.closed.length > 0));
  }
  let narrowPane = innerWidth <= 640;

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
    const replies = adapter.replyAnchors();
    const anchors = [...replies.map(anchor => ({ ...anchor, prompt: false })),
      ...(adapter.promptAnchors?.() || []).map(anchor => ({ ...anchor, prompt: true }))];
    for (const { parent, before, response, prompt } of anchors) {
      const views = prompt ? prompts : shares;
      let view = views.get(response);
      if (!view) views.set(response, view = shareHost(response, prompt));
      view.update();
      seen.add(view);
      // Keep long native action rows usable in narrow split panes. The extension's
      // buttons can wrap on their own line directly beneath the answer text.
      const ownLine = !prompt && narrowPane;
      const container = ownLine ? response : parent;
      const next = ownLine ? null : before;
      if (view.node.parentNode !== container || view.node.nextSibling !== next) container.insertBefore(view.node, next);
      borrow(view.root, parent.querySelector('button'), [24, 44], '32px');
      view.node.style.cssText = !shown ? 'display:none' : ownLine
        ? 'display:flex;max-width:100%;align-items:center' : 'display:inline-flex;align-items:center;flex:none';
      paint(view.root, look);
    }
    for (const views of [shares, prompts]) for (const [response, view] of views) {
      if (!seen.has(view)) { view.node.remove(); views.delete(response); }
    }
    const latest = shares.get(replies.at(-1)?.response);
    const ready = latest && context.native && context.peer && !adapter.busy?.();
    quickReview.title = context.shareMode === 'draft'
      ? t('Draft the review request in both chats, or choose an answer to revise after both reviews are ready.')
      : t('Send the review request to both chats, or choose an answer to revise after both reviews are ready.');
    const preferred = context.actions?.find(action => action.kind === 'review' && action.isDefault);
    if (preferred) quickReview.title += ' ' + t('Default action: {name}', { name: preferred.title });
    quickReview.setAttribute('aria-description', quickReview.title);
    for (const control of [compareButton, reviewGroup]) {
      if (ready) {
        if (control.parentNode !== latest.root) latest.root.append(control);
      } else control.remove();
    }
  }

  if (globalThis.AISplitReading) globalThis.AISplitReading.notify = text => toast(composer.node, text, true);
  function scan() {
    globalThis.AISplitReading?.refresh();
    if (!context) return;
    const look = appearance();
    mountComposer(look);
    mountShares(look);
  }
  let scanTimer = null;
  new MutationObserver(records => {
    if (records.every(record => record.type === 'attributes' && record.target.closest('[data-ai-split-bridge]'))) return;
    if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 250);
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] });
  addEventListener('scroll', () => {
    if (isOpen(menu) && menuAnchor) requestAnimationFrame(() => place(menu, menuAnchor, menuAbove));
  }, { capture: true, passive: true });
  addEventListener('resize', () => {
    closeLayer(menu);
    if (narrowPane !== (innerWidth <= 640)) {
      narrowPane = innerWidth <= 640;
      scan();
    }
  });

  // Share controls keep the words they were built with, so they are built again in the new language.
  i18n.follow(chrome, () => {
    closeLayer(menu);
    labelControls();
    for (const views of [shares, prompts]) {
      for (const view of views.values()) view.node.remove();
      views.clear();
    }
    scan();
  });
  refresh().catch(() => {});
})();
