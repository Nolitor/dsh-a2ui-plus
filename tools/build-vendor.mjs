import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const vendor = join(root, 'vendor');
mkdirSync(vendor, { recursive: true });

const expected = `${manifest.name}-${manifest.version}.tgz`;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const cache = join(root, '.npm-cache');

console.log(`[build-vendor] ${manifest.name}@${manifest.version}`);
execFileSync(npm, ['pack', '--pack-destination', vendor, '--cache', cache], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env,
});

if (!existsSync(join(vendor, expected))) {
  const found = readdirSync(vendor).filter((name) => name.endsWith('.tgz'));
  throw new Error(`[build-vendor] expected ${expected}; found ${found.join(', ') || '(none)'}`);
}
console.log(`[build-vendor] wrote vendor/${expected}`);
