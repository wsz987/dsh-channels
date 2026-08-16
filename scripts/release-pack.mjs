import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  assertPackedManifest,
  readPackedManifest,
  readWorkspaceManifests,
  validateWorkspaceManifests,
} from './release-family.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist/npm');
const packages = validateWorkspaceManifests(readWorkspaceManifests(root));
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const artifacts = [];
for (const entry of packages) {
  const result = spawnSync('pnpm', ['pack', '--json', '--pack-destination', output], {
    cwd: resolve(root, entry.directory),
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) throw new Error(`pack failed for ${entry.name}:\n${result.stdout}${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const filename = basename(Array.isArray(parsed) ? parsed[0].filename : parsed.filename);
  const tarball = resolve(output, filename);
  assertPackedManifest(readPackedManifest(tarball), entry);
  artifacts.push({
    name: entry.name,
    version: entry.version,
    filename,
    sha512: createHash('sha512').update(readFileSync(tarball)).digest('hex'),
  });
  console.log(`release pack: ${entry.name}@${entry.version} -> ${filename}`);
}

writeFileSync(resolve(output, 'manifest.json'), `${JSON.stringify({ artifacts }, null, 2)}\n`);
