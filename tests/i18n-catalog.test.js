import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const extension = new URL('../extension/', import.meta.url);
const read = file => readFileSync(new URL(file, extension), 'utf8');
const scripts = readdirSync(extension).filter(file => file.endsWith('.js') && !file.startsWith('i18n'));

// The text passed to t() is the key, so it has to be written out in full where it is used.
const call = /(?<![\w$.])t\(\s*/g;
const literal = /^(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/;
function keysIn(file) {
  const source = read(file);
  const keys = [];
  for (const match of source.matchAll(call)) {
    const rest = source.slice(match.index + match[0].length);
    const found = rest.match(literal);
    const line = source.slice(0, match.index).split('\n').length;
    assert.ok(found, `${file}:${line} passes t() something other than plain quoted text`);
    keys.push(vm.runInNewContext(found[0]));
  }
  return keys;
}

function popupKeys() {
  const { document } = new JSDOM(read('popup.html')).window;
  return [
    ...Array.from(document.querySelectorAll('[data-i18n]'), node => node.textContent),
    ...Array.from(document.querySelectorAll('[data-i18n-title]'), node => node.title),
    ...Array.from(document.querySelectorAll('[data-i18n-label]'), node => node.label),
    ...Array.from(document.querySelectorAll('[data-i18n-rich]'), node => node.innerHTML),
  ];
}

function catalog(language) {
  const catalogs = {};
  vm.runInNewContext(read(`i18n-${language}.js`), { AISplitI18n: { register(name, entries) { catalogs[name] = entries; } } });
  return catalogs[language];
}

const used = new Set([' and ', ', ', ...scripts.flatMap(keysIn), ...popupKeys()]);
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

test('every piece of interface text has a Chinese translation, and no translation is left unused', () => {
  const chinese = catalog('zh-CN');
  assert.ok(used.size > 300, 'the interface text was found');
  assert.deepEqual([...used].filter(key => !Object.hasOwn(chinese, key)), [], 'text without a translation');
  assert.deepEqual(Object.keys(chinese).filter(key => !used.has(key)), [], 'translations no text uses');
});

test('each translation fills in the same values as its English text and keeps the same emphasis', () => {
  for (const [english, chinese] of Object.entries(catalog('zh-CN'))) {
    assert.deepEqual(placeholders(chinese), placeholders(english), english);
    assert.equal((chinese.match(/<b>/g) || []).length, (english.match(/<b>/g) || []).length, english);
    if (english.trim()) assert.ok(chinese.trim(), `${english} has an empty translation`);
  }
});

test('the popup and every chat page load the translations before the scripts that use them', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const page = manifest.content_scripts.find(entry => entry.world !== 'MAIN').js;
  assert.deepEqual(page.slice(0, 2), ['i18n.js', 'i18n-zh-CN.js']);
  const main = manifest.content_scripts.find(entry => entry.world === 'MAIN').js;
  for (const file of main) assert.deepEqual(keysIn(file), [], `${file} runs in the page's own world, where the translations are not loaded`);

  const { document } = new JSDOM(read('popup.html')).window;
  const loaded = Array.from(document.querySelectorAll('script'), script => script.getAttribute('src'));
  assert.deepEqual(loaded.slice(0, 2), ['i18n.js', 'i18n-zh-CN.js']);
  assert.ok(Array.from(document.querySelectorAll('script')).slice(0, 2).every(script => script.type !== 'module'));
  assert.match(read('background.js'), /^import '\.\/i18n\.js';\nimport '\.\/i18n-zh-CN\.js';\n/);
});

test('the language list in the popup matches the languages the extension knows', () => {
  const scope = {};
  vm.runInNewContext(read('i18n.js'), scope);
  const { document } = new JSDOM(read('popup.html')).window;
  const options = Array.from(document.querySelectorAll('#language option'), option => option.value);
  assert.deepEqual(options, ['auto', ...scope.AISplitI18n.LANGUAGES]);
});
