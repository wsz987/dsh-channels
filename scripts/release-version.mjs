import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT_MANIFEST = new URL('../package.json', import.meta.url);
const BUNDLE_MANIFEST = new URL('../packages/channels/package.json', import.meta.url);
const PRE_STATE = new URL('../.changeset/pre.json', import.meta.url);

export function assertReleaseChannel(channel) {
  if (channel !== 'beta' && channel !== 'stable') {
    throw new Error('usage: pnpm release:version -- <beta|stable>');
  }
}

export function assertVersionMatchesChannel(version, channel) {
  const isBeta = /^\d+\.\d+\.\d+-beta\.\d+$/.test(version);
  const isStable = /^\d+\.\d+\.\d+$/.test(version);
  if (channel === 'beta' && !isBeta) {
    throw new Error(`Changesets produced ${version}; expected a beta prerelease`);
  }
  if (channel === 'stable' && !isStable) {
    throw new Error(`Changesets produced ${version}; expected a stable version`);
  }
}

export function syncRootVersion(rootManifest, version) {
  if (rootManifest.version === version) return false;
  rootManifest.version = version;
  return true;
}

export function releaseChannelFromArgs(args) {
  const values = args[0] === '--' ? args.slice(1) : args;
  if (values.length !== 1) return undefined;
  return values[0];
}

function readJson(url) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

function runChangeset(args) {
  const pnpmEntry = process.env.npm_execpath;
  if (!pnpmEntry) {
    throw new Error('release versioning must be run through the pnpm script');
  }
  const result = spawnSync(process.execPath, [pnpmEntry, 'exec', 'changeset', ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`changeset ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

export function prepareReleaseVersion(channel) {
  assertReleaseChannel(channel);

  if (channel === 'beta') {
    if (!existsSync(PRE_STATE)) {
      runChangeset(['pre', 'enter', 'beta']);
    } else {
      const preState = readJson(PRE_STATE);
      if (preState.mode !== 'pre' || preState.tag !== 'beta') {
        throw new Error(`existing Changesets prerelease mode is ${preState.mode}:${preState.tag}, expected pre:beta`);
      }
    }
  } else if (existsSync(PRE_STATE)) {
    runChangeset(['pre', 'exit']);
  }

  runChangeset(['version']);

  const bundleManifest = readJson(BUNDLE_MANIFEST);
  assertVersionMatchesChannel(bundleManifest.version, channel);

  const rootManifest = readJson(ROOT_MANIFEST);
  if (syncRootVersion(rootManifest, bundleManifest.version)) {
    writeFileSync(ROOT_MANIFEST, `${JSON.stringify(rootManifest, null, 2)}\n`);
  }

  console.log(`release version: ${bundleManifest.version}`);
  console.log(`release tag: v${bundleManifest.version}`);
  return bundleManifest.version;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    prepareReleaseVersion(releaseChannelFromArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
