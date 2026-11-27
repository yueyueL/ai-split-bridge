import { INSTRUCTIONS_KEY, MAX_INSTRUCTIONS, MAX_INSTRUCTION_TITLE, MAX_INSTRUCTION_TEXT, readInstructions, saveInstructions } from './instructions.js';

const i18n = globalThis.AISplitI18n;
const { t } = i18n;
const $ = selector => document.querySelector(selector);
const storage = chrome.storage.local;
const picker = $('#instruction-picker');
const list = $('#instruction-list');
const add = $('#add-instruction');
const editor = $('#instruction-editor');
const fieldset = editor.querySelector('fieldset');
const kind = $('#instruction-kind');
const title = $('#instruction-title');
const body = $('#instruction-text');
const useByDefault = $('#instruction-default');
const remove = $('#remove-instruction');
const status = $('#instruction-status');
title.maxLength = MAX_INSTRUCTION_TITLE;
body.maxLength = MAX_INSTRUCTION_TEXT;

const kindLabels = {
  reply: () => t('Share a reply'),
  prompt: () => t('Share my prompt'),
  review: () => t('Cross-review'),
};
let presets = [];
let editing = null;
let loaded = false;
let loadSequence = 0;

function report(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function renderList() {
  const focused = document.activeElement;
  const defaultId = focused?.dataset.defaultId;
  const editId = focused?.dataset.instructionId;
  list.replaceChildren(...presets.map(preset => {
    const row = document.createElement('li');
    const button = document.createElement('button');
    const name = document.createElement('span');
    const category = document.createElement('span');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = preset.useByDefault;
    checkbox.dataset.defaultId = preset.id;
    checkbox.title = t('Use {name} by default', { name: preset.title });
    checkbox.setAttribute('aria-label', checkbox.title);
    checkbox.addEventListener('change', async () => {
      if (checkbox.getAttribute('aria-busy') === 'true') {
        checkbox.checked = !preset.useByDefault;
        return;
      }
      checkbox.setAttribute('aria-busy', 'true');
      try {
        await persist(preset, { ...preset, useByDefault: checkbox.checked });
        report(t('Saved'));
      } catch (error) {
        report(t('Not saved: {error}', { error: error.message }), true);
        await load();
      } finally {
        checkbox.removeAttribute('aria-busy');
      }
    });
    button.type = 'button';
    button.dataset.instructionId = preset.id;
    name.className = 'title';
    name.textContent = preset.title;
    category.className = 'detail';
    category.textContent = kindLabels[preset.kind]();
    const label = document.createElement('span');
    label.className = 'instruction-label';
    label.append(name, category);
    const edit = document.createElement('span');
    edit.className = 'instruction-edit';
    edit.textContent = t('Edit');
    button.append(label, edit);
    button.addEventListener('click', () => openEditor(preset));
    const toggle = document.createElement('label');
    toggle.className = 'instruction-toggle';
    toggle.append(checkbox);
    row.append(toggle, button);
    return row;
  }));
  if (defaultId) list.querySelector(`[data-default-id="${defaultId}"]`)?.focus();
  if (editId) list.querySelector(`[data-instruction-id="${editId}"]`)?.focus();
  list.hidden = !presets.length;
  add.disabled = !loaded;
}

async function load() {
  const sequence = ++loadSequence;
  try {
    const next = await readInstructions(storage);
    if (sequence !== loadSequence) return;
    presets = next;
    loaded = true;
    renderList();
  } catch (error) {
    if (sequence === loadSequence) report(t('Could not load instructions: {error}', { error: error.message }), true);
  }
}

function openEditor(preset = null) {
  if (!preset && presets.length >= MAX_INSTRUCTIONS) {
    report(t('You can save up to {count} instructions.', { count: MAX_INSTRUCTIONS }), true);
    return;
  }
  editing = preset;
  kind.value = preset?.kind || 'reply';
  title.value = preset?.title || '';
  body.value = preset?.text || '';
  useByDefault.checked = preset ? preset.useByDefault : true;
  remove.hidden = !preset;
  picker.hidden = true;
  editor.hidden = false;
  report('');
  title.focus();
}

function closeEditor(id = editing?.id) {
  editing = null;
  picker.hidden = false;
  editor.hidden = true;
  const rowButton = Array.from(list.querySelectorAll('button')).find(button => button.dataset.instructionId === id);
  (rowButton || add).focus();
}

async function persist(original, value) {
  // Re-read inside the lock so changes from another open popup aren't lost.
  // If the instruction being edited changed, keep the user's unsaved text.
  const update = async () => {
    const current = await readInstructions(storage);
    if (!original) return saveInstructions(storage, [...current, value]);
    const latest = current.find(preset => preset.id === original.id);
    if (!latest || latest.title !== original.title || latest.text !== original.text || latest.kind !== original.kind || latest.useByDefault !== original.useByDefault) {
      throw new Error(t('This instruction changed. Open it again to edit the latest version.'));
    }
    return saveInstructions(storage, current.flatMap(preset => preset.id === original.id ? (value ? [value] : []) : [preset]));
  };
  presets = await (navigator.locks ? navigator.locks.request(INSTRUCTIONS_KEY, update) : update());
  ++loadSequence;
  renderList();
}

async function changeInstruction(value) {
  if (fieldset.disabled || editor.hidden) return;
  const original = editing;
  fieldset.disabled = true;
  report('');
  try {
    await persist(original, value);
    closeEditor(value?.id);
    report(t('Saved'));
  } catch (error) {
    report(t('Not saved: {error}', { error: error.message }), true);
  } finally {
    fieldset.disabled = false;
  }
}

add.addEventListener('click', () => openEditor());
$('#cancel-instruction').addEventListener('click', () => {
  closeEditor();
  report('');
});
remove.addEventListener('click', () => changeInstruction(null));
editor.addEventListener('submit', event => {
  event.preventDefault();
  if (fieldset.disabled || editor.hidden) return;
  changeInstruction({ id: editing?.id || crypto.randomUUID(), kind: kind.value, title: title.value, text: body.value, useByDefault: useByDefault.checked });
});
i18n.onChange(() => {
  renderList();
  if (!status.classList.contains('error')) report('');
});
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area === 'local' && Object.hasOwn(changes, INSTRUCTIONS_KEY)) load();
});
load();
