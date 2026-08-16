import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const RELEASE_BUNDLE = '@wsz987/dsh-channels';
export const RELEASE_REPOSITORY = 'git+https://github.com/wsz987/dsh-channels.git';
export const RELEASE_PACKAGE_NAMES = [
  '@wsz987/channel-core',
  '@wsz987/channel-control',
  '@wsz987/channel-harness',
  '@wsz987/channel-files',
  '@wsz987/channel-web',
  '@wsz987/channel-weixin',
  '@wsz987/channel-qq',
  '@wsz987/channel-dingtalk',
  '@wsz987/channel-lark',
  RELEASE_BUNDLE,
];

export function npmDistTag(version, override = process.env.NPM_DIST_TAG) {
  if (override) return override;
  return version.includes('-') ? 'beta' : 'latest';
}

export function readWorkspaceManifests(root = process.cwd()) {
  const entries = [];
  for (const parent of ['packages', 'apps']) {
    const parentPath = join(root, parent);
    for (const child of readdirSync(parentPath, { withFileTypes: true })) {
      if (!child.isDirectory()) continue;
      const directory = `${parent}/${child.name}`;
      const path = join(root, directory, 'package.json');
      try {
        entries.push({ directory, manifest: JSON.parse(readFileSync(path, 'utf8')) });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  return entries;
}

export function releasePackages(entries) {
  const workspaceByName = new Map(entries.map((entry) => [entry.manifest.name, entry]));
  const packages = RELEASE_PACKAGE_NAMES.map((name) => {
    const entry = workspaceByName.get(name);
    if (!entry) throw new Error(`missing release package ${name}`);
    const { directory, manifest } = entry;
    if (manifest.private === true) throw new Error(`${name} must be public`);
    return {
      name: manifest.name,
      version: manifest.version,
      directory,
      manifest,
    };
  });
  const byName = new Map(packages.map((entry) => [entry.name, entry]));
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];

  function visit(entry) {
    if (visited.has(entry.name)) return;
    if (visiting.has(entry.name)) throw new Error(`workspace dependency cycle at ${entry.name}`);
    visiting.add(entry.name);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(entry.manifest[field] ?? {})) {
        if (typeof range !== 'string' || !range.startsWith('workspace:')) continue;
        if (byName.has(name)) {
          visit(byName.get(name));
        } else if (workspaceByName.has(name)) {
          throw new Error(`${entry.name} depends on non-release workspace package ${name}`);
        }
      }
    }
    visiting.delete(entry.name);
    visited.add(entry.name);
    ordered.push(entry);
  }

  for (const entry of packages.sort((a, b) => a.name.localeCompare(b.name))) visit(entry);
  return ordered;
}

export function validateWorkspaceManifests(entries) {
  const packages = releasePackages(entries);
  if (!packages.some(({ name }) => name === RELEASE_BUNDLE)) {
    throw new Error(`missing release bundle ${RELEASE_BUNDLE}`);
  }
  for (const entry of packages) {
    if (typeof entry.version !== 'string' || entry.version.length === 0) {
      throw new Error(`${entry.name} must have a version`);
    }
    if (entry.manifest.publishConfig?.access !== 'public') {
      throw new Error(`${entry.name} publishConfig.access must be public`);
    }
    if (entry.manifest.repository?.url !== RELEASE_REPOSITORY) {
      throw new Error(`${entry.name} repository.url must be ${RELEASE_REPOSITORY}`);
    }
  }
  return packages;
}

export function bundleVersion(packages) {
  const bundle = packages.find(({ name }) => name === RELEASE_BUNDLE);
  if (!bundle) throw new Error(`missing release bundle ${RELEASE_BUNDLE}`);
  return bundle.version;
}

export function assertReleaseTag(refType, refName, version) {
  if (refType !== 'tag') return;
  const expected = `v${version}`;
  if (refName !== expected) throw new Error(`release tag ${refName ?? '<missing>'}; expected ${expected}`);
}

function dependencyEntries(manifest) {
  return ['dependencies', 'optionalDependencies', 'peerDependencies']
    .flatMap((field) => Object.entries(manifest[field] ?? {}));
}

export function assertPackedManifest(manifest, expected) {
  if (manifest.name !== expected.name) {
    throw new Error(`packed name ${manifest.name}; expected ${expected.name}`);
  }
  if (manifest.version !== expected.version) {
    throw new Error(`${expected.name} packed version ${manifest.version}; expected ${expected.version}`);
  }
  if (manifest.repository?.url !== RELEASE_REPOSITORY) {
    throw new Error(`${expected.name} packed repository.url must be ${RELEASE_REPOSITORY}`);
  }
  for (const [name, range] of dependencyEntries(manifest)) {
    if (typeof range === 'string' && range.startsWith('workspace:')) {
      throw new Error(`${expected.name} has workspace range for ${name}`);
    }
  }
}

export function classifyRegistryVersion(result, expectedVersion) {
  if (result.status === 0) {
    let version;
    try {
      version = JSON.parse(result.stdout.trim());
    } catch (error) {
      throw new Error(`npm view returned invalid JSON: ${error.message}`);
    }
    if (version !== expectedVersion) {
      throw new Error(`npm view returned ${JSON.stringify(version)}; expected ${expectedVersion}`);
    }
    return 'published';
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (/\bE404\b|404 Not Found/i.test(output)) return 'missing';
  throw new Error(`npm view failed before publish:\n${output.trim()}`);
}

function tarString(buffer, start, length) {
  return buffer.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
}

export function readPackedManifest(tarballPath) {
  const tar = gunzipSync(readFileSync(tarballPath));
  for (let offset = 0; offset + 512 <= tar.length;) {
    const name = tarString(tar, offset, 100);
    if (!name) break;
    const size = Number.parseInt(tarString(tar, offset + 124, 12).trim() || '0', 8);
    const bodyStart = offset + 512;
    if (name === 'package/package.json') {
      return JSON.parse(tar.subarray(bodyStart, bodyStart + size).toString('utf8'));
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${tarballPath} does not contain package/package.json`);
}
