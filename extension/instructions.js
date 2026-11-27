import './i18n.js';

const { t } = globalThis.AISplitI18n;

export const INSTRUCTIONS_KEY = 'instructionPresets';
export const INSTRUCTION_KINDS = Object.freeze(['reply', 'prompt', 'review']);
export const MAX_INSTRUCTIONS = 24;
export const MAX_INSTRUCTION_TITLE = 60;
export const MAX_INSTRUCTION_TEXT = 2000;

const validId = id => typeof id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(id);
const clean = value => typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';

function checkedPreset(preset) {
  if (!validId(preset?.id) || !INSTRUCTION_KINDS.includes(preset.kind)) {
    throw new Error(t('Choose a valid use for this instruction.'));
  }
  const title = clean(preset.title);
  const text = clean(preset.text);
  if (!title || title.length > MAX_INSTRUCTION_TITLE) {
    throw new Error(t('Enter an instruction name of 1 to {limit} characters.', { limit: MAX_INSTRUCTION_TITLE }));
  }
  if (!text || text.length > MAX_INSTRUCTION_TEXT) {
    throw new Error(t('Enter instruction text of 1 to {limit} characters.', { limit: MAX_INSTRUCTION_TEXT }));
  }
  // Older presets were always opt-in. Only an explicit choice enables automatic use.
  return { id: preset.id, title, text, kind: preset.kind, useByDefault: preset.useByDefault === true };
}

export async function readInstructions(storage) {
  const saved = (await storage?.get(INSTRUCTIONS_KEY))?.[INSTRUCTIONS_KEY];
  if (!Array.isArray(saved)) return [];
  const presets = new Map();
  for (const value of saved.slice(0, MAX_INSTRUCTIONS)) {
    try {
      const preset = checkedPreset(value);
      if (!presets.has(preset.id)) presets.set(preset.id, preset);
    } catch { /* Ignore invalid entries without changing the underlying settings. */ }
  }
  return [...presets.values()];
}

export async function saveInstructions(storage, presets) {
  if (!Array.isArray(presets) || presets.length > MAX_INSTRUCTIONS) {
    throw new Error(t('Keep up to {limit} saved instructions.', { limit: MAX_INSTRUCTIONS }));
  }
  const checked = Array.from(presets, checkedPreset);
  if (new Set(checked.map(({ id }) => id)).size !== checked.length) {
    throw new Error(t('Each saved instruction must have a different ID.'));
  }
  await storage.set({ [INSTRUCTIONS_KEY]: checked });
  return checked;
}

// An omitted selection uses the saved defaults. An explicit empty selection clears them for this action.
export async function instructionBlock(storage, kind, { instructionIds, instructionText = '' } = {}) {
  if (instructionIds !== undefined && (!Array.isArray(instructionIds) || instructionIds.length > MAX_INSTRUCTIONS
    || !instructionIds.every(validId) || new Set(instructionIds).size !== instructionIds.length)
    || typeof instructionText !== 'string') {
    throw new Error(t('Choose valid instructions for this action.'));
  }
  const extra = clean(instructionText);
  if (instructionText.length > MAX_INSTRUCTION_TEXT) {
    throw new Error(t('Keep the one-time instruction under {limit} characters.', { limit: MAX_INSTRUCTION_TEXT }));
  }
  if (!INSTRUCTION_KINDS.includes(kind)) {
    if (instructionIds?.length || extra) throw new Error(t('Choose valid instructions for this action.'));
    return '';
  }
  const chosen = instructionIds === undefined ? null : new Set(instructionIds);
  const presets = chosen?.size === 0 ? [] : (await readInstructions(storage)).filter(preset =>
    preset.kind === kind && (chosen ? chosen.has(preset.id) : preset.useByDefault));
  if (chosen && presets.length !== chosen.size) {
    throw new Error(t('A saved instruction changed. Open the menu again and check your selection.'));
  }
  if (!presets.length && !extra) return '';
  return [t('Additional instructions'), ...presets.map(preset => preset.text), extra].filter(Boolean).join('\n\n');
}
