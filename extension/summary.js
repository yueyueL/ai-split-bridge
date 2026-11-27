import { defaultMessages, formatShare } from './settings.js';

const summary = {
  en: [
    'Summarize this conversation for another assistant who needs to continue the work.',
    'Cover the goal, relevant background, requirements and constraints, what is done and what is in progress, decisions and their reasons, open questions, and the next steps in order.',
    'Keep key deliverables unchanged. List their exact names, paths, and links as given in the conversation. Quote essential final text, code, or values verbatim when needed and mark them as quotations. For long deliverables, point to the original instead of rewriting it. Do not edit any existing files or artifacts.',
    'Separate confirmed facts from assumptions. If a file, link, result, or part of the conversation is unavailable, say so instead of filling it in. Give me the handoff summary only.',
  ].join('\n\n'),
  'zh-CN': [
    '请总结这段对话，整理一份交接说明，让另一个 AI 可以继续完成这项工作。',
    '说明目标、相关背景、要求和限制、已完成和正在做的工作、关键决定及原因、待解决的问题，以及按顺序执行的下一步。',
    '关键产出请保持原样。按对话中的原文列出文件名、路径和链接。必要时，逐字引用关键的最终文本、代码或数值，并注明是原文引用。较长的产出请指向原件。请勿编辑已有文件或产出。',
    '区分已确认的事实和假设。遇到无法确认的文件、链接、结果或对话内容，请直接说明。只输出交接说明。',
  ].join('\n\n'),
};

export function summaryPrompt(language) {
  return summary[language === 'zh-CN' ? 'zh-CN' : 'en'];
}

export function composeHandoff({ assistant, content }, language, template = defaultMessages(language).handoffMessage) {
  return formatShare(template, { assistant, reply: content });
}
