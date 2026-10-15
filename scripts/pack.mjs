import { access, mkdir, readFile, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const extensionDir = path.join(root, 'extension');
const keyPath = path.join(root, 'keys', 'extension.pem');
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const manifest = JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
const packedName = `ai-split-bridge-${manifest.version}.crx`;
const packedPath = path.join(root, 'dist', packedName);

await access(chrome).catch(() => {
  throw new Error('Google Chrome was not found in /Applications.');
});
await mkdir(path.dirname(keyPath), { recursive: true });
await mkdir(path.dirname(packedPath), { recursive: true });

const hasKey = await access(keyPath).then(() => true, () => false);
const args = [
  `--user-data-dir=${path.join(tmpdir(), 'ai-split-bridge-pack')}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  `--pack-extension=${extensionDir}`,
  '--no-message-box',
];
if (hasKey) args.push(`--pack-extension-key=${keyPath}`);

await new Promise((resolve, reject) => {
  execFile(chrome, args, { timeout: 60000 }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr || stdout || error.message));
    else resolve();
  });
});

await rename(path.join(root, 'extension.crx'), packedPath);
if (!hasKey) await rename(path.join(root, 'extension.pem'), keyPath);

const der = createPublicKey(await readFile(keyPath)).export({ type: 'spki', format: 'der' });
const id = createHash('sha256').update(der).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
const header = await readFile(packedPath);
if (header.toString('latin1', 0, 4) !== 'Cr24' || header.readUInt32LE(4) !== 3) {
  throw new Error(`${packedName} is not a CRX3 package.`);
}

console.log(`Packed dist/${packedName}`);
console.log(`Extension ID: ${id}`);
console.log(hasKey ? 'Signed with the existing private key.' : 'Created a new private key at keys/extension.pem. Keep that file; it is not committed.');
