import test from 'node:test';
import assert from 'node:assert/strict';
import { composeShare, composeComparison, defaultMessages, DEFAULT_SHARE_MESSAGE, DEFAULT_PROMPT_MESSAGE, DEFAULT_CONVERSATION_MESSAGE, DEFAULT_COMPARISON_MESSAGE, REVIEW_TEMPLATES, loadSettings, MAX_SHARE_MESSAGE, readSettings, saveSettings } from '../extension/settings.js';

const defaults = {
  shareMode: 'send', shareMessage: DEFAULT_SHARE_MESSAGE, promptMessage: DEFAULT_PROMPT_MESSAGE,
  conversationMessage: DEFAULT_CONVERSATION_MESSAGE, comparisonMessage: DEFAULT_COMPARISON_MESSAGE,
  reviewGuidance: '', critiqueMessage: REVIEW_TEMPLATES.critique.default, errorsMessage: REVIEW_TEMPLATES.errors.default,
  improvementsMessage: REVIEW_TEMPLATES.improvements.default,
};

const memory = (initial = {}) => {
  const data = structuredClone(initial);
  return {
    data,
    async get(key) { return key == null ? structuredClone(data) : key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(value) {
      const stored = structuredClone(value);
      for (const [key, item] of Object.entries(value)) {
        assert.ok(Buffer.byteLength(key + JSON.stringify(item)) <= 8192);
        stored[key] = typeof item === 'string' ? Buffer.from(item, 'utf8').toString('utf8') : stored[key];
      }
      Object.assign(data, stored);
    },
  };
};

test('by default a shared reply is sent right away inside the standard message', async () => {
  const settings = await loadSettings(memory());
  assert.deepEqual(settings, defaults);
  assert.equal(composeShare(settings.shareMessage, { assistant: 'Grok', reply: 'Hi there.' }),
    "Here is Grok's reply:\n\nHi there.\n\nWhat do you think? Please review it critically. Point out anything wrong, weak, or missing.\n\nIf there are good ideas, use them to improve your previous response. Do not just agree with it—use your own judgement.");
});

test('existing profiles can customize and reset Compare independently of Replies', async () => {
  const storage = memory({ settings: { shareMode: 'draft', shareMessage: 'Review this carefully: {reply}' } });
  const answers = 'Claude (left pane)\nUse {answers} literally. $&\n\nGemini (right pane)\nCheck {assistant}.';
  assert.match(composeComparison(await loadSettings(storage), { answers }), /Agreement is not proof of correctness/);
  await saveSettings(storage, { comparisonMessage: '先看这两份回答：\n{answers}\n哪些主张需要核实？' });
  assert.equal(composeComparison(await loadSettings(storage), { answers }), `先看这两份回答：\n${answers}\n哪些主张需要核实？`);
  assert.equal(composeComparison({ comparisonMessage: 'Check the evidence.' }, { answers }), 'Check the evidence.\n\n' + answers);
  await saveSettings(storage, { comparisonMessage: '   ' });
  assert.deepEqual(await loadSettings(storage), { ...defaults, shareMode: 'draft', shareMessage: 'Review this carefully: {reply}' });
});

test('full-length multilingual sharing and cross-review instructions survive sync item limits and later edits', async () => {
  const storage = memory();
  const settings = { ...defaults, shareMode: 'draft' };
  for (const key of ['shareMessage', 'promptMessage', 'conversationMessage', 'comparisonMessage', 'reviewGuidance', 'critiqueMessage', 'errorsMessage', 'improvementsMessage']) {
    settings[key] = ('答'.repeat(999) + '👋' + key + '\n').repeat(4).slice(0, MAX_SHARE_MESSAGE);
    await saveSettings(storage, { [key]: settings[key], shareMode: 'draft' });
  }
  assert.deepEqual(await loadSettings(storage), settings);
  await saveSettings(storage, { comparisonMessage: 'Check assumptions.' });
  assert.deepEqual(await loadSettings(storage), { ...settings, comparisonMessage: 'Check assumptions.' });
  assert.deepEqual((await saveSettings(storage, { comparisonMessage: '' })).comparisonMessage, DEFAULT_COMPARISON_MESSAGE);
});

test('profiles with templates split by v0.10.0 gain independent review defaults', async () => {
  const storage = memory({ settings: { splitTemplates: true, shareMode: 'draft' }, 'comparisonMessage.0': 'Compare prior work: {answers}' });
  const old = await loadSettings(storage);
  assert.deepEqual(old, { ...defaults, shareMode: 'draft', comparisonMessage: 'Compare prior work: {answers}' });
  await saveSettings(storage, { reviewGuidance: '先检查证据。', errorsMessage: '逐项核对数字。' });
  const updated = await loadSettings(storage);
  assert.deepEqual(updated, { ...old, reviewGuidance: '先检查证据。', errorsMessage: '逐项核对数字。' });
  await saveSettings(storage, { reviewGuidance: '   ' });
  assert.deepEqual(await loadSettings(storage), { ...old, errorsMessage: '逐项核对数字。' });
});

test('your own message wraps the reply, and without {reply} the reply goes at the end', () => {
  const reply = 'Use {assistant} and {reply} literally. $& $1';
  assert.equal(composeShare('Critique {assistant}:\n{reply}\n— from {assistant}', { assistant: 'Claude', reply }),
    `Critique Claude:\n${reply}\n— from Claude`, 'placeholders inside the reply are left alone');
  assert.equal(composeShare('Summarize this in one line.  \n', { assistant: 'Gemini', reply: 'Long answer.' }),
    'Summarize this in one line.\n\nLong answer.');
});

test('prompts and mixed conversations retain the correct authors instead of using the reply template', () => {
  const message = 'Critique {assistant}’s reply: {reply}';
  const prompt = 'How does {reply} work?';
  assert.equal(composeShare(message, { assistant: 'ChatGPT', reply: prompt, kind: 'prompt' }),
    `Here is my prompt from a chat with ChatGPT:\n\n${prompt}\n\nPlease respond to this prompt.`);
  const transcript = 'You:\nFirst question\n\nClaude:\nFirst answer\n\nYou:\nFollow-up';
  assert.equal(composeShare(message, { assistant: 'Claude', reply: transcript, kind: 'conversation' }),
    `Here are selected messages from my conversation with Claude:\n\n${transcript}\n\nPlease continue from this context.`);
  assert.equal(composeShare(message, { assistant: 'Claude', reply: 'Answer', kind: 'reply' }),
    'Critique Claude’s reply: Answer');
  for (const kind of ['system', 'user', '', null, 1, {}]) {
    assert.throws(() => composeShare(message, { assistant: 'Claude', reply: 'Text', kind }), /Choose a prompt, reply, or conversation/);
  }
});

test('saved settings are kept, and anything unexpected falls back to the defaults', async () => {
  const storage = memory();
  await saveSettings(storage, { shareMode: 'draft' });
  await saveSettings(storage, { shareMessage: 'Check {assistant}: {reply}' });
  assert.deepEqual(await loadSettings(storage), { ...defaults, shareMode: 'draft', shareMessage: 'Check {assistant}: {reply}' });
  await saveSettings(storage, { shareMessage: '   ' });
  assert.equal((await loadSettings(storage)).shareMessage, DEFAULT_SHARE_MESSAGE);
  for (const stored of [null, 'x', { shareMode: 'post', shareMessage: 42 }]) {
    assert.deepEqual(readSettings(stored), defaults);
  }
  assert.equal(readSettings({ shareMessage: 'x'.repeat(MAX_SHARE_MESSAGE + 10) }).shareMessage.length, MAX_SHARE_MESSAGE);
});

test('older reply settings gain separate editable prompt and conversation defaults', async () => {
  const oldDefault = "Here is {assistant}'s reply:\n\n{reply}\n\nWhat do you think? Point out anything wrong or missing.";
  const unchanged = memory({ settings: { shareMode: 'draft', shareMessage: oldDefault } });
  assert.deepEqual(await loadSettings(unchanged), { ...defaults, shareMode: 'draft' });
  await saveSettings(unchanged, { shareMode: 'send' });
  assert.equal(unchanged.data.settings.shareMessage, DEFAULT_SHARE_MESSAGE);
  assert.equal(readSettings({ shareMessage: `${oldDefault}\nFocus on feasibility.` }).shareMessage,
    `${oldDefault}\nFocus on feasibility.`, 'customized versions of the old default are preserved');
  const storage = memory({ settings: { shareMode: 'draft', shareMessage: 'Keep this reply message: {reply}' } });
  assert.deepEqual(await loadSettings(storage), { ...defaults, shareMode: 'draft', shareMessage: 'Keep this reply message: {reply}' });
  await saveSettings(storage, { conversationMessage: 'Use these messages to make a plan:\n{content}' });
  await saveSettings(storage, { promptMessage: 'Answer in bullet points:\n{content}' });
  const settings = await loadSettings(storage);
  assert.equal(settings.shareMessage, 'Keep this reply message: {reply}');
  assert.equal(settings.conversationMessage, 'Use these messages to make a plan:\n{content}');
  assert.equal(settings.promptMessage, 'Answer in bullet points:\n{content}');
  assert.equal(settings.shareMode, 'draft');
  await saveSettings(storage, { conversationMessage: ' ', promptMessage: null });
  assert.equal((await loadSettings(storage)).conversationMessage, DEFAULT_CONVERSATION_MESSAGE);
  assert.equal((await loadSettings(storage)).promptMessage, DEFAULT_PROMPT_MESSAGE);
  for (const key of ['promptMessage', 'conversationMessage']) {
    assert.equal(readSettings({ [key]: 'x'.repeat(MAX_SHARE_MESSAGE + 10) })[key].length, MAX_SHARE_MESSAGE);
  }
});

test('custom prompts and conversation messages support content placeholders without interpreting selected text', () => {
  const selected = 'You:\nUse {content}, {assistant}, and {reply} literally. $& $1\n\nClaude:\nAnswer';
  const settings = { promptMessage: 'Explain this prompt from {assistant}:\n{content}', conversationMessage: 'My notes from {assistant}:\n{reply}\nPlease check assumptions.' };
  assert.equal(composeShare(settings, { assistant: 'Claude', reply: selected, kind: 'prompt' }),
    `Explain this prompt from Claude:\n${selected}`);
  assert.equal(composeShare(settings, { assistant: 'Claude', reply: selected, kind: 'conversation' }),
    `My notes from Claude:\n${selected}\nPlease check assumptions.`);
  assert.equal(composeShare({ conversationMessage: 'Summarize the conversation.' }, { assistant: 'Grok', reply: selected, kind: 'conversation' }),
    `Summarize the conversation.\n\n${selected}`, 'selected messages remain included when the placeholder is removed');
});

// ---------- Interface language ----------
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

test('Chinese has its own default for every message, with the same placeholders as English', async () => {
  const chinese = defaultMessages('zh-CN');
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(defaults).filter(key => key !== 'shareMode').sort());
  for (const [key, message] of Object.entries(chinese)) {
    assert.deepEqual(placeholders(message), placeholders(defaults[key]), key);
    if (defaults[key]) assert.match(message, /[一-鿿]/, `${key} is written in Chinese`);
  }
  assert.match(chinese.shareMessage, /^下面是 \{assistant\} 的回复：\n\n\{reply\}\n\n/);
  assert.equal(defaultMessages('en').shareMessage, DEFAULT_SHARE_MESSAGE);
  assert.equal(defaultMessages('fr').shareMessage, DEFAULT_SHARE_MESSAGE, 'an unknown language falls back to English');
});

test('with nothing customized, messages follow the interface language', async () => {
  const storage = memory();
  assert.deepEqual(await loadSettings(storage, 'zh-CN'), { shareMode: 'send', ...defaultMessages('zh-CN') });

  // Saving any setting also stores the messages then in use. Those stored defaults are not customizations.
  await saveSettings(storage, { shareMode: 'draft' });
  assert.equal(storage.data.settings.shareMessage, DEFAULT_SHARE_MESSAGE);
  assert.deepEqual(await loadSettings(storage, 'zh-CN'), { shareMode: 'draft', ...defaultMessages('zh-CN') });

  await saveSettings(storage, { shareMode: 'send' }, 'zh-CN');
  assert.equal(storage.data.settings.shareMessage, defaultMessages('zh-CN').shareMessage);
  assert.deepEqual(await loadSettings(storage), defaults);
  assert.deepEqual(await loadSettings({ async get() { return { settings: { shareMessage: "Here is {assistant}'s reply:\n\n{reply}\n\nWhat do you think? Point out anything wrong or missing." } }; } }, 'zh-CN'),
    { shareMode: 'send', ...defaultMessages('zh-CN') }, 'the earlier English default is upgraded too');
});

test('a customized message is kept in every language', async () => {
  const storage = memory();
  await saveSettings(storage, { shareMessage: 'My own words: {reply}', reviewGuidance: 'Cite sources.' }, 'zh-CN');
  for (const language of ['en', 'zh-CN']) {
    const settings = await loadSettings(storage, language);
    assert.equal(settings.shareMessage, 'My own words: {reply}');
    assert.equal(settings.reviewGuidance, 'Cite sources.');
    assert.equal(settings.promptMessage, defaultMessages(language).promptMessage);
  }
});

test('shared text and comparisons are wrapped in the default of the interface language', async () => {
  const settings = await loadSettings(memory(), 'zh-CN');
  const shared = composeShare(settings, { assistant: 'Claude', reply: 'Use {reply} twice.' }, 'zh-CN');
  assert.match(shared, /^下面是 Claude 的回复：\n\nUse \{reply\} twice\.\n\n你怎么看？/);
  assert.match(composeShare(settings, { assistant: 'Gemini', reply: 'What is 2+2?', kind: 'prompt' }, 'zh-CN'), /与 Gemini 的聊天[^]*What is 2\+2\?[^]*请回应/);
  assert.match(composeShare(undefined, { assistant: 'Gemini', reply: 'A\n\nB', kind: 'conversation' }, 'zh-CN'), /与 Gemini 对话[^]*A\n\nB[^]*继续/);
  const comparison = composeComparison(settings, { answers: 'Left\n\nRight' }, 'zh-CN');
  assert.match(comparison, /^请运用你自己的独立判断/);
  assert.ok(comparison.endsWith('\n\nLeft\n\nRight'));
  assert.match(composeComparison(undefined, { answers: 'Left\n\nRight' }), /^Compare the two answers below/);
});
