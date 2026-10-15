// Local-only UI and real-browser editing fixture. No AI website is contacted.
// Host matching is substituted in the served adapter; extension source is unchanged.
// Options: ?provider=chatgpt|claude|gemini|grok, &theme=dark, &split=none.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const hosts = { chatgpt: 'chatgpt.com', claude: 'claude.ai', gemini: 'gemini.google.com', grok: 'grok.com' };
const names = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', grok: 'Grok' };
const icon = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="PATH"/></svg>';
const glyph = {
  copy: icon.replace('PATH', 'M7 7h8v9H7zM5 13V4h8'),
  like: icon.replace('PATH', 'M6 9v7M6 9l3-5c1 0 2 1 2 2v2h4l-1 7H6'),
  mic: icon.replace('PATH', 'M10 3v9M7 6v3a3 3 0 0 0 6 0V6M5 10a5 5 0 0 0 10 0M10 15v2'),
  send: icon.replace('PATH', 'M10 15V5M6 9l4-4 4 4'),
};
const replies = {
  chatgpt: (text, i) => `<article class="turn"><div data-message-author-role="assistant"><div class="markdown">${text}</div></div>
    <div class="actions"><span><button data-testid="copy-turn-action-button" aria-label="Copy" id="copy-${i}">${glyph.copy}</button></span><button aria-label="Good response">${glyph.like}</button></div></article>`,
  claude: (text, i) => `<div class="turn"><div data-testid="assistant-message" class="font-claude-response">${text}</div>
    <div class="actions"><button data-testid="action-bar-copy" aria-label="Copy" id="copy-${i}">${glyph.copy}</button><button aria-label="Give positive feedback">${glyph.like}</button></div></div>`,
  gemini: (text, i) => `<model-response class="turn"><div class="model-response-text">${text}</div>
    <div class="actions"><button aria-label="Good response">${glyph.like}</button><button data-test-id="copy-button" aria-label="Copy" id="copy-${i}">${glyph.copy}</button></div></model-response>`,
  grok: (text, i) => `<div class="turn"><div class="message-bubble"><div class="response-content-markdown">${text}</div></div>
    <div class="actions"><button aria-label="Copy" id="copy-${i}">${glyph.copy}</button><button aria-label="Like">${glyph.like}</button></div></div>`,
};
// Rough stand-ins for each site's look, so the controls' per-site styling can be judged by eye.
const shape = (button, buttonRadius, action, actionRadius, composerRadius) => ({
  'button-size': button, 'button-radius': buttonRadius, 'action-size': action, 'action-radius': actionRadius, 'composer-radius': composerRadius,
});
const looks = {
  chatgpt: {
    font: 'ui-sans-serif,-apple-system,system-ui,sans-serif',
    light: { page: '#fff', fg: '#0d0d0d', muted: '#5d5d5d', bubble: '#f4f4f4', hover: '#0000000d', composer: '#fff', 'composer-border': '1px solid #0000001a', 'composer-shadow': '0 4px 16px #0000000d', send: '#000', 'on-send': '#fff', ...shape('36px', '999px', '32px', '8px', '28px') },
    dark: { page: '#212121', fg: '#ececec', muted: '#b4b4b4', bubble: '#303030', hover: '#ffffff14', composer: '#303030', 'composer-border': '1px solid #ffffff1a', 'composer-shadow': '0 4px 16px #0006', send: '#fff', 'on-send': '#000', ...shape('36px', '999px', '32px', '8px', '28px') },
  },
  claude: {
    font: 'ui-sans-serif,-apple-system,system-ui,sans-serif',
    light: { page: '#faf9f5', fg: '#141413', muted: '#73726c', bubble: '#f0eee6', hover: '#f0eee6', composer: '#fff', 'composer-border': '.5px solid #1f1e1d26', 'composer-shadow': '0 4px 20px #0000000a', send: '#c6613f', 'on-send': '#fff', ...shape('32px', '8px', '32px', '6px', '20px') },
    dark: { page: '#262624', fg: '#faf9f5', muted: '#9c9a92', bubble: '#141413', hover: '#ffffff0d', composer: '#30302e', 'composer-border': '.5px solid #dedcd126', 'composer-shadow': 'none', send: '#d97757', 'on-send': '#fff', ...shape('32px', '8px', '32px', '6px', '20px') },
  },
  gemini: {
    font: '"Google Sans","Google Sans Text","Helvetica Neue",sans-serif',
    light: { page: '#fff', fg: '#1f1f1f', muted: '#444746', bubble: '#e9eef6', hover: '#1f1f1f14', composer: '#f0f4f9', 'composer-border': '0', 'composer-shadow': 'none', send: 'transparent', 'on-send': '#444746', ...shape('40px', '999px', '40px', '999px', '32px') },
    dark: { page: '#131314', fg: '#e3e3e3', muted: '#c4c7c5', bubble: '#333537', hover: '#e3e3e314', composer: '#1e1f20', 'composer-border': '0', 'composer-shadow': 'none', send: 'transparent', 'on-send': '#c4c7c5', ...shape('40px', '999px', '40px', '999px', '32px') },
  },
  grok: {
    font: 'ui-sans-serif,Inter,system-ui,sans-serif',
    light: { page: '#fdfdfd', fg: '#0a0a0a', muted: '#6b6b6b', bubble: '#f2f2f2', hover: '#0000000d', composer: '#fff', 'composer-border': '1px solid #00000014', 'composer-shadow': '0 2px 10px #0000000a', send: '#0a0a0a', 'on-send': '#fff', ...shape('40px', '999px', '32px', '999px', '32px') },
    dark: { page: '#141414', fg: '#fafafa', muted: '#a3a3a3', bubble: '#242424', hover: '#ffffff12', composer: '#1f1f1f', 'composer-border': '1px solid #ffffff14', 'composer-shadow': 'none', send: '#fafafa', 'on-send': '#0a0a0a', ...shape('40px', '999px', '32px', '999px', '32px') },
  },
};
const send = `<button type="button" id="site-send" class="send-button" ATTRS>${glyph.send}</button>`;
const composers = {
  chatgpt: `<form class="composer"><div contenteditable="true" id="prompt-textarea" role="textbox" aria-label="Ask ChatGPT" data-placeholder="Ask anything"></div>
    <div class="trail"><span><button type="button" aria-label="Start dictation">${glyph.mic}</button></span>${send.replace('ATTRS', 'data-testid="send-button" aria-label="Send prompt"')}</div></form>`,
  claude: `<fieldset class="composer"><div class="ProseMirror" contenteditable="true" data-testid="chat-input" role="textbox" aria-label="Write your prompt to Claude" data-placeholder="Reply to Claude…"></div>
    <div class="trail"><button type="button" class="model">Opus 4.5</button><div>${send.replace('ATTRS', 'aria-label="Send message"')}</div></div></fieldset>`,
  gemini: `<div class="composer"><rich-textarea><div class="ql-editor" contenteditable="true" role="textbox" aria-label="Enter a prompt for Gemini" data-placeholder="Ask Gemini"></div></rich-textarea>
    <div class="trail"><button type="button" class="model">2.5 Flash</button><div class="input-buttons-wrapper-bottom"><div><button type="button" aria-label="Dictate">${glyph.mic}</button></div><div>${send.replace('ATTRS', 'aria-label="Send message"')}</div></div></div></div>`,
  grok: `<div class="composer"><div contenteditable="true" role="textbox" aria-label="Ask Grok anything" data-placeholder="What do you want to know?"></div>
    <div class="trail"><button type="button" class="model">Fast</button><div>${send.replace('ATTRS', 'data-testid="chat-submit" aria-label="Submit"')}</div></div></div>`,
};

function context(provider, split) {
  const others = Object.keys(hosts).filter(key => key !== provider);
  const [peer, other, closed] = others;
  const chats = [
    { id: 2, provider: peer, name: names[peer], title: 'Pricing review', side: split ? 'right' : null },
    { id: 3, provider: other, name: names[other], title: 'Launch checklist', side: null },
  ];
  return {
    ok: true, selfId: 1, provider, side: split ? 'left' : null, native: split, canManageSplit: false, switchMode: 'navigate',
    peer: split ? chats[0] : null, chats, closed: [{ provider: closed, name: names[closed], remembered: false }],
  };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const provider = Object.hasOwn(hosts, url.searchParams.get('provider')) ? url.searchParams.get('provider') : 'chatgpt';
    const dark = url.searchParams.get('theme') === 'dark';
    const split = url.searchParams.get('split') !== 'none';
    const file = url.pathname.slice(1);
    if (['adapters.js', 'content.js', 'popup.js', 'popup.css', 'settings.js'].includes(file)) {
      let source = await readFile(new URL(`../extension/${file}`, import.meta.url), 'utf8');
      if (file === 'adapters.js') source = source.replace('hosts.includes(location.hostname)', `hosts.includes(${JSON.stringify(hosts[provider])})`);
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript');
      return res.end(source);
    }
    if (/^icons\/[\w-]+\.png$/.test(file)) {
      res.setHeader('Content-Type', 'image/png');
      return res.end(await readFile(new URL(`../extension/${file}`, import.meta.url)));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (file === 'popup.html') {
      const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
      return res.end(html.replace('<head>', `<head><script>
        const synced = JSON.parse(sessionStorage.getItem('fixture-sync') || '{}');
        window.chrome = {storage:{sync:{
          async get(key) { return key in synced ? {[key]: synced[key]} : {}; },
          async set(value) { Object.assign(synced, value); sessionStorage.setItem('fixture-sync', JSON.stringify(synced)); },
        }}, runtime:{async sendMessage(m) {
          if (m.type === 'ASB_LIST') return {ok:true,canManageSplit:false,activeId:1,peer:{id:2,name:'Claude'},tabs:[
            {id:1,name:'ChatGPT',title:'New conversation',index:0},
            {id:2,name:'Claude',title:'New conversation',index:1}
          ]};
          return {ok:true,message:'Fixture only: no browser tabs changed.'};
        }}};
      </script>`));
    }
    const links = [...Object.keys(hosts).map(key => `<a href="/?provider=${key}${dark ? '&theme=dark' : ''}">${names[key]}</a>`),
      `<a href="/?provider=${provider}${dark ? '' : '&theme=dark'}${split ? '' : '&split=none'}">${dark ? 'Light' : 'Dark'}</a>`,
      `<a href="/?provider=${provider}${dark ? '&theme=dark' : ''}${split ? '&split=none' : ''}">${split ? 'No split' : 'Split'}</a>`,
      '<a href="/popup.html">Popup</a>'].join('');
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>${names[provider]} — bridge fixture</title>
      <style>
        :root {color-scheme:${dark ? 'dark' : 'light'};${Object.entries(looks[provider][dark ? 'dark' : 'light']).map(([key, value]) => `--${key}:${value}`).join(';')}}
        body {margin:0;font:16px/1.6 ${looks[provider].font};color:var(--fg);background:var(--page)}
        main {max-width:720px;margin:0 auto;padding:16px 20px 40px}
        nav {display:flex;gap:14px;font-size:13px;padding:10px 0 24px;color:var(--muted)} nav a {color:inherit}
        .user {margin:24px 0 24px auto;width:fit-content;max-width:70%;padding:10px 16px;border-radius:18px;background:var(--bubble)}
        .turn {display:block;margin-bottom:24px} .turn p {margin:0 0 12px} ${provider === 'claude' ? '.turn p {font-family:Georgia,serif}' : ''}
        .actions {display:flex;gap:2px;align-items:center;margin-left:-6px}
        .actions button {display:grid;place-items:center;width:var(--action-size);height:var(--action-size);border:0;border-radius:var(--action-radius);background:none;color:var(--muted);cursor:pointer}
        .actions button:hover {background:var(--hover);color:var(--fg)}
        .composer {display:block;margin:28px 0 0;padding:10px 10px 10px 16px;border:var(--composer-border);border-radius:var(--composer-radius);
          box-shadow:var(--composer-shadow);background:var(--composer)}
        [contenteditable] {min-height:28px;padding:6px 0;outline:none;white-space:pre-wrap}
        [contenteditable]:empty::before {content:attr(data-placeholder);color:var(--muted)}
        .trail {display:flex;justify-content:flex-end;align-items:center;gap:6px}
        .trail button {display:grid;place-items:center;width:var(--button-size);height:var(--button-size);border:0;border-radius:var(--button-radius);background:none;color:var(--muted);cursor:pointer}
        .trail .model {width:auto;padding:0 12px;font-size:14px;margin-right:auto}
        .trail div {display:flex;align-items:center;gap:6px}
        #site-send {background:var(--send);color:var(--on-send)}
        .tiles {display:flex;flex-wrap:wrap;gap:6px} .tiles:not(:empty) {margin-bottom:6px}
        .tile {display:flex;align-items:center;gap:6px;padding:6px 6px 6px 12px;border-radius:12px;background:var(--bubble);font-size:13px}
        .tile button {border:0;border-radius:999px;background:none;color:var(--muted);cursor:pointer}
        .checks {margin-top:40px;font-size:13px;color:#8f8f8f} .checks button {margin:6px 0} #results {white-space:pre-wrap}
        .checks textarea {width:100%;height:90px;font:inherit}
      </style>
      <main>
        <nav>${links}</nav>
        <div class="user">Can you check the pricing assumptions in this plan?</div>
        ${replies[provider]('<p>The plan assumes a 4% monthly churn, which is optimistic for a new product.</p><p>I would test the price with a smaller group first.</p>', 1)}
        <div class="user">What would you change first?</div>
        ${replies[provider]('<p>Start with the onboarding email: it carries most of the conversion.</p>', 2)}
        ${composers[provider]}
        <section class="checks"><b>Fixture</b> · ${names[provider]} · no requests to AI services
          <div><button id="run" type="button">Run editor checks</button></div><pre id="results" role="status">Not run yet.</pre>
          <label for="destination">Last message the extension would send</label><textarea id="destination" readonly></textarea>
        </section>
      </main>
      <script>
        const fixtureContext = ${JSON.stringify(context(provider, split))};
        const named = ids => ids.map(id => fixtureContext.chats.find(chat => chat.id === id).name).join(' and ');
        const record = m => { document.getElementById('destination').value = JSON.stringify(m, null, 2); };
        window.chrome = {runtime:{id:'fixture',onMessage:{addListener(){}},async sendMessage(m){
          if (m.type === 'ASB_CONTEXT') return fixtureContext;
          record(m);
          if (m.type === 'ASB_SEND') return {ok:true,message:'Fixture: would send to ' + named(m.targetIds) + '. Nothing sent.'};
          if (m.type === 'ASB_SHARE') return {ok:true,message:'Fixture: the reply would be shared. Nothing sent.'};
          if (m.type === 'ASB_SHOW') return {ok:true,message:'Fixture: no tabs changed.'};
          return {ok:false,error:'This local fixture does not handle ' + m.type + '.'};
        }}};
      </script><script src="/adapters.js?provider=${provider}"></script><script src="/content.js"></script>
      <script>
        const editor=document.querySelector('.composer [contenteditable]'); let clicks=0;let inputs=0;
        document.getElementById('site-send').onclick=()=>clicks++;
        editor.addEventListener('input',()=>inputs++);
        // Like the real sites: pasted, dropped, or picked files become removable tiles above the editor.
        const box=document.querySelector('.composer');const tiles=document.createElement('div');tiles.className='tiles';box.prepend(tiles);
        const picker=Object.assign(document.createElement('input'),{type:'file',multiple:true,hidden:true});box.append(picker);
        const addFiles=files=>{for(const file of files){const tile=document.createElement('div');tile.className='tile';tile.dataset.testid='file-preview';
          tile.innerHTML='<span></span><button type="button" aria-label="Remove file">×</button>';tile.firstChild.textContent=file.name;
          tile.lastChild.onclick=()=>tile.remove();tiles.append(tile);}};
        box.addEventListener('paste',e=>{if(e.clipboardData?.files.length){e.preventDefault();addFiles(e.clipboardData.files);}});
        box.addEventListener('dragover',e=>e.preventDefault());
        box.addEventListener('drop',e=>{e.preventDefault();addFiles(e.dataTransfer.files);});
        picker.addEventListener('change',()=>addFiles(picker.files));
        document.getElementById('run').onclick=async()=>{
          const output=document.getElementById('results');output.textContent='Running…';
          const log=[];const check=(ok,label)=>{if(!ok)throw Error(label);log.push('PASS '+label);};
          const a=window.AISplitAdapters;const text=${JSON.stringify('First line\nSecond line\n\nFinal paragraph')};
          try {
            editor.replaceChildren();clicks=0;inputs=0;
            const payload={requestId:crypto.randomUUID(),text,source:false};
            a.preflight(payload);await a.stage(payload);a.validate(payload);
            check(a.getDraft().text===text,'Multiline contenteditable insertion preserves text');
            check(inputs>0,'Browser editing emits an input event');
            await a.cancel(payload);check(a.getDraft().text==='','Cancellation clears the staged draft');
            const next={...payload,requestId:crypto.randomUUID()};
            a.preflight(next);await a.stage(next);a.validate(next);a.commit(next);
            check(clicks===1,'Commit clicks the identified Send button once');
            try{a.commit(next);}catch{}check(clicks===1,'Repeated commit does not click again');
            editor.replaceChildren();await a.insert({text:'A shared draft'});
            check(a.getDraft().text==='A shared draft'&&clicks===1,'Sharing inserts without submitting');
            const anchors=a.replyAnchors();
            check(anchors.length===2&&anchors.every((x,i)=>x.parent.contains(document.getElementById('copy-'+(i+1)))),'Each reply anchors in its own action bar');
            check(a.composerAnchor().parent.contains(document.getElementById('site-send')),'Composer anchors in the Send button group');
            editor.innerHTML='<p>See <span contenteditable="false"><a href="https://example.com/a">example.com/a</a></span> then <span contenteditable="false">Create image</span></p>';
            check(a.getDraft().text==='See https://example.com/a then Create image','Link and tool chips read as text');
            editor.replaceChildren();tiles.replaceChildren();
            const pasted=new DataTransfer();pasted.items.add(new File(['hello'],'notes.txt',{type:'text/plain'}));
            editor.dispatchEvent(new ClipboardEvent('paste',{clipboardData:pasted,bubbles:true,cancelable:true}));
            const prompt=await a.readPrompt();
            check(prompt.files.length===1&&prompt.files[0].name==='notes.txt'&&atob(prompt.files[0].data)==='hello','Pasted files are read for copying');
            tiles.replaceChildren();
            const copy={requestId:crypto.randomUUID(),text:'With a file',source:false,attachments:1};
            a.preflight(copy);await a.stage({...copy,files:prompt.files});
            check(tiles.children.length===1&&tiles.textContent.includes('notes.txt')&&a.getDraft().text==='With a file','Copied attachments appear in the composer once');
            await a.cancel(copy);
            check(tiles.children.length===0&&a.getDraft().text==='','Cancel removes the copied attachment and text');
            editor.replaceChildren();output.textContent=log.join('\\n')+'\\n'+log.length+' checks passed.';
          }catch(error){output.textContent=log.join('\\n')+'\\nFAIL '+error.message;}
        };
      </script></html>`);
  } catch (error) {
    res.statusCode = 500;
    res.end(error.message);
  }
});
server.listen(4173, '127.0.0.1', () => console.log('Local fixture: http://127.0.0.1:4173 (Ctrl+C to stop)'));
