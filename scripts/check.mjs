import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ['storage']);
assert.equal(manifest.host_permissions.length, 5);
for (const name of await readdir('extension')) {
  if (name.endsWith('.js')) execFileSync(process.execPath, ['--check', `extension/${name}`]);
}
for (const path of [manifest.background.service_worker, manifest.action.default_popup, ...manifest.content_scripts.flatMap(script => script.js)]) {
  await readFile(`extension/${path}`);
}
for (const icons of [manifest.icons, manifest.action.default_icon]) {
  for (const [size, path] of Object.entries(icons)) {
    const png = await readFile(`extension/${path}`);
    assert.equal(png.toString('latin1', 1, 4), 'PNG', `${path} is not a PNG`);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [Number(size), Number(size)], `${path} is not ${size}×${size}`);
  }
}
console.log('Manifest, referenced extension files and icons, and JavaScript syntax checked.');
