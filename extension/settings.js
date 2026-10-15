export const DEFAULT_SHARE_MESSAGE = "Here is {assistant}'s reply:\n\n{reply}\n\nWhat do you think? Point out anything wrong or missing.";
export const MAX_SHARE_MESSAGE = 4000;

// Stored values come from sync storage, so anything unexpected falls back to the defaults.
export function readSettings(stored) {
  const value = stored && typeof stored === 'object' ? stored : {};
  const message = typeof value.shareMessage === 'string' && value.shareMessage.trim()
    ? value.shareMessage.slice(0, MAX_SHARE_MESSAGE) : DEFAULT_SHARE_MESSAGE;
  return { shareMode: value.shareMode === 'draft' ? 'draft' : 'send', shareMessage: message };
}

export async function loadSettings(storage) {
  const { settings } = await storage.get('settings');
  return readSettings(settings);
}

export async function saveSettings(storage, changes) {
  const settings = readSettings({ ...(await loadSettings(storage)), ...changes });
  await storage.set({ settings });
  return settings;
}

// Placeholders are filled in one pass, so braces inside the reply are never treated as placeholders.
export function composeShare(message, { assistant, reply }) {
  const template = message.includes('{reply}') ? message : `${message.trimEnd()}\n\n{reply}`;
  return template.replace(/\{(assistant|reply)\}/g, (_, key) => key === 'reply' ? reply : assistant).trim();
}
