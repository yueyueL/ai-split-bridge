import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { composeShare } from "../extension/settings.js";
import { translations } from "./translations.js";

const adapterSource = await readFile(new URL("../extension/adapters.js", import.meta.url), "utf8");
const replyFilesSource = await readFile(new URL("../extension/reply-files.js", import.meta.url), "utf8");
const contentSource = await readFile(new URL("../extension/content.js", import.meta.url), "utf8");
const geminiQuillComposer = await readFile(new URL("./fixtures/gemini-quill-composer.html", import.meta.url), "utf8");

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
  window.eval(translations);
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

test("past prompts include only their own uploads, including a file-only turn without a copy button", async t => {
  const card = name => `<div data-testid="attachment-preview" data-filename="${name}"><span>${name}</span></div>`;
  const fixture = setup("claude", { body: `<main>
    <div data-turn-key="user-1">${card("report.pdf")}<div data-testid="user-message">Review our plan.</div></div>
    <section data-testid="assistant-message">One answer.</section>
    <div data-turn-key="user-2">${card("notes.pdf")}</div></main>` });
  t.after(fixture.close);
  fixture.window.eval(replyFilesSource);
  const { adapter, window } = fixture;
  const prompts = adapter.messages().filter(entry => entry.role === "user");
  assert.equal(prompts.length, 2);
  const [first, second] = prompts;
  const whole = await adapter.readMessage(first.element);
  assert.deepEqual(Array.from(whole.files, file => file.name), ["report.pdf"]);
  assert.equal(whole.text, "Review our plan.");
  assert.equal((await adapter.readMessage(second.element)).text, "");
  assert.ok(adapter.promptAnchors().some(anchor => anchor.response === second.element));
  const range = window.document.createRange();
  range.setStart(first.element.firstChild, 0);
  range.setEnd(first.element.firstChild, 6);
  window.getSelection().addRange(range);
  const excerpt = await adapter.readMessage(first.element);
  assert.equal(excerpt.text, "Review");
  assert.equal(excerpt.files, undefined);
  const transcript = await adapter.readMessages([second.element, first.element]);
  assert.deepEqual(Array.from(transcript.files, file => file.name), ["report.pdf", "notes.pdf"]);
  assert.match(transcript.text, /Review our plan\.[\s\S]*\[Files attached\]/);
  assert.equal(transcript.textWithoutFiles, "You:\nReview our plan.");
});

test("sharing a whole prompt discovers files behind its native more-files control", async t => {
  const fixture = setup("chatgpt", { body: `<article><div data-message-author-role="user">Review the PDFs.</div>
    <div class="uploads"><button aria-label="Open preview of one.pdf"></button>
    <button aria-expanded="false" aria-controls="more">1 more</button></div></article>` });
  t.after(fixture.close);
  fixture.window.eval(replyFilesSource);
  const button = fixture.window.document.querySelector("[aria-controls]");
  button.onclick = () => {
    button.setAttribute("aria-expanded", "true");
    button.insertAdjacentHTML("beforebegin", '<button aria-label="Open preview of two.pdf"></button>');
  };
  const [prompt] = fixture.adapter.messages();
  assert.equal(button.getAttribute("aria-expanded"), "false");
  const result = await fixture.adapter.readMessages([prompt.element]);
  assert.deepEqual(Array.from(result.files, file => file.name), ["one.pdf", "two.pdf"]);
});

test("an attachment beside a different prompt in a shared container is never borrowed", async t => {
  const fixture = setup("chatgpt", { body: `<article>
    <div data-message-author-role="user">First</div>
    <div data-message-author-role="user"><div data-testid="file-preview" data-filename="second.pdf">second.pdf</div>Second</div>
  </article>` });
  t.after(fixture.close);
  fixture.window.eval(replyFilesSource);
  const [first, second] = fixture.adapter.messages();
  assert.equal((await fixture.adapter.readMessage(first.element)).files, undefined);
  assert.equal((await fixture.adapter.readMessage(second.element)).text, "Second");
  assert.equal((await fixture.adapter.readMessage(second.element)).files[0].name, "second.pdf");
});

test("a past ChatGPT prompt reaches Gemini when its native Send appears after staging", async t => {
  const source = setup("chatgpt", { body: "<main><div data-message-author-role='user'>Compare the two outlines.</div></main>" });
  const destination = setup("gemini", { body: `<main>
    <model-response><button aria-label="Send message">Other action</button></model-response>
    <input-area-v2><div class="text-input-field">${fixtures.gemini.editor}</div>
      <div class="input-buttons-wrapper-bottom"><button class="send-button" aria-label="Dictate">Mic</button></div>
    </input-area-v2></main>` });
  t.after(source.close);
  t.after(destination.close);
  const sentPrompt = await source.adapter.readMessage(source.adapter.messageElements()[0].element);
  assert.equal(sentPrompt.prompt, true);
  const text = composeShare({}, { assistant: "ChatGPT", kind: "prompt", reply: sentPrompt.text });
  const request = { requestId: "share-past-prompt", text };
  const { adapter, window } = destination;
  let submitted = [], micClicks = 0;
  const row = window.document.querySelector(".input-buttons-wrapper-bottom");
  row.firstElementChild.onclick = () => { micClicks++; };
  adapter.preflight(request);
  await adapter.stage(request);
  const validated = adapter.validate(request);
  const send = window.document.createElement("button");
  send.disabled = true;
  send.setAttribute("aria-labelledby", "submit-label");
  send.innerHTML = '<span id="submit-label">Submit prompt (Enter)</span>';
  send.onclick = () => { submitted.push(adapter.getDraft().text); };
  row.append(send);
  window.setTimeout(() => { send.disabled = false; }, 150);
  await validated;
  assert.equal(submitted.length, 0);
  adapter.commit(request);
  assert.deepEqual(submitted, [text]);
  assert.equal(destination.clicks(), 0, "the button outside the current composer is never used");
  assert.equal(micClicks, 0);
});

test("Gemini shares a prompt through the native Send alongside Quill's offscreen clipboard", async t => {
  const f = setup("gemini", { body: geminiQuillComposer });
  t.after(f.close);
  const doc = f.window.document;
  const submitted = [];
  doc.querySelector("#send").onclick = () => submitted.push(f.adapter.getDraft().text);
  const text = composeShare({}, { assistant: "ChatGPT", kind: "prompt", reply: "Compare the two outlines." });
  const request = { requestId: "gemini-quill-share", text };
  f.adapter.preflight(request);
  await f.adapter.stage(request);
  await f.adapter.validate(request);
  const host = doc.querySelector("gem-icon-button");
  host.setAttribute("aria-disabled", "true");
  assert.throws(() => f.adapter.commit(request), /not ready/);
  host.setAttribute("aria-disabled", "false");
  assert.equal(f.adapter.commit(request).status, "clicked");
  assert.deepEqual(submitted, [text]);
  assert.equal(f.clicks(), 0, "the persistent microphone must never be clicked");
  assert.equal(doc.querySelector(".ql-clipboard").textContent, "");
});

test("Gemini keeps a verified text share as an editable draft if its Send disappears", async t => {
  const f = setup("gemini");
  t.after(f.close);
  const request = { requestId: "manual-gemini-share", text: "A previously sent prompt" };
  f.adapter.preflight(request);
  await f.adapter.stage(request);
  await f.adapter.validate({ ...request, keepIfSendMissing: true });
  f.window.document.querySelector("button").remove();
  assert.equal(f.adapter.commit(request).status, "draft");
  await f.adapter.cancel(request);
  assert.equal(f.adapter.getDraft().text, request.text);
  assert.equal(f.clicks(), 0);
  assert.throws(() => f.adapter.commit(request), /already handled/);
});

test("a Gemini comparison draft needs an unchanged answer and editor, even when the native Send is disabled", async t => {
  const f = setup("gemini");
  t.after(f.close);
  f.window.document.querySelector("button").disabled = true;
  const answer = f.adapter.readCompareAnswer();
  const request = { requestId: "comparison-draft", text: "Compare the two responses", answer, draftOnly: true };
  f.adapter.preflight(request);
  await f.adapter.stage(request);
  await f.adapter.validate(request);
  assert.throws(() => f.adapter.commit(request), /draft/i);
  f.setDraft("My edited comparison");
  assert.throws(() => f.adapter.keep(request), /draft changed/i);
  await f.adapter.cancel(request);
  assert.equal(f.adapter.getDraft().text, "My edited comparison");
  assert.equal(f.clicks(), 0);
});

test("Send both can prepare a Gemini tab while its editor is mounting", async t => {
  const f = setup("gemini");
  t.after(f.close);
  const form = f.editor.closest("form");
  form.remove();
  const request = { requestId: "gemini-mount", text: "Two outlines" };
  f.window.setTimeout(() => f.window.document.querySelector("main").append(form), 80);
  await f.adapter.preflight(request);
  await f.adapter.stage(request);
  await f.adapter.validate(request);
  assert.equal(f.adapter.commit(request).status, "clicked");
  assert.equal(f.clicks(), 1);
});

test("a shared draft waiting for Gemini's editor cannot follow a conversation change", async t => {
  const f = setup("gemini");
  t.after(f.close);
  const form = f.editor.closest("form");
  form.remove();
  const insertion = f.adapter.insert({ text: "For the first conversation" });
  f.window.history.pushState({}, "", "/app/another");
  f.window.document.querySelector("main").append(form);
  await assert.rejects(insertion, /conversation changed/i);
  assert.equal(f.adapter.getDraft().text, "");
  assert.equal(f.clicks(), 0);
});

test("Gemini never treats a lone Quill clipboard as the composer or ignores another editor", async t => {
  const f = setup("gemini", { body: geminiQuillComposer });
  t.after(f.close);
  const doc = f.window.document;
  const request = { requestId: "ambiguous-quill", text: "Use the intended chat" };
  f.adapter.preflight(request);
  await f.adapter.stage(request);
  const extra = doc.createElement("div");
  extra.setAttribute("contenteditable", "true");
  doc.querySelector("rich-textarea").append(extra);
  assert.throws(() => f.adapter.commit(request), /Cannot identify Gemini's Send button/);
  extra.remove();
  f.editor.remove();
  assert.throws(() => f.adapter.getDraft(), /Cannot find Gemini's text composer/);
  assert.equal(f.clicks(), 0);
});

test("Gemini rechecks the site's current action at commit and refuses unrelated Send controls", async t => {
  const f = setup("gemini", { body: `<aside><button aria-label="Send message"></button></aside>
    <form>${fixtures.gemini.editor}<button data-test-id="send-button" aria-label="发送消息"></button>
    <button aria-label="Send feedback"></button></form>` });
  t.after(f.close);
  const request = { requestId: "gemini-changed-action", text: "A message" };
  f.adapter.preflight(request);
  await f.adapter.stage(request);
  await f.adapter.validate(request);
  const action = f.window.document.querySelector("[data-test-id='send-button']");
  action.setAttribute("aria-label", "Microphone");
  let micClicks = 0;
  action.onclick = () => { micClicks++; };
  assert.throws(() => f.adapter.commit(request), /Cannot identify Gemini's Send button/);
  assert.equal(micClicks, 0);
  assert.equal(f.clicks(), 0);
});

test("Gemini accepts a localized submit tooltip with a keyboard hint after staging a shared prompt", async t => {
  const f = setup("gemini", { body: `<input-area-v2>${fixtures.gemini.editor}
    <button aria-label="语音输入"></button><button aria-label="发送提示（Enter）"></button>
    </input-area-v2>` });
  t.after(f.close);
  const clicked = [];
  for (const control of f.window.document.querySelectorAll("button")) {
    control.onclick = () => clicked.push(control.getAttribute("aria-label"));
  }
  const request = { requestId: "localized-gemini", text: "Please check both examples." };
  f.adapter.preflight(request);
  await f.adapter.stage(request);
  await f.adapter.validate(request);
  f.adapter.commit(request);
  assert.deepEqual(clicked, ["发送提示（Enter）"]);
});

test("Gemini finds a sibling action row in an unrecognized shell without reaching another form or the transcript", async t => {
  const f = setup("gemini", { body: `<main><div class="conversation-page">
    <model-response><button aria-label="Send"></button></model-response>
    <div class="new-chat-shell"><div class="editing-surface">${fixtures.gemini.editor}</div>
      <div class="action-row"><button id="actual-send" aria-label="Send message"></button></div>
      <form><button aria-label="Send message"></button></form>
    </div><button aria-label="Send message">Other action</button></div></main>` });
  t.after(f.close);
  const doc = f.window.document;
  let clicks = 0;
  doc.querySelector("#actual-send").onclick = () => { clicks++; };
  const request = { requestId: "sibling-action", text: "Use the same outline" };
  f.adapter.preflight(request);
  await f.adapter.stage(request);
  await f.adapter.validate(request);
  const send = doc.querySelector("#actual-send");
  send.hidden = true;
  assert.throws(() => f.adapter.commit(request), /Cannot identify Gemini's Send button/);
  send.hidden = false;
  f.adapter.commit(request);
  assert.equal(clicks, 1);
  assert.equal(f.clicks(), 0);
});

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

// Model the native site consuming the draft and appending a user turn with
// preview-only cards. Exercise sharing through the same public API as the UI.
function appendSentTurn(f, site, selector, names) {
  const element = f.window.document.createElement("div");
  element.setAttribute(...selector);
  element.dataset.messageId = f.window.crypto.randomUUID();
  element.textContent = f.editor.textContent;
  for (const name of names) {
    const preview = f.window.document.createElement("div");
    preview.dataset.testid = "attachment-preview";
    preview.dataset.filename = name;
    preview.textContent = name;
    element.append(preview);
  }
  f.editor.closest("form").before(element);
  site.tray.replaceChildren();
  f.setDraft("");
  return element;
}

for (const [provider, landing, saved, selector] of [
  ["chatgpt", "/g/example/project", "/g/example/c/new", ["data-message-author-role", "user"]],
  ["claude", "/new", "/chat/new", ["data-testid", "user-message"]],
  ["gemini", "/u/0/app", "/u/0/app/new", ["data-test-id", "user-query"]],
  ["grok", "/", "/c/new", ["data-testid", "user-message"]],
]) {
  test(provider + " shares the actual uploaded PDF from a prompt sent before the first chat URL was assigned", async t => {
    const f = setup(provider, {url: "https://" + fixtures[provider].host + landing});
    t.after(f.close);
    f.window.eval(replyFilesSource);
    const site = acceptFiles(f);
    const file = new f.window.File(["%PDF-first"], "report.pdf", { type: "application/pdf" });
    site.paste([file]);
    f.setDraft("Read the report");
    // ChatGPT via Enter, the other sites via their native Send control.
    if (provider === "chatgpt") f.editor.dispatchEvent(new f.window.KeyboardEvent("keydown", { key:"Enter", bubbles:true }));
    else f.editor.closest("form").querySelector("button[aria-label='" + fixtures[provider].send + "']").click();
    f.window.history.pushState({}, "", saved);
    const turn = appendSentTurn(f, site, selector, [file.name]);
    const shared = await f.adapter.readMessage(turn);
    assert.equal(shared.text, "Read the report");
    const [copy] = await f.adapter.readReplyFiles(shared.files);
    assert.deepEqual([copy.name, copy.type, atob(copy.data)], [file.name, file.type, "%PDF-first"]);
    turn.dataset.messageId = "a-recycled-turn";
    await assert.rejects(f.adapter.readReplyFiles(shared.files), /changed/);
  });
}

test("two identical prompts with equally named uploads each retain their own bytes; an unobserved upload stays unavailable", async t => {
  const f = setup();
  t.after(f.close);
  f.window.eval(replyFilesSource);
  const site = acceptFiles(f), selector = ["data-message-author-role", "user"];
  const turns = [];
  for (const version of ["old", "new"]) {
    site.paste([new f.window.File([version], "same.pdf")]);
    f.setDraft("Same question");
    f.editor.closest("form").querySelector("button[aria-label='Send']").click();
    turns.push(appendSentTurn(f, site, selector, ["same.pdf"]));
    await Promise.resolve();
  }
  for (const [index, expected] of ["old", "new"].entries()) {
    const shared = await f.adapter.readMessage(turns[index]);
    const [copy] = await f.adapter.readReplyFiles(shared.files);
    assert.equal(atob(copy.data), expected);
  }
  // The third prompt has the same text and card label, but the site restored
  // the attachment itself. The local originals from the earlier turns are not candidates.
  f.setDraft("Same question");
  const third = appendSentTurn(f, site, selector, ["same.pdf"]);
  assert.equal((await f.adapter.readMessage(third)).files[0].kind, "unavailable");
  f.window.history.replaceState({}, "", "/c/another");
  assert.equal((await f.adapter.readMessage(turns[0])).files[0].kind, "unavailable");
});

test("cancelled Enter, removed cards, and duplicate upload names never populate a different prompt", async t => {
  const f = setup();
  t.after(f.close);
  f.window.eval(replyFilesSource);
  const site = acceptFiles(f), selector = ["data-message-author-role", "user"];
  const attach = bytes => new f.window.File([bytes], "same.pdf");
  site.paste([attach("removed")]);
  f.setDraft("Original");
  f.editor.dispatchEvent(new f.window.KeyboardEvent("keydown", { key:"Enter", bubbles:true }));
  f.window.document.querySelector("[aria-label='Remove file']").click();
  const removed = appendSentTurn(f, site, selector, ["same.pdf"]);
  assert.equal((await f.adapter.readMessage(removed)).files[0].kind, "unavailable");
  site.paste([attach("first"), attach("second")]);
  f.setDraft("Original");
  f.editor.closest("form").querySelector("button[aria-label='Send']").click();
  const duplicate = appendSentTurn(f, site, selector, ["same.pdf", "same.pdf"]);
  assert.deepEqual(Array.from((await f.adapter.readMessage(duplicate)).files, file => file.kind), ["unavailable", "unavailable"]);
});

test("a file-only turn retains its original after a staged bridge commit", async t => {
  const f = setup("claude");
  t.after(f.close);
  f.window.eval(replyFilesSource);
  const site = acceptFiles(f);
  const request = { requestId:"file-only-turn", text:"", attachments:1 };
  const copy = { name:"first.pdf", type:"application/pdf", lastModified:10, data:btoa("%PDF-fixture") };
  f.adapter.preflight(request);
  await f.adapter.stage({ ...request, files:[copy] });
  await f.adapter.validate(request);
  f.adapter.commit(request);
  const turn = appendSentTurn(f, site, ["data-testid", "user-message"], ["first.pdf"]);
  const shared = await f.adapter.readMessage(turn);
  assert.equal(shared.text, "");
  const files = await f.adapter.readReplyFiles(shared.files);
  assert.equal(atob(files[0].data), "%PDF-fixture");
});

test("only a file picker belonging to the composer can supply the bytes for its sent card", async t => {
  const f = setup();
  t.after(f.close);
  f.window.eval(replyFilesSource);
  const site = acceptFiles(f);
  const form = f.editor.closest("form"), selector = ["data-message-author-role", "user"];
  const dialog = f.window.document.createElement("aside");
  form.after(dialog);
  for (const [owner, verified] of [[form, true], [dialog, false]]) {
    const picker = f.window.document.createElement("input");
    picker.type = "file";
    owner.append(picker);
    const file = new f.window.File([verified ? "composer original" : "other picker"], "notes.pdf");
    Object.defineProperty(picker, "files", {value: [file]});
    picker.dispatchEvent(new f.window.Event("change", {bubbles:true}));
    site.tray.innerHTML = '<div data-testid="file-preview"><span>notes.pdf</span><button aria-label="Remove file"></button></div>';
    f.setDraft("Check these notes");
    form.querySelector("button[aria-label='Send']").click();
    const turn = appendSentTurn(f, site, selector, [file.name]);
    const { files } = await f.adapter.readMessage(turn);
    if (verified) assert.equal(atob((await f.adapter.readReplyFiles(files))[0].data), "composer original");
    else assert.equal(files[0].kind, "unavailable");
  }
});

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

test("Gemini can leave a saved Gem conversation while protecting unsent drafts and unsaved Gem chats", t => {
  const f = setup("gemini", { url: "https://gemini.google.com/u/6/gem/tutor/turn-a" });
  t.after(f.close);
  assert.equal(f.adapter.canLeave().ok, true);
  f.setDraft("An unfinished question");
  assert.throws(() => f.adapter.canLeave(), /draft/);
  f.setDraft("");
  f.dom.reconfigure({ url: "https://gemini.google.com/u/6/gem/tutor" });
  assert.throws(() => f.adapter.canLeave(), /saved conversation link/);
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

test("ChatGPT project composer can send before the first chat exists", async t => {
  const fixture = setup("chatgpt", { url: "https://chatgpt.com/g/g-p-project/project", body: `<main>
    <div><div contenteditable='true' data-composer-markdown data-placeholder='New chat in Research'></div>
    <div id='controls'><button aria-label='Start dictation'></button><button data-composer-submit aria-label='Send prompt'></button></div></div></main>` });
  t.after(fixture.close);
  fixture.setDraft("Start this project conversation.");
  assert.equal(fixture.adapter.composerAnchor().parent.id, "controls");
  assert.equal((await fixture.adapter.readPrompt()).text, "Start this project conversation.");
});

test("Claude new-chat controls avoid hidden transition slots and remain anchored after input", t => {
  const fixture = setup("claude", { url: "https://claude.ai/new", body: `<fieldset>${fixtures.claude.editor}
    <div id='controls'><span id='send-slot' style='opacity:0'><button aria-label='Send message'></button><i></i></span>
    <button id='voice' aria-label='Use voice mode'></button></div></fieldset>` });
  t.after(fixture.close);
  const doc = fixture.window.document;
  assert.equal(fixture.adapter.composerAnchor().parent.id, "controls");
  doc.querySelector("#send-slot").style.opacity = "1";
  doc.querySelector("#voice").hidden = true;
  const anchor = fixture.adapter.composerAnchor();
  assert.ok(anchor.parent.isConnected);
  assert.notEqual(fixture.window.getComputedStyle(anchor.parent).opacity, "0");
});

const claudeSections = n => `<section id='claude-${n}'>
  <div data-testid='assistant-message' class='font-claude-response'><p>First section ${n}.</p></div>
  <div class='file-card-block' data-file='plan.md'><button>Download plan</button></div>
  <div class='font-claude-response'><p>Second section ${n}.</p></div>
  <div class='file-card-block' data-file='rubric.md'><button>Download rubric</button></div>
  <div class='font-claude-response'><p>Final section ${n}.</p></div>
  <div class='actions'><button aria-label='Copy'></button><button aria-label='Give positive feedback'></button></div></section>`;

test("Claude sharing collects all Markdown blocks and generated files in one turn", async t => {
  const fixture = setup("claude", { body: `<main><div data-testid='user-message'>Question one</div>${claudeSections(1)}
    <div data-testid='user-message'>Question two</div>${claudeSections(2)}</main><form>${fixtures.claude.editor}</form>` });
  t.after(fixture.close);
  const expanded = [];
  fixture.window.AISplitReplyFiles = {
    list: scope => [...scope.querySelectorAll("[data-file]")].map(node => ({ name: node.dataset.file, source: node })),
    expand: async scope => expanded.push(scope.id),
  };
  const anchors = fixture.adapter.replyAnchors();
  assert.equal(anchors.length, 2);
  const first = await fixture.adapter.readReply(anchors[0].response);
  assert.equal(first.text, "First section 1.\n\nSecond section 1.\n\nFinal section 1.");
  assert.deepEqual(Array.from(first.files, file => file.name), ["plan.md", "rubric.md"]);
  assert.deepEqual(expanded, ["claude-1"]);
  assert.equal(fixture.adapter.getResponse().text, "First section 2.\n\nSecond section 2.\n\nFinal section 2.");
  const selection = fixture.window.getSelection(), range = fixture.window.document.createRange();
  range.selectNodeContents(anchors[0].response.querySelectorAll("p")[1]);
  selection.addRange(range);
  const part = await fixture.adapter.readReply(anchors[0].response);
  assert.equal(part.text, "Second section 1.");
  assert.equal(part.partial, true);
  assert.equal(part.files, undefined);
});

test("multiple Claude Markdown segments do not make an unfinished reply shareable", async t => {
  const fixture = setup("claude", { body: `<main>${claudeSections(1)}</main><form>${fixtures.claude.editor}
    <button aria-label='Stop response'></button></form>` });
  t.after(fixture.close);
  const firstBlock = fixture.window.document.querySelector(".font-claude-response");
  assert.throws(() => fixture.adapter.replyText(firstBlock), /still responding/);
  fixture.window.document.querySelector(".actions").remove();
  assert.throws(() => fixture.adapter.replyText(firstBlock), /still responding/, "no action bar while streaming");
  await assert.rejects(fixture.adapter.readMessages([fixture.adapter.messages()[0].element]), /still responding/);
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
  grok: { prompt: "<div data-testid='user-message'><p>Shared reply</p></div>", reply: "<div><div data-testid='assistant-message'><p>Still writ</p></div></div>" },
};

for (const [provider, turn] of Object.entries({ ...replyLayouts, claude: writing.claude.turn })) {
  test(`${provider}: share selected prompts and replies in conversation order with speaker labels`, async t => {
    const fixture = setup(provider, { body: `<main>${turn(1)}${turn(2)}</main><form>${fixtures[provider].editor}</form>` });
    t.after(fixture.close);
    const entries = fixture.adapter.messages();
    assert.deepEqual(Array.from(entries, entry => entry.role), ["user", "assistant", "user", "assistant"]);
    assert.equal(entries[0].text, "Question 1?");
    const prompt = await fixture.adapter.readMessage(entries[0].element);
    assert.equal(prompt.prompt, true);
    assert.equal(prompt.text, "Question 1?");
    const range = fixture.window.document.createRange();
    range.selectNodeContents(entries[1].element.querySelector("p"));
    fixture.window.getSelection().addRange(range);
    const result = await fixture.adapter.readMessages([entries[3].element, entries[0].element, entries[1].element, entries[0].element]);
    assert.equal(result.conversation, true);
    assert.equal(result.partial, false);
    assert.ok(result.text.startsWith(`You:\nQuestion 1?\n\n---\n\n${fixture.adapter.name}:\nAnswer 1 here.`));
    assert.match(result.text, /Answer 2 here\./);
    assert.doesNotMatch(result.text, /Question 2/);
    if (provider === "chatgpt") assert.match(result.text, /A \| B\n1 \| 2/, "selection includes whole checked reply, not just highlighted paragraph");
    if (provider !== "claude") assert.equal(fixture.adapter.promptAnchors().length, 2);
    entries[0].element.remove();
    await assert.rejects(fixture.adapter.readMessages([entries[0].element]), /no longer on the page/);
    await assert.rejects(fixture.adapter.readMessages([]), /at least one/);
  });
}

test("selected messages abort if the conversation navigates while expanding files", async t => {
  const fixture = setup("claude", { body: `<main>${claudeSections(1)}</main><form>${fixtures.claude.editor}</form>` });
  t.after(fixture.close);
  fixture.window.AISplitReplyFiles = { list: () => [], expand: async () => fixture.window.history.pushState({}, "", "/new") };
  await assert.rejects(fixture.adapter.readMessages([fixture.adapter.messages()[0].element]), /conversation changed/);
});

test("Claude selected messages stay stable when native reply actions fade out on mouseleave", async t => {
  const fixture = setup("claude", { body: `<main>${writing.claude.turn(1)}</main><form>${fixtures.claude.editor}</form>` });
  t.after(fixture.close);
  const before = fixture.adapter.messages();
  const bar = fixture.adapter.replyAnchors()[0].parent;
  bar.style.opacity = "0";
  const after = fixture.adapter.messages();
  assert.equal(before[1].element, after[1].element);
  assert.equal(fixture.adapter.replyAnchors()[0].parent, bar);
  const result = await fixture.adapter.readMessages(before.map(entry => entry.element));
  assert.match(result.text, /You:\nQuestion 1\?/);
  assert.match(result.text, /Claude:\nAnswer 1 here\./);
});

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
  assert.equal(composer.shadowRoot.querySelector(".send").textContent, "Summarize…");
  assert.equal(composer.shadowRoot.querySelector(".more").hidden, true);
  assert.equal(fixture.clicks(), 0);
});

for (const provider of Object.keys(fixtures)) {
  test(`${provider}: Compare reads the whole latest answer without copying files or highlighted excerpts`, t => {
    const f = setup(provider);
    t.after(f.close);
    const { adapter, window } = f;
    const last = adapter.messageElements().at(-1).element;
    const selection = window.getSelection(), range = window.document.createRange();
    const textNode = last.querySelector('p').firstChild;
    range.setStart(textNode, 0);
    range.setEnd(textNode, 3);
    selection.addRange(range);
    window.AISplitReplyFiles = { list: () => assert.fail('Compare should only read answer text') };
    const status = adapter.compareStatus();
    assert.equal(status.ready, true);
    assert.equal('text' in status, false);
    const answer = adapter.readCompareAnswer();
    assert.equal(answer.turn, status.turn);
    assert.ok(answer.text.includes(textNode.nodeValue));
    assert.equal('files' in answer, false);
    assert.equal(adapter.checkCompareAnswer(answer).ok, true);
    last.querySelector('p').textContent = 'Different answer';
    assert.throws(() => adapter.checkCompareAnswer(answer), /answer .* changed/);
    const changed = adapter.readCompareAnswer();
    assert.notEqual(changed.turn, status.turn, 'an in-place regeneration invalidates an open chooser');
    last.replaceWith(last.cloneNode(true));
    assert.throws(() => adapter.checkCompareAnswer(changed), /answer .* changed/);
  });
}

test('Compare waits for a new reply or the end of streaming even with an older answer available', t => {
  const f = setup('chatgpt');
  t.after(f.close);
  const { adapter, window } = f;
  const last = adapter.messageElements().at(-1).element;
  const newPrompt = window.document.createElement('div');
  newPrompt.dataset.messageAuthorRole = 'user';
  newPrompt.textContent = 'Next question';
  last.after(newPrompt);
  assert.equal(adapter.compareStatus().ready, false);
  assert.throws(() => adapter.readCompareAnswer(), /latest prompt/);
  const streaming = last.cloneNode(true);
  newPrompt.after(streaming);
  streaming.setAttribute('aria-busy', 'true');
  assert.equal(adapter.compareStatus().ready, false);
  streaming.setAttribute('aria-busy', 'false');
  const stop = window.document.createElement('button');
  stop.setAttribute('aria-label', 'Stop generating');
  window.document.body.append(stop);
  assert.throws(() => adapter.readCompareAnswer(), /still responding/);
  stop.remove();
  const snapshot = adapter.readCompareAnswer();
  window.history.pushState({}, '', '/c/replaced');
  assert.throws(() => adapter.checkCompareAnswer(snapshot), /changed/);
});

test('Compare preserves a reviewer draft and refuses a last-moment answer change', async t => {
  const f = setup('gemini');
  t.after(f.close);
  const request = { requestId: 'compare-here', text: 'Compare these', answer: f.adapter.readCompareAnswer() };
  f.setDraft('My edits');
  assert.throws(() => f.adapter.preflight(request), /already has a draft/);
  assert.equal(f.adapter.getDraft().text, 'My edits');
  f.setDraft('');
  f.adapter.preflight(request);
  await f.adapter.stage(request);
  await f.adapter.validate(request);
  f.adapter.messageElements().at(-1).element.querySelector('p').textContent = 'Regenerated';
  assert.throws(() => f.adapter.commit(request), /answer in Gemini changed/);
  await f.adapter.cancel(request);
  assert.equal(f.adapter.getDraft().text, '');
  assert.equal(f.clicks(), 0);
});

test('Compare follows mixed Gemini and Grok renderers through the newest answer', t => {
  const gemini = setup('gemini', { body: `<main>
    <model-response><div class="model-response-text">Old answer</div></model-response>
    <user-query>My latest question</user-query>
    <model-response><details><summary>Show thinking</summary>Intermediate note</details>
    <message-content><p>New answer</p></message-content><message-actions>Tool labels</message-actions></model-response></main>` });
  const grok = setup('grok', { body: `<main>
    <div data-testid="assistant-message">Old answer</div>
    <div data-testid="user-message">My latest question</div>
    <div class="message-bubble"><div class="response-content-markdown">New answer</div></div></main>` });
  for (const page of [gemini, grok]) {
    t.after(page.close);
    assert.equal(page.adapter.readCompareAnswer().text, 'New answer');
  }
});

for (const [index, provider] of Object.keys(fixtures).entries()) {
  test(`${provider}: a cross-review identifies only the complete critique of its submitted request`, async t => {
    const f = setup(provider);
    t.after(f.close);
    const { adapter, window } = f;
    const form = window.document.querySelector('form');
    const append = html => form.insertAdjacentHTML('beforebegin', html);
    const read = { peerId: 73, read: true, reviewId: 'round-one' };
    const original = adapter.readCompareAnswer();
    const req = { requestId: 'review-send', text: 'Critically review:\n\nPeer answer', answer: original,
      review: { peerId: 73, reviewId: read.reviewId } };
    const draft = index % 2 === 1;
    adapter.preflight(req);
    await adapter.stage(req);
    await adapter.validate(req);
    assert.equal(adapter.reviewResult(read).ready, false, 'staging cannot start a round');
    if (draft) adapter.keep(req); else adapter.commit(req);
    assert.equal(adapter.reviewResult({ peerId: 73 }).pending, true);
    assert.equal(f.clicks(), draft ? 0 : 1);
    assert.equal(adapter.reviewResult({ peerId: 74 }).pending, undefined);
    if (!draft) {
      f.setDraft('');
      assert.throws(() => adapter.preflight({ ...req, requestId: 'duplicate' }), /cross-review was already sent/);
    }
    f.setDraft('');
    append(writing[provider].prompt.replace('Shared reply', 'Critically\u00a0 review:<br>Peer answer'));
    const prompt = adapter.messageElements().at(-1).element;
    prompt.setAttribute('data-asb-reading-collapsed', '');
    assert.equal(adapter.reviewResult(read).pending, true, 'the folded prompt is still recognized');
    append(writing[provider].reply.replace('Still writ', 'A claim needs verification.'));
    const critique = adapter.messageElements().at(-1).element;
    critique.setAttribute('aria-busy', 'true');
    assert.equal(adapter.reviewResult(read).ready, false);
    critique.setAttribute('aria-busy', 'false');
    const status = adapter.reviewResult({ peerId: 73 });
    assert.deepEqual(Object.keys(status).sort(), ['ok', 'ready', 'reviewId', 'turn']);
    assert.equal(status.reviewId, 'round-one');
    assert.equal(adapter.reviewResult({ ...read, reviewId: 'different' }).ready, false);
    assert.equal(adapter.reviewResult({ peerId: 73, read: true }).ready, false);
    const result = adapter.reviewResult(read);
    assert.equal(result.turn, status.turn);
    assert.equal(result.text, 'A claim needs verification.');
    assert.equal(result.original, original.text);
    assert.equal(result.url, window.location.href);
    critique.querySelector('p').textContent = 'A regenerated critique.';
    assert.notEqual(adapter.reviewResult(read).turn, status.turn);
    append(writing[provider].prompt);
    append(writing[provider].reply);
    assert.equal(adapter.reviewResult(read).ready, false, 'a follow-up answer is not this critique');
    append(writing[provider].prompt.replace('Shared reply', 'Critically review:<br>Peer answer'));
    append(writing[provider].reply);
    assert.equal(adapter.reviewResult(read).ready, false, 'repeating the same request later cannot rebind it');
  });
}

test('an edited draft, cancelled review, or navigation cannot supply a critique', async t => {
  const f = setup('gemini');
  t.after(f.close);
  const { adapter, window } = f;
  const form = window.document.querySelector('form');
  const review = { peerId: 2, reviewId: 'latest-round' };
  const req = { requestId: 'review-a', text: 'Review this specific answer.', answer: adapter.readCompareAnswer(), review };
  adapter.preflight(req);
  await adapter.stage(req);
  await adapter.cancel(req);
  assert.equal(adapter.reviewResult(review).pending, undefined);
  const next = { ...req, requestId: 'review-b' };
  adapter.preflight(next);
  await adapter.stage(next);
  adapter.keep(next);
  f.setDraft('');
  assert.equal(adapter.reviewResult(review).pending, undefined, 'a discarded draft does not block retry');
  const retry = { ...req, requestId: 'review-c', review: { ...review, reviewId: 'new-round' } };
  adapter.preflight(retry);
  await adapter.stage(retry);
  adapter.keep(retry);
  const append = html => form.insertAdjacentHTML('beforebegin', html);
  append(writing.gemini.prompt.replace('Shared reply', 'Follow my edited instructions instead.'));
  append(writing.gemini.reply);
  assert.equal(adapter.reviewResult(retry.review).ready, false, 'an edited user turn cannot stand in for the review request');
  window.history.pushState({}, '', '/app/different');
  assert.equal(adapter.reviewResult(retry.review).ready, false);
  window.history.replaceState({}, '', '/chat/test');
  const p = adapter.messageElements().at(-2).element;
  p.textContent = retry.text;
  assert.equal(adapter.reviewResult(retry.review).ready, false, 'leaving the conversation discards the record');
});

test('a manually edited review keeps its quoted answer through native remounts and virtualization', async t => {
  const f = setup('chatgpt');
  t.after(f.close);
  const { adapter, window } = f;
  const document = window.document;
  const editorForm = document.querySelector('form');
  const original = adapter.messageElements().at(-1).element;
  original.setAttribute('data-message-id', 'original-answer');
  const quote = 'Answer from Claude (right pane)\nCheck the figures on page 8.';
  const instruction = 'Find the errors.\n\n';
  const review = { peerId: 3, reviewId: 'draft-round', quotedStart: instruction.length };
  const request = { requestId: 'draft-review', text: instruction + quote, answer: adapter.readCompareAnswer(), review };
  adapter.preflight(request);
  await adapter.stage(request);
  adapter.keep(request);
  const edited = 'Recheck the figures. Show your work.\n\n' + quote;
  f.setDraft(edited);
  assert.equal(adapter.reviewResult(review).pending, true);
  const remount = original.cloneNode(true);
  original.replaceWith(remount);
  assert.equal(adapter.reviewResult(review).pending, true, 'the original remount is recognized by ID and text');
  f.setDraft('');
  const user = document.createElement('div');
  user.dataset.messageAuthorRole = 'user';
  user.dataset.messageId = 'submitted-review-prompt';
  user.textContent = edited;
  editorForm.before(user);
  // Only the page observer sees the submitted prompt with its original still mounted.
  await new Promise(resolve => setImmediate(resolve));
  remount.remove();
  const remountedPrompt = user.cloneNode(true);
  user.replaceWith(remountedPrompt);
  editorForm.insertAdjacentHTML('beforebegin', writing.chatgpt.reply.replace('Still writ', 'The total is incorrect.'));
  const result = adapter.reviewResult({ ...review, read: true });
  assert.equal(result.ready, true, 'the bound native user turn survives both original and prompt remount');
  assert.equal(result.original, request.answer.text);
  assert.equal(result.text, 'The total is incorrect.');
  remountedPrompt.textContent = 'A different request.\n' + quote;
  assert.equal(adapter.reviewResult(review).ready, false, 'edits to an already submitted turn do not rebind it');
});

test('an edited peer quotation is not eligible for automatic revision', async t => {
  const f = setup('chatgpt');
  t.after(f.close);
  const { adapter, window } = f;
  const prefix = 'Critique this answer.\n\n';
  const review = { peerId: 6, reviewId: 'edited-quote', quotedStart: prefix.length };
  const req = { requestId: 'edited-quote-request', text: prefix + 'Answer from Claude (right pane)\nKeep this conclusion.',
    answer: adapter.readCompareAnswer(), review };
  adapter.preflight(req);
  await adapter.stage(req);
  adapter.keep(req);
  f.setDraft('');
  const form = window.document.querySelector('form');
  form.insertAdjacentHTML('beforebegin', writing.chatgpt.prompt.replace('Shared reply', 'Check this. Answer from Claude (right pane) Change this conclusion.'));
  form.insertAdjacentHTML('beforebegin', writing.chatgpt.reply);
  assert.equal(adapter.reviewResult(review).ready, false);
});

// ---------- Interface language ----------
test("refusals from a chat page are written in Chinese when it is chosen", async t => {
  const fixture = setup("claude");
  t.after(fixture.close);
  fixture.window.AISplitI18n.use("zh-CN");
  assert.throws(() => fixture.adapter.preflight({ requestId: "empty", text: "  ", source: false }), { message: "请先输入一条文字提问。" });
  fixture.setDraft("Keep my draft");
  assert.throws(() => fixture.adapter.preflight({ requestId: "guarded", text: "A prompt", source: false }),
    { message: "Claude 的输入框里已有草稿。请先发送或清除它；你的草稿已保留。" });
  assert.throws(() => fixture.adapter.canLeave(), { message: "切换前请先发送或清除 Claude 的草稿。草稿已保留。" });
  assert.equal(fixture.adapter.getDraft().text, "Keep my draft");
});

test("a shared conversation names its speakers in the chosen language", async t => {
  const fixture = setup("chatgpt", { body: `<main>${replyLayouts.chatgpt(1)}</main><form>${fixtures.chatgpt.editor}</form>` });
  t.after(fixture.close);
  const elements = Array.from(fixture.adapter.messages(), entry => entry.element);
  assert.ok((await fixture.adapter.readMessages(elements)).text.startsWith("You:\nQuestion 1?\n\n---\n\nChatGPT:\nAnswer 1 here."));
  fixture.window.AISplitI18n.use("zh-CN");
  assert.ok((await fixture.adapter.readMessages(elements)).text.startsWith("你：\nQuestion 1?\n\n---\n\nChatGPT：\nAnswer 1 here."));
  await assert.rejects(fixture.adapter.readMessages([]), { message: "请至少选择一条要分享的消息。" });
});
