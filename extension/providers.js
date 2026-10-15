export const PROVIDERS = Object.freeze({
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/', hosts: ['chatgpt.com', 'chat.openai.com'], conversation: /\/c\/[^/?#]+/ },
  claude: { name: 'Claude', url: 'https://claude.ai/new', hosts: ['claude.ai'], conversation: /\/chat\/[^/?#]+/ },
  gemini: { name: 'Gemini', url: 'https://gemini.google.com/app', hosts: ['gemini.google.com'], conversation: /\/app\/[^/?#]+/ },
  grok: { name: 'Grok', url: 'https://grok.com/', hosts: ['grok.com'], conversation: /\/c\/[^/?#]+/ },
});

export function providerFor(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    return Object.keys(PROVIDERS).find(key => PROVIDERS[key].hosts.includes(parsed.hostname)) || null;
  } catch { return null; }
}

// Two tabs showing the same saved conversation must never both receive a prompt.
export function conversationKey(url) {
  const provider = providerFor(url);
  const match = provider && new URL(url).pathname.match(PROVIDERS[provider].conversation);
  return match ? `${provider}:${match[0]}` : null;
}

export function hasSplit(tab) {
  return Number.isInteger(tab?.splitViewId) && tab.splitViewId >= 0;
}

export function describe(tab) {
  const provider = providerFor(tab?.url);
  return tab && provider ? {
    id: tab.id, provider, name: PROVIDERS[provider].name,
    title: tab.title || PROVIDERS[provider].name,
    index: tab.index, splitViewId: tab.splitViewId ?? -1,
    asleep: !!(tab.discarded || tab.frozen),
    loading: !!(tab.pendingUrl && tab.pendingUrl !== tab.url),
  } : null;
}
