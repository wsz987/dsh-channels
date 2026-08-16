import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  assertPackedManifest,
  bundleVersion,
  classifyRegistryVersion,
  npmDistTag,
  readPackedManifest,
  readWorkspaceManifests,
  validateWorkspaceManifests,
} from './release-family.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'dist/npm');
const packages = validateWorkspaceManifests(readWorkspaceManifests(root));
const distTag = npmDistTag(bundleVersion(packages));
const releaseManifest = JSON.parse(readFileSync(resolve(output, 'manifest.json'), 'utf8'));
const expected = packages.map(({ name, version }) => ({ name, version }));
const actual = releaseManifest.artifacts.map(({ name, version }) => ({ name, version }));
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`artifact set mismatch: ${actual.map(({ name, version }) => `${name}@${version}`).join(', ')}`);
}

for (const [index, artifact] of releaseManifest.artifacts.entries()) {
  const entry = packages[index];
  const tarball = resolve(output, artifact.filename);
  const checksum = createHash('sha512').update(readFileSync(tarball)).digest('hex');
  if (checksum !== artifact.sha512) throw new Error(`checksum mismatch for ${artifact.filename}`);
  assertPackedManifest(readPackedManifest(tarball), entry);

  const view = spawnSync('npm', ['view', `${entry.name}@${entry.version}`, 'version', '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (classifyRegistryVersion(view, entry.version) === 'published') {
    console.log(`release publish: ${entry.name}@${entry.version} already exists; skipping`);
    continue;
  }
  const result = spawnSync('npm', ['publish', tarball, '--tag', distTag, '--access', 'public'], {
    cwd: root,
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`npm publish failed for ${entry.name}@${entry.version}`);
}
