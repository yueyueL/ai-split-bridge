import { mkdir, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
const name = `ai-split-bridge-${manifest.version}.zip`;
const zipPath = path.resolve('dist', name);

await mkdir('dist', { recursive: true });
await rm(zipPath, { force: true });
execFileSync('zip', ['-r', '-X', '-q', zipPath, '.', '-x', '.*', '*/.*'], { cwd: 'extension' });

const files = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n');
if (!files.includes('manifest.json')) throw new Error(`${name} has no manifest.json at its root.`);
console.log(`Zipped dist/${name} (${files.length} files) for the Chrome Web Store.`);
