import { resolve } from 'node:path';

import {
  assertReleaseTag,
  bundleVersion,
  readWorkspaceManifests,
  validateWorkspaceManifests,
} from './release-family.mjs';

const root = resolve(import.meta.dirname, '..');
const packages = validateWorkspaceManifests(readWorkspaceManifests(root));
const version = bundleVersion(packages);
assertReleaseTag(process.env.GITHUB_REF_TYPE, process.env.GITHUB_REF_NAME, version);
console.log(`release verify: bundle ${version}, ${packages.length} public packages`);
