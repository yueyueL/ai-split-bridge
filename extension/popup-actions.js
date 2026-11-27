import { ACTIONS_KEY, MAX_ACTION_TITLE, MAX_ACTION_PROMPT, readActions, changeAction } from './actions.js';

const i18n = globalThis.AISplitI18n;
const { t } = i18n;
const $ = selector => document.querySelector(selector);
const kinds = $('#action-kinds');
const picker = $('#action-picker');
const list = $('#action-list');
const add = $('#add-action');
const form = $('#action-editor');
const fields = form.querySelector('fieldset');
const name = $('#action-title');
const prompt = $('#action-prompt');
const status = $('#action-status');
name.maxLength = MAX_ACTION_TITLE;
prompt.maxLength = MAX_ACTION_PROMPT;

let actions = [];
let kind = 'reply';
let loaded = false;
let saving = false;
let sequence = 0;
let editing = null;
let editorLanguage;
let requestedKind = null;

function report(text = '', error = false) {
  status.textContent = text;
  status.classList.toggle('error', error);
}

function render() {
  const focus = document.activeElement?.dataset;
  const rows = actions.filter(action => action.kind === kind).map(action => {
    const item = document.createElement('li');
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'default-action';
    radio.dataset.defaultAction = action.id;
    radio.checked = action.isDefault;
    radio.disabled = saving;
    radio.setAttribute('aria-label', t('Use {name} for one-click sharing or cross-review', { name: action.title }));
    radio.addEventListener('change', () => {
      if (radio.checked) persist({ type: 'default', kind, id: action.id });
    });
    label.append(radio, document.createTextNode(action.title));
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'text-button';
    edit.dataset.editAction = action.id;
    edit.textContent = t('Edit');
    edit.setAttribute('aria-label', t('Edit {name}', { name: action.title }));
    edit.disabled = saving;
    edit.addEventListener('click', () => openEditor(action));
    item.append(label, edit);
    return item;
  });
  list.replaceChildren(...rows);
  if (focus?.defaultAction || focus?.editAction) {
    const target = Array.from(list.querySelectorAll('input, button')).find(control =>
      focus.defaultAction ? control.dataset.defaultAction === focus.defaultAction : control.dataset.editAction === focus.editAction);
    target?.focus({ preventScroll: true });
  }
  add.disabled = saving || !loaded;
  picker.disabled = fields.disabled = saving;
  kinds.disabled = saving || !form.hidden;
}

async function load() {
  const request = ++sequence;
  try {
    const result = await readActions(chrome.storage, i18n.language);
    if (request !== sequence) return;
    loaded = true;
    actions = result;
    render();
    openRequestedEditor();
  } catch (error) {
    if (request === sequence) report(t('Could not load actions: {error}', { error: error.message }), true);
  }
}

function describePrompt() {
  $('#action-hint').textContent = kind === 'review' ? t('Each assistant gets this prompt followed by the other assistant’s answer.')
    : t('The shared text goes at the end unless you insert it here.');
  $('#action-placeholders').hidden = kind === 'review';
}

function openEditor(action = null) {
  if (!loaded || saving) return;
  editing = action;
  editorLanguage = i18n.language;
  name.value = action?.title || '';
  name.readOnly = !!action?.builtin;
  prompt.value = action?.prompt || '';
  $('#delete-action').hidden = !action || action.builtin;
  $('#reset-action').hidden = !action?.builtin;
  picker.hidden = add.hidden = true;
  form.hidden = false;
  kinds.disabled = true;
  describePrompt();
  report();
  (name.readOnly ? prompt : name).focus();
}

function closeEditor(focusId) {
  editing = null;
  form.hidden = true;
  picker.hidden = add.hidden = false;
  render();
  const edit = Array.from(list.querySelectorAll('[data-edit-action]')).find(button => button.dataset.editAction === focusId);
  (edit || add).focus();
}

async function persist(operation) {
  if (saving) return;
  const original = editing;
  const seen = new Set(actions.map(action => action.id));
  if (original) operation.expected = { title: original.title, prompt: original.prompt };
  saving = true;
  picker.disabled = fields.disabled = kinds.disabled = add.disabled = true;
  report();
  try {
    const language = original ? editorLanguage : i18n.language;
    const result = await changeAction(chrome.storage, operation, language);
    ++sequence;
    actions = result;
    if (language !== i18n.language) await load();
    saving = false;
    if (form.hidden) render();
    else closeEditor(operation.type === 'add' ? actions.findLast(action => action.kind === kind && !seen.has(action.id))?.id : original?.id);
    report(t('Saved'));
  } catch (error) {
    saving = false;
    await load();
    render();
    report(t('Not saved: {error}', { error: error.message }), true);
  }
}

kinds.addEventListener('change', event => {
  kind = event.target.value;
  render();
  report();
});
add.addEventListener('click', () => openEditor());
$('#cancel-action').addEventListener('click', () => { closeEditor(editing?.id); report(); });
form.addEventListener('submit', event => {
  event.preventDefault();
  if (form.hidden) return;
  const action = { kind, title: name.value, prompt: prompt.value };
  persist(editing ? { ...action, type: 'edit', id: editing.id } : { ...action, type: 'add' });
});
$('#reset-action').addEventListener('click', () => persist({ type: 'reset', kind, id: editing.id }));
$('#delete-action').addEventListener('click', () => persist({ type: 'delete', kind, id: editing.id }));
$('#action-placeholders').addEventListener('click', event => {
  const token = event.target.closest('[data-action-token]')?.dataset.actionToken;
  if (!token || prompt.value.length - (prompt.selectionEnd - prompt.selectionStart) + token.length > prompt.maxLength) return;
  prompt.setRangeText(token, prompt.selectionStart, prompt.selectionEnd, 'end');
  prompt.focus();
});
i18n.onChange(() => { describePrompt(); load(); });
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'sync' || (area === 'local' && Object.hasOwn(changes, ACTIONS_KEY))) load();
});

function openRequestedEditor() {
  if (!loaded || !requestedKind) return;
  const route = Array.from(kinds.elements).find(input => input.value === requestedKind);
  requestedKind = null;
  if (route && !saving && form.hidden) {
    route.checked = true;
    kind = route.value;
    render();
    openEditor();
  }
}

requestedKind = new URLSearchParams(location.search).get('addAction');
if (Array.from(kinds.elements).some(input => input.value === requestedKind)) {
  document.documentElement.classList.add('editor-tab');
}
if (!requestedKind) {
  chrome.runtime.sendMessage({ type: 'ASB_ACTION_EDITOR_CONTEXT' }).then(result => {
    requestedKind = result?.kind;
    openRequestedEditor();
  }).catch(() => {});
}
load();
