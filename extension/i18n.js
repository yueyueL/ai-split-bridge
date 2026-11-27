// One plain script shared by the popup, the service worker and the content scripts.
// It has no imports or exports, so each of them can load it as it is.
(() => {
  'use strict';
  if (globalThis.AISplitI18n) return;

  const LANGUAGES = ['en', 'zh-CN'];
  const catalogs = {};
  let language = 'en';
  let choice = 'auto';

  // The English text is the key, so anything without a translation still reads correctly.
  // Values are filled in one pass, so braces inside a value are never treated as placeholders.
  function t(text, values) {
    const template = catalogs[language]?.[text] ?? text;
    if (!values) return template;
    return template.replace(/\{(\w+)\}/g, (placeholder, name) => Object.hasOwn(values, name) ? String(values[name]) : placeholder);
  }

  function list(names) {
    if (names.length < 3) return names.join(t(' and '));
    return `${names.slice(0, -1).join(t(', '))}${t(' and ')}${names.at(-1)}`;
  }

  function resolve(saved, browserLanguage) {
    if (LANGUAGES.includes(saved)) return saved;
    return /^zh\b/i.test(browserLanguage || '') ? 'zh-CN' : 'en';
  }

  function use(next) {
    if (!LANGUAGES.includes(next) || next === language) return false;
    language = next;
    return true;
  }

  function register(name, catalog) {
    catalogs[name] = { ...catalogs[name], ...catalog };
  }

  const listeners = new Set();
  let browserLanguage = () => '';
  function onChange(listener) {
    listeners.add(listener);
  }

  // Applies a saved choice: a supported language, or anything else for the browser's language.
  function choose(saved) {
    choice = LANGUAGES.includes(saved) ? saved : 'auto';
    const changed = use(resolve(saved, browserLanguage()));
    if (changed) for (const listener of listeners) listener(language);
    return changed;
  }

  // Applies the saved choice now, then keeps up with changes made in the popup.
  async function follow(api, changed) {
    if (changed) onChange(changed);
    browserLanguage = () => { try { return api.i18n?.getUILanguage?.() || ''; } catch { return ''; } };
    api.storage?.onChanged?.addListener((changes, area) => {
      if (area === 'sync' && changes.language) choose(changes.language.newValue);
    });
    try { choose((await api.storage.sync.get('language')).language); } catch { /* English stays in use. */ }
  }

  globalThis.AISplitI18n = {
    LANGUAGES, t, list, resolve, use, register, choose, onChange, follow,
    get language() { return language; },
    get choice() { return choice; },
  };
})();
