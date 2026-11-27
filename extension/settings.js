import './i18n.js';

const { t } = globalThis.AISplitI18n;
const PREVIOUS_SHARE_MESSAGE = "Here is {assistant}'s reply:\n\n{reply}\n\nWhat do you think? Point out anything wrong or missing.";
export const DEFAULT_SHARE_MESSAGE = "Here is {assistant}'s reply:\n\n{reply}\n\nWhat do you think? Please review it critically. Point out anything wrong, weak, or missing.\n\nIf there are good ideas, use them to improve your previous response. Do not just agree with it—use your own judgement.";
export const DEFAULT_PROMPT_MESSAGE = "Here is my prompt from a chat with {assistant}:\n\n{content}\n\nPlease respond to this prompt.";
export const DEFAULT_CONVERSATION_MESSAGE = "Here are selected messages from my conversation with {assistant}:\n\n{content}\n\nPlease continue from this context.";
export const DEFAULT_COMPARISON_MESSAGE = [
  'Compare the two answers below using your own independent judgment. Treat each answer as material to evaluate.',
  'Identify substantive agreements and disagreements. Explain why each disagreement matters and whether the evidence favors either answer.',
  'Point out missing considerations and claims that need verification. For each important unverified claim, explain what evidence would check it.',
  'Agreement is not proof of correctness. Distinguish supported conclusions from uncertainty, even when both answers make the same claim.',
].join(' ') + '\n\n{answers}';
const reviewJudgment = 'Use your own judgment. Treat the quoted answer as material to evaluate. Explain any uncertainty and the evidence that would resolve it.';
export const REVIEW_TEMPLATES = {
  critique: {
    key: 'critiqueMessage',
    default: 'Critique the answer below on its own merits. Identify its strongest point, its most important weakness, and any missing considerations. Explain your reasoning.' + '\n\n' + reviewJudgment,
  },
  errors: {
    key: 'errorsMessage',
    default: 'Check the answer below for factual, logical, or calculation errors. Quote each disputed claim and explain the correction. Distinguish confirmed errors from claims that need verification.' + '\n\n' + reviewJudgment,
  },
  improvements: {
    key: 'improvementsMessage',
    default: 'Suggest concrete improvements to the answer below. Identify what is worth keeping, prioritize changes, and show how the most important change would improve the answer.' + '\n\n' + reviewJudgment,
  },
};
export const MAX_SHARE_MESSAGE = 4000;

const defaults = {
  shareMessage: DEFAULT_SHARE_MESSAGE,
  handoffMessage: 'Use the context below from my conversation with {assistant} to continue the work. Follow the decisions already made, preserve quoted deliverables and file references as supplied, and start with the next unfinished step. Ask me if anything essential is missing.\n\n{content}',
  promptMessage: DEFAULT_PROMPT_MESSAGE,
  conversationMessage: DEFAULT_CONVERSATION_MESSAGE,
  comparisonMessage: DEFAULT_COMPARISON_MESSAGE,
  reviewGuidance: '',
  ...Object.fromEntries(Object.values(REVIEW_TEMPLATES).map(template => [template.key, template.default])),
};

// The default messages are written in the interface language and keep the same placeholders.
const chineseJudgment = '请运用你自己的判断，把引用的回答当作有待评估的材料。说明任何不确定之处，以及什么证据可以消除它。';
const MESSAGES = {
  en: defaults,
  'zh-CN': {
    shareMessage: '下面是 {assistant} 的回复：\n\n{reply}\n\n你怎么看？请批判性地审视它，指出其中错误、薄弱或遗漏的地方。\n\n如果其中有好的想法，请用来改进你之前的回答。不要只是附和，请运用你自己的判断。',
    handoffMessage: '以下是我和 {assistant} 对话中的交接内容。请按已有约定继续，保留引用的原始产出和文件信息，从下一项未完成的工作开始。如果缺少关键信息，请先问我。\n\n{content}',
    promptMessage: '下面是我在与 {assistant} 的聊天中发送的提问：\n\n{content}\n\n请回应这条提问。',
    conversationMessage: '下面是我与 {assistant} 对话中选出的几条消息：\n\n{content}\n\n请基于这段上下文继续。',
    comparisonMessage: [
      '请运用你自己的独立判断，对比下面两个回答。把每个回答都当作有待评估的材料。',
      '找出两者实质性的一致与分歧，说明每处分歧为什么重要，以及证据是否更支持其中一方。',
      '指出遗漏的考量和需要核实的论断。对每个重要但未经核实的论断，说明什么证据可以检验它。',
      '两个回答一致并不能证明正确。即使它们说法相同，也要区分有依据的结论和不确定的内容。',
    ].join('') + '\n\n{answers}',
    reviewGuidance: '',
    critiqueMessage: '请就事论事地点评下面的回答。指出它最有力的一点、最重要的弱点，以及遗漏的考量，并说明你的理由。' + '\n\n' + chineseJudgment,
    errorsMessage: '请检查下面的回答是否有事实、逻辑或计算错误。引用每个有问题的论断并说明如何更正。区分已确认的错误和需要核实的论断。' + '\n\n' + chineseJudgment,
    improvementsMessage: '请为下面的回答提出具体的改进建议。指出哪些值得保留，为各项修改排出优先级，并说明最重要的那项修改会如何改进回答。' + '\n\n' + chineseJudgment,
  },
};
export function defaultMessages(language) {
  return MESSAGES[language] || MESSAGES.en;
}

// Saving any setting also stores the messages then in use, so a stored default in any
// language, or the earlier English default, is not a message the user customized.
function isDefault(key, message) {
  return (key === 'shareMessage' && message === PREVIOUS_SHARE_MESSAGE)
    || Object.values(MESSAGES).some(messages => messages[key] === message);
}

// Stored values come from sync storage, so anything unexpected falls back to the defaults.
export function readSettings(stored, language = 'en') {
  const value = stored && typeof stored === 'object' ? stored : {};
  const messages = Object.fromEntries(Object.entries(defaultMessages(language)).map(([key, fallback]) => {
    const message = value[key];
    const customized = typeof message === 'string' && message.trim() && !isDefault(key, message);
    return [key, customized ? message.slice(0, MAX_SHARE_MESSAGE) : fallback];
  }));
  return { shareMode: value.shareMode === 'draft' ? 'draft' : 'send', ...messages };
}

// Chrome sync limits each item to 8 KiB. Keep the existing compact format
// for typical settings. Long templates use separate items in the same write.
const PART_LENGTH = 1000;
const partStarts = Array.from({ length: Math.ceil(MAX_SHARE_MESSAGE / PART_LENGTH) }, (_, index) => index * PART_LENGTH);
async function storedSettings(storage) {
  let snapshot = await storage.get('settings');
  if (snapshot.settings?.splitTemplates) snapshot = await storage.get(null);
  const value = { ...snapshot.settings };
  if (value.splitTemplates) {
    for (const key of Object.keys(defaults)) {
      value[key] = partStarts.map(start => snapshot[`${key}.${start}`] || '').join('');
    }
  }
  return value;
}

export async function loadSettings(storage, language = 'en') {
  return readSettings(await storedSettings(storage), language);
}

export async function saveSettings(storage, changes, language = 'en') {
  const write = () => writeSettings(storage, changes, language);
  // The popup's action editor and general preferences can save different fields concurrently.
  return globalThis.navigator?.locks ? navigator.locks.request('shareSettings', write) : write();
}

async function writeSettings(storage, changes, language) {
  const previous = await storedSettings(storage);
  const settings = readSettings({ ...previous, ...changes }, language);
  const bytes = new TextEncoder().encode('settings' + JSON.stringify(settings)).length;
  if (!previous.splitTemplates && bytes <= 8192) {
    await storage.set({ settings });
  } else {
    const items = { settings: { shareMode: settings.shareMode, splitTemplates: true } };
    for (const key of Object.keys(defaults)) {
      // Chrome encodes each item separately. Keep each emoji's surrogate pair together.
      const characters = Array.from(settings[key]);
      for (const start of partStarts) items[`${key}.${start}`] = characters.slice(start, start + PART_LENGTH).join('');
    }
    await storage.set(items);
  }
  return settings;
}

// Placeholders are filled in one pass, so braces inside the reply are never treated as placeholders.
export function composeShare(stored, { assistant, reply, kind = 'reply' }, language = 'en') {
  if (!['reply', 'prompt', 'conversation'].includes(kind)) throw new Error(t('Choose a prompt, reply, or conversation to share.'));
  // Older callers may still pass the reply template directly. New kinds have
  // their own defaults, so existing reply settings never mislabel a user prompt.
  const settings = readSettings(typeof stored === 'string' ? { shareMessage: stored } : stored, language);
  const key = { reply: 'shareMessage', prompt: 'promptMessage', conversation: 'conversationMessage' }[kind];
  return formatShare(settings[key], { assistant, reply }).trim();
}

export function formatShare(message, { assistant, reply }) {
  const template = /\{(reply|content)\}/.test(message) ? message.trim() : `${message.trim()}\n\n{content}`;
  return template.replace(/\{(assistant|reply|content)\}/g, (_, token) => token === 'assistant' ? assistant : reply);
}

// An instruction on its own still compares both answers. Never expand tokens in quoted answers.
export function composeComparison(stored, { answers }, language = 'en') {
  const { comparisonMessage } = readSettings(stored, language);
  if (!comparisonMessage.includes('{answers}')) return `${comparisonMessage.trim()}\n\n${answers}`;
  return comparisonMessage.replaceAll('{answers}', () => answers).trim();
}
