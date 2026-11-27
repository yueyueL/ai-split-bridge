import { readFileSync } from 'node:fs';

// The popup and the content scripts load these plain scripts first, as popup.html and manifest.json list them.
export const translations = ['i18n.js', 'i18n-zh-CN.js']
  .map(file => readFileSync(new URL(`../extension/${file}`, import.meta.url), 'utf8')).join('\n');
