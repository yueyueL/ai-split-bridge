// A small tab-strip model: moves shift indices, and Chrome's split constraints
// are enforced so tests cannot accidentally pass with an impossible layout.
export function mockChrome(initialTabs, { splitApi = true, session = {}, sync = {} } = {}) {
  const data = new Map(initialTabs.map((tab, index) => [tab.id, {
    windowId: 1, index, groupId: -1, pinned: false, splitViewId: -1,
    active: index === 0, url: 'https://example.com/', ...tab,
  }]));
  const calls = [];
  let nextId = Math.max(0, ...data.keys()) + 1;
  let nextSplit = Math.max(0, ...[...data.values()].map(tab => tab.splitViewId)) + 1;
  const stored = structuredClone(session);
  const synced = structuredClone(sync);
  const model = { data, calls, stored, synced, failSplits: 0, before: null, respond: null };
  const copy = value => structuredClone(value);
  const ordered = windowId => [...data.values()].filter(tab => tab.windowId === windowId).sort((a, b) => a.index - b.index);
  const requireTab = id => {
    if (!data.has(id)) throw new Error(`No tab with id: ${id}`);
    return data.get(id);
  };
  async function record(method, ...args) {
    calls.push({ method, args: copy(args) });
    await model.before?.(method, args);
  }
  const api = {
    tabs: {
      async get(id) { await record('get', id); return copy(requireTab(id)); },
      async query(filter) {
        await record('query', filter);
        return copy([...data.values()].filter(tab =>
          Object.entries(filter).every(([key, value]) => key === 'currentWindow' ? tab.windowId === 1 : tab[key] === value))
          .sort((a, b) => a.index - b.index));
      },
      async move(id, options) {
        await record('move', id, options);
        const tab = requireTab(id);
        const list = ordered(tab.windowId).filter(item => item.id !== id);
        const index = options.index === -1 ? list.length : Math.max(0, Math.min(options.index, list.length));
        list.splice(index, 0, tab);
        list.forEach((item, i) => { item.index = i; });
        return copy(tab);
      },
      async create(options) {
        await record('create', options);
        const id = nextId++;
        const windowId = options.windowId ?? 1;
        const tab = { id, windowId, index: ordered(windowId).length, active: false,
          groupId: -1, pinned: false, splitViewId: -1, ...options };
        data.set(id, tab);
        return copy(tab);
      },
      async update(id, options) {
        await record('update', id, options);
        const tab = requireTab(id);
        if (options.active) ordered(tab.windowId).forEach(item => { item.active = false; });
        Object.assign(tab, options);
        return copy(tab);
      },
      async group({ tabIds, groupId }) {
        await record('group', { tabIds, groupId });
        tabIds.forEach(id => { requireTab(id).groupId = groupId; });
        return groupId;
      },
      async sendMessage(id, message, options) {
        await record('sendMessage', id, message, options);
        requireTab(id);
        return model.respond ? model.respond(id, message, options) : { ok: true };
      },
    },
    storage: { session: {
      async get(key) { await record('storage.get', key); return key in stored ? { [key]: copy(stored[key]) } : {}; },
      async set(value) { await record('storage.set', value); Object.assign(stored, copy(value)); },
      async remove(key) { await record('storage.remove', key); for (const item of [key].flat()) delete stored[item]; },
    }, sync: {
      async get(key) { return key in synced ? { [key]: copy(synced[key]) } : {}; },
      async set(value) { Object.assign(synced, copy(value)); },
    } },
  };
  if (splitApi) {
    api.tabs.createSplit = async ids => {
      await record('createSplit', ids);
      if (model.failSplits > 0) { model.failSplits--; throw new Error('Split creation failed'); }
      if (ids.length !== 2 || ids[0] === ids[1]) throw new Error('Exactly two distinct tabs required');
      const [a, b] = ids.map(requireTab);
      if (a.windowId !== b.windowId || a.groupId !== b.groupId || a.pinned !== b.pinned) throw new Error('Split states must match');
      if (Math.abs(a.index - b.index) !== 1) throw new Error('Split tabs must be adjacent');
      if (a.splitViewId >= 0 || b.splitViewId >= 0) throw new Error('Tab already split');
      const id = nextSplit++;
      a.splitViewId = b.splitViewId = id;
      return id;
    };
    api.tabs.unsplit = async id => {
      await record('unsplit', id);
      const pair = [...data.values()].filter(tab => tab.splitViewId === id);
      if (id < 0 || pair.length !== 2) throw new Error('Unknown split');
      pair.forEach(tab => { tab.splitViewId = -1; });
    };
  }
  model.api = api;
  model.order = (windowId = 1) => ordered(windowId).map(tab => tab.id);
  model.messages = type => calls.filter(call => call.method === 'sendMessage' && (!type || call.args[1].type === type));
  return model;
}

export const chatTabs = () => [
  { id: 1, url: 'https://chatgpt.com/c/one', splitViewId: 10 },
  { id: 2, url: 'https://claude.ai/chat/two', splitViewId: 10 },
];

export function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
