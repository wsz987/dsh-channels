import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  RELEASE_BUNDLE,
  RELEASE_PACKAGE_NAMES,
  RELEASE_REPOSITORY,
  assertPackedManifest,
  assertReleaseTag,
  bundleVersion,
  classifyRegistryVersion,
  npmDistTag,
  releasePackages,
  validateWorkspaceManifests,
} from './release-family.mjs';
import {
  assertReleaseChannel,
  assertVersionMatchesChannel,
  releaseChannelFromArgs,
  syncRootVersion,
} from './release-version.mjs';

function entry(name, version, dependencies = {}, extra = {}) {
  return {
    directory: `packages/${name.split('/')[1]}`,
    manifest: {
      name,
      version,
      repository: { url: RELEASE_REPOSITORY },
      publishConfig: { access: 'public' },
      dependencies,
      ...extra,
    },
  };
}

test('release packages are public and dependency ordered', () => {
  assert.deepEqual(RELEASE_PACKAGE_NAMES, [
    '@wsz987/channel-core',
    '@wsz987/channel-control',
    '@wsz987/channel-harness',
    '@wsz987/channel-files',
    '@wsz987/channel-web',
    '@wsz987/channel-weixin',
    '@wsz987/channel-qq',
    '@wsz987/channel-dingtalk',
    '@wsz987/channel-lark',
    '@wsz987/channel-telegram',
    '@wsz987/channel-compat',
    '@wsz987/channel-testkit',
    '@wsz987/channel-verify',
    '@wsz987/dsh-channels',
  ]);
  const entries = [
    ...RELEASE_PACKAGE_NAMES.map((name) => {
      if (name === RELEASE_BUNDLE) {
        return entry(name, '0.9.0', {
          '@wsz987/channel-telegram': 'workspace:*',
          '@wsz987/channel-weixin': 'workspace:*',
        });
      }
      if (name === '@wsz987/channel-weixin') {
        return entry(name, '0.8.1', { '@wsz987/channel-core': 'workspace:*' });
      }
      if (name === '@wsz987/channel-telegram') {
        return entry(name, '0.1.0', {
          '@wsz987/channel-control': 'workspace:*',
          '@wsz987/channel-core': 'workspace:*',
        });
      }
      return entry(name, '0.1.0');
    }),
  ];
  const packages = releasePackages(entries);
  assert.equal(packages.length, RELEASE_PACKAGE_NAMES.length);
  assert.equal(packages.some(({ name }) => name === '@wsz987/channel-telegram'), true);
  assert.ok(
    packages.findIndex(({ name }) => name === '@wsz987/channel-telegram')
      < packages.findIndex(({ name }) => name === RELEASE_BUNDLE),
  );
  assert.ok(
    packages.findIndex(({ name }) => name === '@wsz987/channel-weixin')
      < packages.findIndex(({ name }) => name === RELEASE_BUNDLE),
  );
  assert.equal(bundleVersion(validateWorkspaceManifests(entries)), '0.9.0');
});

test('Changesets does not version private workspace packages', () => {
  const config = JSON.parse(readFileSync(new URL('../.changeset/config.json', import.meta.url), 'utf8'));
  assert.deepEqual(config.privatePackages, { version: false, tag: false });
});

test('release tag matches the independently versioned bundle', () => {
  assert.doesNotThrow(() => assertReleaseTag('tag', 'v0.9.0', '0.9.0'));
  assert.doesNotThrow(() => assertReleaseTag(undefined, undefined, '0.9.0'));
  assert.throws(() => assertReleaseTag('tag', 'v0.8.0', '0.9.0'), /expected v0\.9\.0/);
});

test('release allowlist rejects an omitted workspace dependency', () => {
  const entries = RELEASE_PACKAGE_NAMES.map((name) =>
    entry(
      name,
      name === RELEASE_BUNDLE ? '0.9.0' : '0.1.0',
      name === RELEASE_BUNDLE ? { '@wsz987/not-released': 'workspace:*' } : {},
    ),
  );
  entries.push(entry('@wsz987/not-released', '0.1.0'));
  assert.throws(() => releasePackages(entries), /depends on non-release workspace package/);
});

test('npm dist-tag follows the bundle release channel', () => {
  assert.equal(npmDistTag('0.10.0-beta.1', undefined), 'beta');
  assert.equal(npmDistTag('0.10.0', undefined), 'latest');
  assert.equal(npmDistTag('0.10.0', 'next'), 'next');
});

test('release version preparation distinguishes beta and stable versions', () => {
  assert.doesNotThrow(() => assertReleaseChannel('beta'));
  assert.doesNotThrow(() => assertReleaseChannel('stable'));
  assert.throws(() => assertReleaseChannel('next'), /beta\|stable/);

  assert.doesNotThrow(() => assertVersionMatchesChannel('0.5.0-beta.0', 'beta'));
  assert.doesNotThrow(() => assertVersionMatchesChannel('0.5.0', 'stable'));
  assert.throws(() => assertVersionMatchesChannel('0.5.0', 'beta'), /beta prerelease/);
  assert.throws(() => assertVersionMatchesChannel('0.5.0-beta.0', 'stable'), /stable version/);
});

test('release version preparation accepts pnpm arguments with or without a separator', () => {
  assert.equal(releaseChannelFromArgs(['beta']), 'beta');
  assert.equal(releaseChannelFromArgs(['--', 'stable']), 'stable');
  assert.equal(releaseChannelFromArgs([]), undefined);
  assert.equal(releaseChannelFromArgs(['beta', 'stable']), undefined);
});

test('release version preparation keeps the private root version aligned with the bundle', () => {
  const manifest = { name: 'dsh-channels', version: '0.4.2', private: true };
  assert.equal(syncRootVersion(manifest, '0.5.0-beta.0'), true);
  assert.equal(manifest.version, '0.5.0-beta.0');
  assert.equal(syncRootVersion(manifest, '0.5.0-beta.0'), false);
});

test('workspace verification rejects invalid public metadata', () => {
  const entries = RELEASE_PACKAGE_NAMES.map((name) => entry(name, name === RELEASE_BUNDLE ? '0.9.0' : '0.1.0'));
  assert.doesNotThrow(() => validateWorkspaceManifests(entries));
  entries[0].manifest.repository.url = 'https://github.com/wsz987/dsh-channels.git';
  assert.throws(() => validateWorkspaceManifests(entries), /repository\.url/);
});

test('packed manifests reject workspace ranges and wrong versions', () => {
  const expected = { name: '@wsz987/core', version: '0.3.0' };
  const valid = {
    ...expected,
    repository: { url: RELEASE_REPOSITORY },
    dependencies: { dependency: '1.0.0' },
  };
  assert.doesNotThrow(() => assertPackedManifest(valid, expected));
  assert.throws(() => assertPackedManifest({ ...valid, version: '0.4.0' }, expected), /version/);
  assert.throws(
    () => assertPackedManifest({ ...valid, dependencies: { dependency: 'workspace:*' } }, expected),
    /workspace range/,
  );
});

test('registry version lookup only publishes missing versions', () => {
  assert.equal(classifyRegistryVersion({ status: 0, stdout: '"0.3.0"\n', stderr: '' }, '0.3.0'), 'published');
  assert.equal(classifyRegistryVersion({ status: 1, stdout: '', stderr: 'npm error code E404' }, '0.3.0'), 'missing');
  assert.throws(
    () => classifyRegistryVersion({ status: 1, stdout: '', stderr: 'npm error code E500' }, '0.3.0'),
    /npm view failed/,
  );
});
