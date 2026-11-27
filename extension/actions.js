import { MAX_SHARE_MESSAGE, defaultMessages, loadSettings, saveSettings } from './settings.js';

const { t } = globalThis.AISplitI18n;

export const ACTIONS_KEY = 'workflowActions';
export const ACTION_KINDS = Object.freeze(['reply', 'prompt', 'review']);
export const MAX_ACTION_TITLE = 60;
export const MAX_ACTION_PROMPT = MAX_SHARE_MESSAGE;

const builtins = [
  { kind: 'reply', id: 'review-reply', key: 'shareMessage', title: () => t('Review reply') },
  { kind: 'reply', id: 'handoff', key: 'handoffMessage', title: () => t('Share as context') },
  { kind: 'prompt', id: 'respond', key: 'promptMessage', title: () => t('Answer prompt') },
  { kind: 'review', id: 'critique', key: 'critiqueMessage', title: () => t('Critique') },
  { kind: 'review', id: 'errors', key: 'errorsMessage', title: () => t('Find errors') },
  { kind: 'review', id: 'improvements', key: 'improvementsMessage', title: () => t('Suggest improvements') },
];
const clean = text => typeof text === 'string' ? text.replace(/\r\n?/g, '\n').trim() : '';
const validText = (text, max) => typeof text === 'string' && !!text.trim() && text.length <= max;

async function loadLibrary(storage) {
  const saved = (await storage.local?.get(ACTIONS_KEY))?.[ACTIONS_KEY];
  const ids = new Set(builtins.map(action => action.id));
  const custom = [];
  for (const item of Array.isArray(saved?.custom) ? saved.custom : []) {
    if (typeof item?.id !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(item.id) || ids.has(item.id)
      || !ACTION_KINDS.includes(item.kind) || !validText(item.title, MAX_ACTION_TITLE) || !validText(item.prompt, MAX_ACTION_PROMPT)) continue;
    const { id, kind, title, prompt } = item;
    custom.push({ id, kind, title, prompt });
    ids.add(id);
  }
  return { custom, defaults: { ...saved?.defaults } };
}

function catalog(library, settings) {
  const actions = [
    ...builtins.map(({ id, kind, key, title }) => ({ id, kind, title: title(), prompt: settings[key], builtin: true })),
    ...library.custom.map(action => ({ ...action, builtin: false })),
  ];
  for (const kind of ACTION_KINDS) {
    const group = actions.filter(action => action.kind === kind);
    const preferred = group.find(action => action.id === library.defaults[kind]) || group[0];
    for (const action of group) action.isDefault = action === preferred;
  }
  return actions;
}

export async function readActions(storage, language = 'en', settings) {
  const [library, current] = await Promise.all([loadLibrary(storage), settings || loadSettings(storage.sync, language)]);
  return catalog(library, current);
}

// An explicit action always belongs to the chosen workflow. Only the quick button may use the default.
export function resolveAction(actions, kind, id) {
  const action = actions.find(item => item.kind === kind && (id === undefined ? item.isDefault : item.id === id));
  if (!action) throw new Error(t('This action is no longer available here. Open the menu again.'));
  return action;
}

function actionPrompt(value) {
  const prompt = clean(value);
  if (!validText(prompt, MAX_ACTION_PROMPT)) throw new Error(t('Enter an action prompt of 1 to {limit} characters.', { limit: MAX_ACTION_PROMPT }));
  return prompt;
}

function actionTitle(value) {
  const title = clean(value);
  if (!validText(title, MAX_ACTION_TITLE)) throw new Error(t('Enter an action name of 1 to {limit} characters.', { limit: MAX_ACTION_TITLE }));
  return title;
}

export async function changeAction(storage, operation, language = 'en') {
  const update = async () => {
    const { kind, id, type, expected } = operation;
    if (!ACTION_KINDS.includes(kind)) throw new Error(t('Choose a valid action category.'));
    const [library, settings] = await Promise.all([loadLibrary(storage), loadSettings(storage.sync, language)]);
    const actions = catalog(library, settings);
    if (type === 'add') {
      library.custom.push({ id: crypto.randomUUID(), kind, title: actionTitle(operation.title), prompt: actionPrompt(operation.prompt) });
    } else {
      if (typeof id !== 'string') throw new Error(t('This action is no longer available here. Open the menu again.'));
      const action = resolveAction(actions, kind, id);
      if (expected && (expected.prompt !== action.prompt || (!action.builtin && expected.title !== action.title))) {
        throw new Error(t('This action changed. Reopen it to edit the latest version.'));
      }
      if (type === 'default') {
        library.defaults[kind] = id;
      } else if (action.builtin && (type === 'edit' || type === 'reset')) {
        const { key } = builtins.find(entry => entry.id === id);
        const prompt = type === 'edit' ? actionPrompt(operation.prompt) : defaultMessages(language)[key];
        const saved = await saveSettings(storage.sync, { [key]: prompt }, language);
        return catalog(library, saved);
      } else if (!action.builtin && type === 'edit') {
        const item = library.custom.find(entry => entry.id === id);
        Object.assign(item, { title: actionTitle(operation.title), prompt: actionPrompt(operation.prompt) });
      } else if (!action.builtin && type === 'delete') {
        library.custom = library.custom.filter(entry => entry.id !== id);
        if (library.defaults[kind] === id) delete library.defaults[kind];
      } else {
        throw new Error(t('Unsupported action change.'));
      }
    }
    await storage.local.set({ [ACTIONS_KEY]: library });
    return catalog(library, settings);
  };
  // Read the current library inside the lock so simultaneous popup edits compose.
  return globalThis.navigator?.locks ? navigator.locks.request(ACTIONS_KEY, update) : update();
}
