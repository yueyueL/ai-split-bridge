import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const adapterSource = await readFile(new URL("../extension/adapters.js", import.meta.url), "utf8");
const contentSource = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");

const fixtures = {
  chatgpt: { host: "chatgpt.com", editor: "<div contenteditable='true' role='textbox' aria-label='Ask ChatGPT'></div>", send: "Send", response: "<div data-message-author-role='assistant'><div class='markdown'><p>First paragraph.</p><p>Second paragraph.</p></div></div>" },
  claude: { host: "claude.ai", editor: "<div class='tiptap ProseMirror' contenteditable='true' role='textbox' aria-label='Write your prompt to Claude'></div>", send: "Send message", response: "<div class='font-claude-response'><p>Claude response.</p></div>" },
  gemini: { host: "gemini.google.com", editor: "<rich-textarea><div class='ql-editor' contenteditable='true'></div></rich-textarea>", send: "Send message", response: "<model-response><message-content><p>Gemini response.</p></message-content></model-response>" },
  grok: { host: "grok.com", editor: "<div class='tiptap ProseMirror query-bar-editor' contenteditable='true' role='combobox' aria-label='Ask Grok anything' data-testid='chat-input'></div>", send: "Submit", response: "<div data-testid='assistant-message'><p>Grok response.</p></div>" },
};

function setup(provider = "chatgpt", options = {}) {
  const fixture = fixtures[provider];
  const body = options.body ?? `<main>${fixture.response}<form>${fixture.editor}<button type='button' aria-label='${fixture.send}'>Send</button></form></main>`;
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`, {
    url: options.url ?? `https://${fixture.host}/chat/test`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.HTMLElement.prototype.getClientRects = function () { return [{ width: 100, height: 40 }]; };
  const editor = window.document.querySelector("[contenteditable='true'], textarea");
  let clicks = 0;
  window.document.querySelector("button")?.addEventListener("click", () => { clicks += 1; });
  window.document.execCommand = (command, _showUI, text) => {
    assert.equal(command, "insertText");
    if (options.failEdit) return false;
    const selection = window.getSelection();
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(window.document.createTextNode(text));
    range.collapse(false);
    if (options.render) editor.innerHTML = options.render(text);
    editor.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return true;
  };
  window.eval(adapterSource);
  return {
    dom, window, editor, adapter: window.AISplitAdapters,
    clicks: () => clicks,
    setDraft: (text) => { if (editor.tagName === "TEXTAREA") editor.value = text; else editor.textContent = text; },
    close: () => dom.window.close(),
  };
}

for (const provider of Object.keys(fixtures)) {
  test(`${provider}: stage, validate, and commit a plain-text draft once`, async (t) => {
    const fixture = setup(provider);
    t.after(fixture.close);
    const { adapter } = fixture;
    assert.equal(adapter.provider, provider);
    assert.equal(adapter.getDraft().text, "");
    const request = { requestId: "request-1", text: "Check this.\nThen explain why.", source: false };
    assert.equal(adapter.preflight(request).ok, true);
    assert.equal((await adapter.stage(request)).ok, true);
    assert.equal(adapter.getDraft().text, request.text);
    assert.equal(fixture.clicks(), 0, "staging must never send");
    assert.equal((await adapter.validate(request)).ok, true);
    assert.equal(adapter.commit(request).status, "clicked");
    assert.equal(fixture.clicks(), 1);
    assert.throws(() => adapter.commit(request), /already handled/);
    assert.equal(fixture.clicks(), 1, "a duplicate commit must not click twice");
  });
}

test("nonempty destination, busy generation, and the destination's own attachments block staging", async (t) => {
  const fixture = setup();
  t.after(fixture.close);
  const request = { requestId: "guarded", text: "A prompt", source: false };
  fixture.setDraft("Keep my draft");
  assert.throws(() => fixture.adapter.canLeave(), /draft/);
  assert.throws(() => fixture.adapter.preflight(request), /already has a draft/);
  assert.equal(fixture.adapter.getDraft().text, "Keep my draft");
  fixture.setDraft("");
  const stop = fixture.window.document.createElement("button");
  stop.dataset.testid = "stop-button";
  fixture.window.document.body.append(stop);
  assert.throws(() => fixture.adapter.preflight(request), /still responding/);
  assert.throws(() => fixture.adapter.canLeave(), /still responding/);
  stop.removeAttribute('data-testid');
  stop.setAttribute('aria-label', 'Stop');
  assert.throws(() => fixture.adapter.preflight(request), /still responding/);
  assert.throws(() => fixture.adapter.canLeave(), /still responding/);
  stop.remove();
  const attachment = fixture.window.document.createElement("div");
  attachment.dataset.testid = "attachment-preview";
  fixture.editor.closest("form").append(attachment);
  assert.throws(() => fixture.adapter.preflight(request), /already has attachments/);
  assert.throws(() => fixture.adapter.canLeave(), /attachments before switching/);
  await assert.rejects(fixture.adapter.insert({ text: "A shared reply" }), /already has attachments/);
  fixture.setDraft("A prompt with a file");
  assert.equal(fixture.adapter.preflight({ requestId: "source", text: "A prompt with a file", source: true }).ok, true,
    "the chat you send from may have attachments");
  assert.equal(fixture.clicks(), 0);
});

test("native editing blocks preserve blank lines without layout-dependent extra newlines", (t) => {
  const fixture = setup();
  t.after(fixture.close);
  for (const html of [
    'First line<div>Second line</div><div><br></div><div>Final paragraph</div>',
    '<p>First line</p><p>Second line</p><p><br></p><p>Final paragraph</p>',
    'First line<br>Second line<br><br>Final paragraph',
  ]) {
    fixture.editor.innerHTML = html;
    assert.equal(fixture.adapter.getDraft().text, 'First line\nSecond line\n\nFinal paragraph');
  }
});

test("links, tool chips, and emoji in a prompt are sent as text instead of blocking it", async (t) => {
  const fixture = setup();
  t.after(fixture.close);
  fixture.editor.innerHTML = "<p>Read <a href='https://example.com/a'>example.com/a</a> and <a href='https://openai.com/research'>their research</a>, then generate <span contenteditable='false'><img alt=''><span>Create image</span></span> <img alt='🎨'></p>";
  const text = "Read https://example.com/a and their research (https://openai.com/research), then generate Create image 🎨";
  assert.equal(fixture.adapter.getDraft().text, text);
  assert.equal(fixture.adapter.preflight({ requestId: "rich", text, source: true }).ok, true);
  assert.equal((await fixture.adapter.readPrompt()).text, text);
});

test("a destination that turns a pasted address into a link chip still verifies", async (t) => {
  const chip = (text) => text.replace(/https:\/\/\S+/, (url) => `<span contenteditable='false'><a href='${url}'>Example Domain</a></span>`);
  const fixture = setup("claude", { render: chip });
  t.after(fixture.close);
  const request = { requestId: "chip", text: "Compare with https://example.com/page", source: false };
  fixture.adapter.preflight(request);
  await fixture.adapter.stage(request);
  assert.equal((await fixture.adapter.validate(request)).ok, true);
  assert.equal(fixture.adapter.commit(request).status, "clicked");
});

// Stands in for a site's attachment handling: pasted or dropped files become removable tiles, in the order added.
function acceptFiles(fixture, { on = ["paste", "drop"] } = {}) {
  const { window } = fixture;
  window.DataTransfer ??= class { constructor() { this.files = []; this.items = { add: (file) => this.files.push(file) }; } };
  window.ClipboardEvent ??= class extends window.Event { constructor(type, init = {}) { super(type, init); this.clipboardData = init.clipboardData ?? null; } };
  window.DragEvent ??= class extends window.Event { constructor(type, init = {}) { super(type, init); this.dataTransfer = init.dataTransfer ?? null; } };
  const read = (blob) => new Promise((resolve) => {
    const reader = new window.FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsArrayBuffer(blob);
  });
  window.Blob.prototype.arrayBuffer ??= function () { return read(this); };
  const tray = window.document.createElement("div");
  tray.className = "tray";
  fixture.editor.closest("form").prepend(tray);
  const received = [];
  for (const type of on) {
    window.document.addEventListener(type, (event) => {
      if ((event.clipboardData || event.dataTransfer)?.files?.length) event.preventDefault();
      for (const file of (event.clipboardData || event.dataTransfer)?.files || []) {
        received.push(file);
        const tile = window.document.createElement("div");
        tile.dataset.testid = "file-preview";
        tile.innerHTML = `<span>${file.name}</span><button type='button' aria-label='Remove file'>×</button>`;
        tile.querySelector("button").addEventListener("click", () => tile.remove());
        tray.append(tile);
      }
    });
  }
  const paste = (files) => {
    const event = new window.Event("paste", { bubbles: true, cancelable: true });
    event.clipboardData = { files };
    fixture.editor.dispatchEvent(event);
  };
  const text = async (file) => Buffer.from(await read(file)).toString();
  return { tray, received, paste, text };
}

test("files attached in the chat you send from are read for copying, minus the ones you removed", async (t) => {
  const fixture = setup();
  t.after(fixture.close);
  const site = acceptFiles(fixture);
  const { File } = fixture.window;
  site.paste([new File(["first"], "first.txt", { type: "text/plain" })]);
  site.paste([new File(["second"], "second.txt", { type: "text/plain" })]);
  fixture.setDraft("Summarize these");
  let prompt = await fixture.adapter.readPrompt();
  assert.equal(prompt.text, "Summarize these");
  assert.deepEqual([...prompt.files].map((file) => [file.name, file.type, atob(file.data)]), [["first.txt", "text/plain", "first"], ["second.txt", "text/plain", "second"]]);
  fixture.window.document.querySelector("[aria-label='Remove file']").click();
  prompt = await fixture.adapter.readPrompt();
  assert.deepEqual([...prompt.files].map((file) => file.name), ["second.txt"]);
  assert.deepEqual([...prompt.notCopied], []);
  site.tray.replaceChildren();
  site.paste([new File(["third"], "third.txt")]);
  assert.deepEqual([...(await fixture.adapter.readPrompt()).files].map((file) => file.name), ["third.txt"], "a sent composer starts afresh");
  const earlier = site.tray.firstElementChild.cloneNode(true);
  site.tray.prepend(earlier);
  prompt = await fixture.adapter.readPrompt();
  assert.deepEqual([...prompt.files].map((file) => file.name), ["third.txt"]);
  assert.deepEqual([...prompt.notCopied], ["1 attachment added before the extension could read it"]);
});

test("copies are attached to a destination, wait for its upload, and are removed again on cancel", async (t) => {
  const fixture = setup("claude");
  t.after(fixture.close);
  const site = acceptFiles(fixture);
  const copy = { name: "chart.png", type: "image/png", lastModified: 1, data: btoa("png-bytes") };
  const request = { requestId: "files-1", text: "What does this chart show?", source: false, attachments: 1 };
  fixture.adapter.preflight(request);
  await assert.rejects(fixture.adapter.stage({ ...request, files: [] }), /did not arrive intact/);
  await fixture.adapter.cancel(request);
  fixture.adapter.preflight({ ...request, requestId: "files-2" });
  await fixture.adapter.stage({ ...request, requestId: "files-2", files: [copy] });
  assert.equal(site.received.length, 1);
  assert.deepEqual([site.received[0].name, site.received[0].type, await site.text(site.received[0])], ["chart.png", "image/png", "png-bytes"]);
  assert.equal(fixture.adapter.getDraft().text, request.text);
  assert.equal((await fixture.adapter.cancel({ requestId: "files-2" })).leftAttachments, 0);
  assert.equal(site.tray.children.length, 0, "the copy is removed with the draft");
  assert.equal(fixture.adapter.getDraft().text, "");

  const next = { requestId: "files-3", text: "", source: false, attachments: 1 };
  fixture.adapter.preflight(next);
  await fixture.adapter.stage({ ...next, files: [copy] });
  const send = fixture.window.document.querySelector("button[aria-label='Send message']");
  send.disabled = true;
  setTimeout(() => { send.disabled = false; }, 300);
  assert.equal((await fixture.adapter.validate(next)).ok, true, "validation waits for the upload to finish");
  assert.equal(fixture.adapter.commit(next).status, "clicked");
  assert.equal(fixture.clicks(), 1);
  assert.equal(site.received.length, 2, "each copy is attached once");
});

test("a destination that shows no sign of the copies is never sent to", async (t) => {
  const fixture = setup("grok");
  t.after(fixture.close);
  acceptFiles(fixture, { on: [] });
  const request = { requestId: "ignored", text: "Look at this", source: false, attachments: 1 };
  fixture.adapter.preflight(request);
  const realNow = fixture.window.Date.now;
  let skew = 0;
  fixture.window.Date.now = () => realNow() + (skew += 5_000);
  await assert.rejects(fixture.adapter.stage({ ...request, files: [{ name: "a.pdf", type: "application/pdf", data: btoa("pdf") }] }),
    /Grok did not show the copied attachments/);
  fixture.window.Date.now = realNow;
  await fixture.adapter.cancel(request);
  assert.equal(fixture.adapter.getDraft().text, "");
  assert.equal(fixture.clicks(), 0);
});

test('Gemini counts nested PDF tiles once and removes its close-labelled copies on rollback', async t => {
  const f = setup('gemini'); t.after(f.close);
  const site = acceptFiles(f, {on:[]});
  f.editor.addEventListener('paste', e => {
    e.preventDefault();
    for (const file of e.clipboardData.files) {
      const tile = f.window.document.createElement('uploader-file-preview');
      tile.innerHTML = `<gem-attachment><span>PDF ${file.name}</span><button aria-label="close ${file.name}"></button></gem-attachment>`;
      tile.querySelector('button').onclick = () => tile.remove(); site.tray.append(tile);
    }
  });
  const request = {requestId:'gemini-pdfs',text:'Compare both PDFs',attachments:2};
  f.adapter.preflight(request);
  await f.adapter.stage({...request,files:['a.pdf','b.pdf'].map(name=>({name,type:'application/pdf',data:btoa('pdf')}))});
  assert.equal((await f.adapter.validate(request)).ok,true);
  assert.equal(f.clicks(),0);
  assert.equal((await f.adapter.cancel(request)).leftAttachments,0);
  assert.equal(site.tray.children.length,0);
  assert.equal(f.adapter.getDraft().text,'');
});

for (const provider of ['claude','grok']) {
  test(`${provider}: PDFs use the file input once even when unrelated DOM changes during upload`, async t => {
    const f=setup(provider);t.after(f.close);
    const site=acceptFiles(f,{on:[]});
    const input=f.window.document.createElement('input');input.type='file';input.multiple=true;input.accept='*/*';
    // jsdom has no DataTransfer/FileList, so the fake picker retains the supplied files.
    Object.defineProperty(input,'files',{value:[],writable:true});
    f.editor.closest('form').append(input);
    let uploads=0, pasted=0;
    f.editor.addEventListener('paste',()=>{pasted++;f.window.document.body.append(f.window.document.createElement('aside'));});
    input.addEventListener('change',()=>{
      uploads++;
      const files=[...input.files];
      setTimeout(()=>{for(const file of files){
        const tile=f.window.document.createElement('div');tile.dataset.testid='file-thumbnail';
        tile.innerHTML=`<img alt="${file.name}"><button aria-label="Remove ${file.name}"></button>`;
        tile.querySelector('button').onclick=()=>tile.remove();site.tray.append(tile);
      }},150);
    });
    const text='START-261\n'+('Long plain-text paragraph.\n'.repeat(700))+'END-934';
    const request={requestId:'pdf-long',text,attachments:2};
    f.adapter.preflight(request);
    await f.adapter.stage({...request,files:['a.pdf','b.pdf'].map(name=>({name,type:'application/pdf',data:btoa('pdf')}))});
    assert.equal((await f.adapter.validate(request)).ok,true);
    assert.equal(f.adapter.getDraft().text,text);
    assert.equal(uploads,1);assert.equal(pasted,0);
    assert.equal(f.adapter.commit(request).status,'clicked');assert.equal(f.clicks(),1);
  });
}

test('ChatGPT expands a collapsed paste before reading it and keeps the separate typed instructions', async t => {
  const f=setup();t.after(f.close);
  const text='START-261\n'+('Long pasted paragraph.\n'.repeat(700))+'END-934';
  f.setDraft('Check the attached PDFs.');
  const card=f.window.document.createElement('span');card.className='composer-attachment-surface';
  card.innerHTML='<span>START-261 …</span><button>Show in text field</button><button aria-label="Remove pasted text attachment"></button>';
  f.editor.closest('form').prepend(card);
  card.querySelector('button').onclick=()=>{f.setDraft(f.adapter.getDraft().text+'\n\n'+text);card.remove();};
  const prompt=await f.adapter.readPrompt();
  assert.equal(prompt.text,'Check the attached PDFs.\n\n'+text);
  assert.equal(prompt.notCopied.length,0);assert.equal(prompt.files.length,0);assert.equal(f.clicks(),0);
  assert.equal(f.adapter.preflight({requestId:'expanded',text:prompt.text,source:true}).ok,true);
});

test('a rejected upload cannot be submitted even if the site enables Send', async t => {
  const f=setup('claude');t.after(f.close);
  const site=acceptFiles(f);
  const request={requestId:'rejected-pdf',text:'Read the PDF',attachments:1};
  f.adapter.preflight(request);
  await f.adapter.stage({...request,files:[{name:'a.pdf',type:'application/pdf',data:btoa('pdf')}]});
  site.tray.firstElementChild.dataset.state='failed';
  site.tray.firstElementChild.prepend('Upload refused');
  await assert.rejects(f.adapter.validate(request),/rejected an attachment/);
  assert.throws(()=>f.adapter.commit(request),/rejected an attachment/);
  await f.adapter.cancel(request);
  assert.equal(site.tray.children.length,0);assert.equal(f.clicks(),0);
});

test('an enabled Send cannot submit a pending upload; validation waits for the tile to finish', async t => {
  const f=setup('claude');t.after(f.close);
  const site=acceptFiles(f);
  const request={requestId:'pending-pdf',text:'Read the PDF',attachments:1};
  f.adapter.preflight(request);
  await f.adapter.stage({...request,files:[{name:'a.pdf',type:'application/pdf',data:btoa('pdf')}]});
  const tile=site.tray.firstElementChild;tile.dataset.state='pending';tile.setAttribute('aria-busy','true');
  assert.throws(()=>f.adapter.commit(request),/still processing/);
  setTimeout(()=>{tile.dataset.state='complete';tile.removeAttribute('aria-busy');},300);
  assert.equal((await f.adapter.validate(request)).ok,true);
  assert.equal(f.adapter.commit(request).status,'clicked');assert.equal(f.clicks(),1);
});

test('cancellation preserves attachments added by the user during staging', async t => {
  const f=setup('grok');t.after(f.close);
  const site=acceptFiles(f);
  const request={requestId:'user-files',text:'Check this',attachments:1};
  f.adapter.preflight(request);
  await f.adapter.stage({...request,files:[{name:'copied.pdf',type:'application/pdf',data:btoa('pdf')}]});
  site.paste([new f.window.File(['mine'],'my-notes.txt')]);
  assert.throws(()=>f.adapter.commit(request),/Attachments changed/);
  assert.equal((await f.adapter.cancel(request)).leftAttachments,2);
  assert.equal(site.tray.children.length,2);assert.equal(f.adapter.getDraft().text,'Check this');
  assert.equal(f.clicks(),0);
});

test('navigation guard allows saved idle chats and refuses unsaved or temporary conversations', t => {
  const fixture=setup();t.after(fixture.close);
  assert.throws(()=>fixture.adapter.canLeave(),/saved conversation link/);
  fixture.dom.reconfigure({url:'https://chatgpt.com/c/saved'});
  assert.equal(fixture.adapter.canLeave().ok,true);
  fixture.dom.reconfigure({url:'https://chatgpt.com/c/saved?temporary-chat=true'});
  assert.throws(()=>fixture.adapter.canLeave(),/saved conversation link/);
});

test('navigation guard lets a pane leave a sign-in page but not unrecognized unsent text', t => {
  const fixture=setup('claude');t.after(fixture.close);
  const main=fixture.window.document.querySelector('main');
  main.innerHTML='<h1>Sign in</h1><button>Continue with Google</button>';
  assert.equal(fixture.adapter.canLeave().ok,true);
  main.innerHTML='<textarea aria-label="Feedback"></textarea>';
  main.querySelector('textarea').value='Half-written note';
  assert.throws(()=>fixture.adapter.canLeave(),/unsent text/);
});

test('empty site composers with placeholder markup are not treated as drafts', t => {
  const saved={chatgpt:'/c/saved',claude:'/chat/saved',gemini:'/app/saved',grok:'/c/saved'};
  for (const [provider,html] of [
    ['chatgpt','<p data-placeholder="Ask anything" class="placeholder"><br class="ProseMirror-trailingBreak"></p>'],
    ['claude','<p data-placeholder="How can I help you today?" class="is-empty is-editor-empty"><br class="ProseMirror-trailingBreak"></p>'],
    ['gemini','<p><br></p>'],
    ['grok','<p data-placeholder="What do you want to know?" class="is-empty is-editor-empty"><br class="ProseMirror-trailingBreak"></p>'],
  ]) {
    const fixture=setup(provider);t.after(fixture.close);
    fixture.editor.innerHTML=html;
    fixture.dom.reconfigure({url:`https://${fixtures[provider].host}${saved[provider]}`});
    assert.equal(fixture.adapter.getDraft().text,'',provider);
    assert.equal(fixture.adapter.canLeave().ok,true,provider);
  }
});

test('reply previews omit accessibility duplicates and action timestamps', t => {
  const fixture=setup();t.after(fixture.close);
  fixture.window.document.querySelector('.markdown').innerHTML='<h2 class="sr-only">Claude responded: Hello</h2><p>Hello.</p><div role="toolbar"><button>Copy</button>just now</div>';
  assert.equal(fixture.adapter.getResponse({allowSelection:false}).text,'Hello.');
});

test("source changes between staging and committing are preserved", async (t) => {
  const fixture = setup();
  t.after(fixture.close);
  fixture.setDraft("Original prompt");
  const request = { requestId: "source-change", text: "Original prompt", source: true };
  fixture.adapter.preflight(request);
  await fixture.adapter.stage(request);
  fixture.setDraft("My newer prompt");
  assert.throws(() => fixture.adapter.commit(request), /draft changed/);
  await fixture.adapter.cancel(request);
  assert.equal(fixture.adapter.getDraft().text, "My newer prompt");
  assert.equal(fixture.clicks(), 0);
});

test("cancel clears only the untouched destination draft", async (t) => {
  const fixture = setup();
  t.after(fixture.close);
  const request = { requestId: "cancel-1", text: "Inserted prompt", source: false };
  fixture.adapter.preflight(request);
  await fixture.adapter.stage(request);
  await fixture.adapter.cancel(request);
  assert.equal(fixture.adapter.getDraft().text, "");
  const next = { ...request, requestId: "cancel-2" };
  fixture.adapter.preflight(next);
  await fixture.adapter.stage(next);
  fixture.setDraft("Inserted prompt with my edits");
  await fixture.adapter.cancel(next);
  assert.equal(fixture.adapter.getDraft().text, "Inserted prompt with my edits");
});

test("stale conversations, disabled Send, and expired requests cannot commit", async (t) => {
  const fixture = setup();
  t.after(fixture.close);
  const request = { requestId: "stale", text: "Prompt", source: false };
  fixture.adapter.preflight(request);
  await fixture.adapter.stage(request);
  const button = fixture.window.document.querySelector("button");
  button.disabled = true;
  assert.throws(() => fixture.adapter.commit(request), /not ready/);
  button.disabled = false;
  fixture.window.history.pushState({}, "", "/chat/other");
  assert.throws(() => fixture.adapter.commit(request), /conversation changed/);
  fixture.window.history.back();
  const originalNow = fixture.window.Date.now;
  fixture.window.Date.now = () => originalNow() + 61_000;
  assert.throws(() => fixture.adapter.commit(request), /expired/);
  assert.equal(fixture.clicks(), 0);
});

test("failed contenteditable insertion is reported and never submitted", async (t) => {
  const fixture = setup("chatgpt", { failEdit: true });
  t.after(fixture.close);
  const request = { requestId: "failed", text: "Prompt", source: false };
  fixture.adapter.preflight(request);
  await assert.rejects(() => fixture.adapter.stage(request), /Could not safely edit/);
  assert.throws(() => fixture.adapter.commit(request), /draft changed/);
  assert.equal(fixture.clicks(), 0);
});

test("read response prefers selection; latest assistant text preserves paragraphs", (t) => {
  const fixture = setup();
  t.after(fixture.close);
  const result = fixture.adapter.getResponse();
  assert.equal(result.text, "First paragraph.\n\nSecond paragraph.");
  assert.equal(result.partial, false);
  const selection = fixture.window.getSelection();
  const range = fixture.window.document.createRange();
  range.selectNodeContents(fixture.window.document.querySelector(".markdown p"));
  selection.addRange(range);
  assert.equal(fixture.adapter.getResponse().text, "First paragraph.");
  assert.equal(fixture.adapter.getResponse().partial, true);
});

test("shared replies keep each link's address", (t) => {
  const fixture = setup();
  t.after(fixture.close);
  fixture.window.document.querySelector(".markdown").innerHTML = "<p>See <a href='https://example.com/docs'>the docs</a>, <a href='https://example.com/faq'>https://example.com/faq</a> and <a href='/c/other'>this chat</a>.</p>";
  assert.equal(fixture.adapter.getResponse().text, "See the docs (https://example.com/docs), https://example.com/faq and this chat.");
});

test("sharing inserts text as a draft without any send click", async (t) => {
  const fixture = setup("grok");
  t.after(fixture.close);
  await fixture.adapter.insert({ text: "Please review:\n\nAn answer." });
  assert.equal(fixture.adapter.getDraft().text, "Please review:\n\nAn answer.");
  assert.equal(fixture.clicks(), 0);
  await assert.rejects(() => fixture.adapter.insert({ text: "Replace the draft" }), /already has a draft/);
});

test("textarea variants receive a native input event and retain line breaks", async (t) => {
  const fixture = setup("grok");
  t.after(fixture.close);
  const textarea = fixture.window.document.createElement("textarea");
  textarea.placeholder = "Ask anything";
  fixture.editor.replaceWith(textarea);
  let inputEvents = 0;
  textarea.addEventListener("input", () => { inputEvents += 1; });
  await fixture.adapter.insert({ text: "First line\nSecond line" });
  assert.equal(fixture.adapter.getDraft().text, "First line\nSecond line");
  assert.equal(inputEvents, 1);
  assert.equal(fixture.clicks(), 0);
});

const marked = (window) => {
  const node = window.document.createElement("ai-split-bridge");
  node.setAttribute("data-ai-split-bridge", "composer");
  return node;
};

test("the composer button sits before each site's row of mic, voice and Send buttons and stays put", (t) => {
  const chatgpt = (end) => `<form><div data-composer-footer><div><button aria-label='Add files and more'></button></div><div><div contenteditable='true' id='prompt-textarea' aria-label='Ask ChatGPT'></div></div><div class='justify-end'><button aria-label='Select ChatGPT model'>Extra High</button><div id='group'><span id='slot'><button aria-label='Dictate'></button></span>${end}</div></div></div></form>`;
  const layouts = {
    "chatgpt empty": ["chatgpt", chatgpt("<button aria-label='Start Voice'></button>")],
    "chatgpt typed": ["chatgpt", chatgpt("<button aria-label='Send'></button>")],
    "chatgpt signed out": ["chatgpt", "<form><div><textarea name='prompt' aria-label='Chat with ChatGPT'></textarea></div><div id='group'><button id='slot' aria-label='Start dictation' data-start-dictation></button><button aria-label='Send message' data-composer-submit></button></div></form>"],
    "grok empty": ["grok", "<div class='query-bar'><div><div contenteditable='true' aria-label='Ask Grok anything'></div></div><div id='group' class='ms-auto'><div class='model'><button>Auto</button></div><div id='slot'><button aria-label='Dictation (⌃D)'></button></div><button aria-label='Enter voice mode (⌘⇧O)'></button></div></div>"],
    "grok typed": ["grok", "<div class='query-bar'><div><div contenteditable='true' aria-label='Ask Grok anything'></div></div><div id='group' class='ms-auto'><div class='model'><button>Model: Fast</button></div><div id='slot'><button type='submit' aria-label='Submit' data-testid='chat-submit'></button></div></div></div>"],
    gemini: ["gemini", "<div class='text-input-field'><rich-textarea><div class='ql-editor' contenteditable='true'></div></rich-textarea><div class='trailing-actions-wrapper'><div class='model-picker-container'></div><div id='group' class='input-buttons-wrapper-bottom'><div id='slot' class='mic-button-container'><button aria-label='Dictate (⌘⇧D)'></button></div></div></div></div>"],
    claude: ["claude", "<fieldset><div><div class='ProseMirror' contenteditable='true' aria-label='Write your prompt to Claude'></div></div><div><div id='group'><button>Opus</button><div id='slot'><button aria-label='Send message'></button></div></div></div></fieldset>"],
    "unrecognized buttons": ["claude", "<fieldset><div><div class='ProseMirror' contenteditable='true' aria-label='Write your prompt to Claude'></div></div><div><button aria-label='Attach'>+</button><div id='group'><button>Opus 5</button><button id='slot' aria-label='Talk'></button><button aria-label='Go'></button></div></div></fieldset>"],
  };
  for (const [name, [provider, body]] of Object.entries(layouts)) {
    const fixture = setup(provider, { body });
    t.after(fixture.close);
    const document = fixture.window.document;
    const anchor = fixture.adapter.composerAnchor();
    assert.equal(anchor.parent, document.querySelector("#group"), name);
    assert.equal(anchor.before, document.querySelector("#slot"), name);
    anchor.parent.insertBefore(marked(fixture.window), anchor.before);
    const again = fixture.adapter.composerAnchor();
    assert.deepEqual([again.parent, again.before], [anchor.parent, anchor.before], `${name} anchor is stable after insertion`);
  }
});

test("no composer means no composer anchor", (t) => {
  const fixture = setup("chatgpt");
  t.after(fixture.close);
  fixture.window.document.querySelector("form").remove();
  assert.equal(fixture.adapter.composerAnchor(), null);
});

test("each finished reply gets one Share anchor in its own action bar after Copy, never a code block's", (t) => {
  const turn = (id, text) => `<article><div data-message-author-role='assistant'><div class='markdown'><p>${text}</p><pre><button aria-label='Copy'>Copy code</button>x = 1</pre></div></div><div class='actions'><span id='${id}'><button data-testid='copy-turn-action-button' aria-label='Copy'></button></span><button aria-label='Good response'></button></div></article>`;
  const user = "<article><div data-message-author-role='user'>Question</div><div><button data-testid='copy-turn-action-button' aria-label='Copy'></button></div></article>";
  const streaming = "<article><div data-message-author-role='assistant'><div class='markdown'><p>Still writing</p></div></div></article>";
  const fixture = setup("chatgpt", { body: `<main>${user}${turn("first", "First answer.")}${user}${turn("second", "Second answer.")}${streaming}</main><form><div contenteditable='true' id='prompt-textarea'></div></form>`, url: "https://chatgpt.com/c/saved" });
  t.after(fixture.close);
  const document = fixture.window.document;
  const anchors = [...fixture.adapter.replyAnchors()];
  assert.deepEqual(anchors.map(({ parent, before }) => [parent.className, before.previousElementSibling.id]), [["actions", "first"], ["actions", "second"]]);
  assert.deepEqual(anchors.map(({ response }) => fixture.adapter.replyText(response).text), ["First answer.\n\nx = 1", "Second answer.\n\nx = 1"]);
  const selection = fixture.window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(anchors[0].response.querySelector("p"));
  selection.addRange(range);
  const partial = fixture.adapter.replyText(anchors[0].response);
  assert.deepEqual([partial.text, partial.partial], ["First answer.", true]);
  assert.equal(fixture.adapter.replyText(anchors[1].response).partial, false, "a selection in another reply is ignored");
});

const replyLayouts = {
  chatgpt: (n, copy = true) => `<section data-talvt-turn-state>
    <div data-content-search-unit-key='${n}:user'><div>Question ${n}?</div><div><button aria-label='Copy message'></button><button aria-label='Share prompt'></button><button aria-label='Edit message'></button></div></div>
    <div data-content-search-unit-key='${n}:assistant'><h4 class='sr-only'>ChatGPT said:</h4><div data-markdown-text-style='assistant-message'><p>Answer ${n} <span data-d-component='badge'>OpenAI +2</span>here.</p><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></div></div>
    <div id='bar-${n}'>${copy ? `<span id='copy-${n}'><button aria-label='Copy'></button></span>` : ""}<span><button aria-label='Rate response'></button></span><span><button aria-label='Share'></button></span><span><button aria-label='Read aloud'></button></span><span id='more-${n}'><button aria-label='More actions'></button></span></div></section>`,
  gemini: (n, copy = true) => `<user-query><p>Question ${n}?</p><button aria-label='Copy prompt'></button></user-query><model-response><div class='model-response-text'><p>Answer ${n} here.</p></div><message-actions><div id='bar-${n}' class='buttons-container-v2'>
    <thumb-up-button><button aria-label='Good response'></button></thumb-up-button><thumb-down-button><button aria-label='Bad response'></button></thumb-down-button><regenerate-button><button aria-label='Redo'></button></regenerate-button>
    ${copy ? `<copy-button id='copy-${n}'><button data-test-id='copy-button' aria-label='Copy'></button></copy-button>` : ""}<div id='more-${n}'><button aria-label='Show more options'></button></div></div></message-actions></model-response>`,
  grok: (n, copy = true) => `<div><div class='message-bubble'><p>Question ${n}?</p></div><span><button aria-label='Edit'></button><button aria-label='Copy'></button><button aria-label='Save'></button></span></div>
    <div id='response-${n}'><div data-testid='assistant-message'><p>Answer ${n} here.</p></div><div><span id='bar-${n}'>${copy ? `<button id='copy-${n}' aria-label='Copy response'></button>` : ""}<button aria-label='Create share link'></button><button aria-label='Like'></button><button aria-label='Dislike'></button><button aria-label='Regenerate'></button><button id='more-${n}' aria-label='More actions'></button></span></div></div>`,
};

for (const [provider, turn] of Object.entries(replyLayouts)) {
  test(`${provider}: Share goes into each reply's own action bar, after Copy or else before More`, (t) => {
    const fixture = setup(provider, { body: `<main>${turn(1)}${turn(2, false)}</main><form>${fixtures[provider].editor}</form>`, url: `https://${fixtures[provider].host}/c/saved` });
    t.after(fixture.close);
    const document = fixture.window.document;
    const anchors = [...fixture.adapter.replyAnchors()];
    assert.equal(anchors.length, 2, "user messages have no Share anchor");
    assert.equal(anchors[0].parent, document.querySelector("#bar-1"));
    assert.equal(anchors[0].before, document.querySelector("#copy-1").nextElementSibling);
    assert.equal(anchors[1].parent, document.querySelector("#bar-2"));
    assert.equal(anchors[1].before, document.querySelector("#more-2"));
    const expected = provider === "chatgpt" ? "Answer 1 here.\n\nA | B\n1 | 2" : "Answer 1 here.";
    assert.equal(fixture.adapter.replyText(anchors[0].response).text, expected);
    assert.match(fixture.adapter.getResponse().text, /^Answer 2 here\./);
    anchors[0].parent.insertBefore(marked(fixture.window), anchors[0].before);
    assert.equal(fixture.adapter.replyAnchors()[0].before, anchors[0].before, "stable after insertion");
  });
}

const writing = {
  chatgpt: { prompt: "<div data-content-search-unit-key='2:user'><div>Shared reply</div></div>", reply: "<div data-content-search-unit-key='2:assistant'><div data-markdown-text-style='assistant-message'><p>Still writ</p></div></div>" },
  claude: {
    turn: (n) => `<div data-testid='user-message'><p>Question ${n}?</p></div><div><div class='font-claude-response'><p>Answer ${n} here.</p></div><div><button aria-label='Copy'></button><button aria-label='Give positive feedback'></button><button aria-label='Retry'></button></div></div>`,
    prompt: "<div data-testid='user-message'><p>Shared reply</p></div>", reply: "<div><div class='font-claude-response'><p>Still writ</p></div></div>",
  },
  gemini: { prompt: "<user-query><p>Shared reply</p></user-query>", reply: "<model-response><div class='model-response-text'><p>Still writ</p></div></model-response>" },
  grok: { reply: "<div><div data-testid='assistant-message'><p>Still writ</p></div></div>" },
};

for (const [provider, { turn = replyLayouts[provider], prompt, reply }] of Object.entries(writing)) {
  test(`${provider}: an earlier reply can be shared while the chat writes a newer one`, (t) => {
    const stop = "<button data-testid='stop-button' class='stop-button' aria-label='Stop response'></button>";
    const fixture = setup(provider, { body: `<main>${turn(1)}</main><form>${fixtures[provider].editor}${stop}</form>`, url: `https://${fixtures[provider].host}/c/saved` });
    t.after(fixture.close);
    const { adapter } = fixture;
    const main = fixture.window.document.querySelector("main");
    const [earlier] = adapter.replyAnchors();
    assert.throws(() => adapter.replyText(earlier.response), /still responding/, "the newest reply may still be growing");
    if (prompt) {
      main.insertAdjacentHTML("beforeend", prompt);
      assert.match(adapter.replyText(earlier.response).text, /^Answer 1 here\./, "a newer prompt shows it is finished");
    }
    main.insertAdjacentHTML("beforeend", reply);
    assert.match(adapter.replyText(earlier.response).text, /^Answer 1 here\./, "a newer reply shows it is finished");
    assert.throws(() => adapter.getResponse(), /still responding/, "an older reply is never passed off as the latest");
  });
}

test("a reply whose markup is not recognized still gets Share from its action bar", (t) => {
  const body = replyLayouts.chatgpt(1).replace("data-markdown-text-style='assistant-message'", "data-new-reply");
  const fixture = setup("chatgpt", { body: `<main>${body}</main><form>${fixtures.chatgpt.editor}</form>`, url: "https://chatgpt.com/c/saved" });
  t.after(fixture.close);
  const [anchor, ...rest] = fixture.adapter.replyAnchors();
  assert.equal(rest.length, 0);
  assert.equal(anchor.parent.id, "bar-1");
  assert.equal(fixture.adapter.replyText(anchor.response).text, "Answer 1 here.\n\nA | B\n1 | 2");
});

test("drafts are refused by an outgoing page and by the wrong site, marked so the bridge retries", async (t) => {
  const fixture = setup("claude", { url: "https://claude.ai/chat/saved" });
  t.after(fixture.close);
  const { page } = fixture.adapter.canLeave();
  assert.equal(page, fixture.window.performance.timeOrigin);
  for (const options of [{ notPage: page }, { provider: "gemini" }]) {
    await assert.rejects(fixture.adapter.insert({ text: "Draft", ...options }), (error) => error.retry === true && /still opening/.test(error.message));
    assert.throws(() => fixture.adapter.preflight({ requestId: `send-${options.provider}`, text: "Sent reply", ...options }),
      (error) => error.retry === true && /still opening/.test(error.message), "a shared reply is not sent through the outgoing page");
  }
  assert.equal(fixture.adapter.preflight({ requestId: "send-ok", text: "Sent reply", provider: "claude", notPage: page + 1 }).ok, true);
  await fixture.adapter.cancel({ requestId: "send-ok" });
  assert.equal(fixture.adapter.getDraft().text, "");
  await fixture.adapter.insert({ text: "Draft", provider: "claude", notPage: page + 1 });
  assert.equal(fixture.adapter.getDraft().text, "Draft");
});

test("runtime interface returns errors and only accepts this extension's messages", async (t) => {
  const fixture = setup();
  t.after(fixture.close);
  let listener;
  fixture.window.chrome = { runtime: {
    id: "test-extension",
    onMessage: { addListener: (callback) => { listener = callback; } },
    sendMessage: async () => ({ ok: true, provider: "chatgpt", peer: null, side: null, native: false, canManageSplit: false, chats: [], closed: [] }),
  } };
  fixture.window.eval(contentSource);
  assert.equal(listener({ type: "ASB_READ_DRAFT" }, { id: "another-extension" }, () => assert.fail("must not respond")), false);
  const result = await new Promise((resolve) => {
    assert.equal(listener({ type: "ASB_READ_DRAFT" }, { id: "test-extension" }, resolve), true);
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, "");
  const failure = await new Promise((resolve) => listener({ type: "ASB_COMMIT", requestId: "unknown" }, { id: "test-extension" }, resolve));
  assert.equal(failure.ok, false);
  assert.match(failure.error, /expired|already handled/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(fixture.window.document.querySelectorAll("ai-split-bridge[data-ai-split-bridge='layer']").length, 1);
  const composer = fixture.window.document.querySelector("ai-split-bridge[data-ai-split-bridge='composer']");
  assert.equal(composer?.style.display ?? "none", "none", "no other chats means no extra button");
  assert.equal(fixture.clicks(), 0);
});
