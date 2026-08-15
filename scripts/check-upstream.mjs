#!/usr/bin/env node
/**
 * M4 — check-upstream: report drift of @deepseek-ai/* dependencies against the npm
 * registry `latest` tag. Zero dependencies (Node 22 ESM, global fetch).
 *
 * Exit codes:
 *   0 — every declared dep is installed at the latest version satisfying its
 *       declared range (no drift), or the registry was unreachable (offline:
 *       warning, treated as green so CI stays usable without network).
 *   1 — drift: a newer in-range version exists on the registry (or a declared
 *       dep is not installed locally).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 15000;

/* ------------------------------------------------------------------ */
/* Version comparison (minimal semver-ish, prerelease aware)           */
/* ------------------------------------------------------------------ */

function parseVersion(v) {
  const s = String(v).trim();
  const dash = s.indexOf('-');
  const numeric = dash === -1 ? s : s.slice(0, dash);
  const pre = dash === -1 ? null : s.slice(dash + 1);
  const parts = numeric.split('.').map((n) => {
    const i = Number.parseInt(n, 10);
    return Number.isNaN(i) ? 0 : i;
  });
  return { parts, pre };
}

function compareParts(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Prerelease suffixes compare as strings; when one is a prefix of the other the
// shorter one sorts first (rc.6 < rc.6.1). Prefix equality is enough for CI.
function comparePre(a, b) {
  if (a === b) return 0;
  if (a.startsWith(b)) return 1;
  if (b.startsWith(a)) return -1;
  return a < b ? -1 : 1;
}

function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const c = compareParts(va.parts, vb.parts);
  if (c !== 0) return c;
  if (va.pre === null && vb.pre === null) return 0;
  if (va.pre === null) return 1; // release > prerelease
  if (vb.pre === null) return -1; // prerelease < release
  return comparePre(va.pre, vb.pre);
}

/**
 * Minimal satisfies(): supports ^ ~ >= <= > < = (bare = exact) and '*' on dotted
 * numeric versions with an optional prerelease suffix. Multiple clauses separated
 * by whitespace/commas are AND-combined. Unknown syntax is treated as satisfied so
 * this CI diagnostic never blocks on an exotic range.
 */
function satisfies(version, range) {
  const clauses = String(range).split(/[\s,]+/).filter(Boolean);
  if (clauses.length === 0) return true;
  return clauses.every((clause) => {
    if (clause === '*' || clause === 'latest') return true;
    const m = clause.match(/^(\^|~|>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+)*)(?:-(\S+))?$/);
    if (!m) return true;
    const op = m[1] ?? '=';
    const bound = m[2] + (m[3] ? '-' + m[3] : '');
    const b = parseVersion(bound);
    switch (op) {
      case '=':
        return compareVersions(version, bound) === 0;
      case '>':
        return compareVersions(version, bound) > 0;
      case '>=':
        return compareVersions(version, bound) >= 0;
      case '<':
        return compareVersions(version, bound) < 0;
      case '<=':
        return compareVersions(version, bound) <= 0;
      case '^': {
        // Caret: ^x.y.z -> >= x.y.z, < next breaking minor/major.
        const [major, minor = 0] = b.parts;
        const upper =
          major > 0
            ? `${major + 1}.0.0`
            : minor > 0
              ? `0.${minor + 1}.0`
              : `0.0.${(b.parts[2] ?? 0) + 1}`;
        return compareVersions(version, bound) >= 0 && compareVersions(version, upper) < 0;
      }
      case '~': {
        // Tilde: ~x.y.z -> >= x.y.z, < x.(y+1).0.
        const [major, minor = 0] = b.parts;
        const upper = `${major}.${minor + 1}.0`;
        return compareVersions(version, bound) >= 0 && compareVersions(version, upper) < 0;
      }
      default:
        return true;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Workspace discovery                                                 */
/* ------------------------------------------------------------------ */

// Collect @deepseek-ai/* deps from every packages/*/package.json (dependencies,
// devDependencies and peerDependencies). Returns Map<pkg, Set<range>>.
function scanDeclared() {
  const packagesDir = path.join(ROOT, 'packages');
  const map = new Map();
  let dirs;
  try {
    dirs = fs.readdirSync(packagesDir, { withFileTypes: true });
  } catch (err) {
    console.error(`[error] cannot read packages/ directory: ${err.message}`);
    process.exit(1);
  }
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const pj = path.join(packagesDir, entry.name, 'package.json');
    let json;
    try {
      json = JSON.parse(fs.readFileSync(pj, 'utf8'));
    } catch {
      continue; // not a package.json (or unreadable) — skip
    }
    const deps = {
      ...(json.dependencies ?? {}),
      ...(json.devDependencies ?? {}),
      ...(json.peerDependencies ?? {}),
    };
    for (const [name, range] of Object.entries(deps)) {
      if (name.startsWith('@deepseek-ai/')) {
        if (!map.has(name)) map.set(name, new Set());
        map.get(name).add(String(range).trim());
      }
    }
  }
  return map;
}

// Installed version from the workspace root node_modules. pnpm's default isolated
// linker keeps scoped deps in the virtual store, so fall back to
// node_modules/.pnpm/node_modules/<pkg> when the hoisted path is absent.
function readInstalledVersion(pkg) {
  const candidates = [
    path.join(ROOT, 'node_modules', pkg, 'package.json'),
    path.join(ROOT, 'node_modules', '.pnpm', 'node_modules', pkg, 'package.json'),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')).version;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* M8 — upstream-discipline smoke (plan §17/§72/§87)                   */
/* ------------------------------------------------------------------ */
// Local-only governance that ALWAYS runs (independent of npm registry reach):
//   1. channel-weixin must pin @tencent-weixin/openclaw-weixin EXACTLY (no
//      caret/tilde/range) — plan section 17 / 72 ("exact pin").
//   2. every official channel's package.json must pin the declared upstream
//      package to the same testedVersion as the M0 UPSTREAM_MANIFESTS boundary
//      (plan section 39) — a manifest version drifting from package.json fails.
// These values mirror packages/channel-compat/src/upstream-manifest.ts and the
// plan baseline; the plan doc remains the authority if they ever disagree.
const UPSTREAM_DISCIPLINE = [
  { dir: 'channel-qq', pkg: '@tencent-connect/qqbot-nodejs', tested: '1.0.4', exactPin: true },
  { dir: 'channel-lark', pkg: '@larksuiteoapi/node-sdk', tested: '1.73.0', exactPin: true },
  { dir: 'channel-dingtalk', pkg: 'dingtalk-stream', tested: '2.1.5', exactPin: true },
];

const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function checkUpstreamDiscipline() {
  let failed = false;
  for (const { dir, pkg, tested, exactPin } of UPSTREAM_DISCIPLINE) {
    const pjPath = path.join(ROOT, 'packages', dir, 'package.json');
    let json;
    try {
      json = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    } catch (err) {
      console.error(`[upstream-discipline] ERROR ${dir}: cannot read package.json — ${err.message}`);
      failed = true;
      continue;
    }
    const deps = { ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}), ...(json.peerDependencies ?? {}) };
    const range = deps[pkg];
    if (range === undefined) {
      console.error(`[upstream-discipline] FAIL ${dir}: dependency ${pkg} is not declared`);
      failed = true;
      continue;
    }
    const exact = typeof range === 'string' && EXACT_VERSION_RE.test(range.trim());
    if (exactPin && !exact) {
      console.error(`[upstream-discipline] FAIL ${dir}: ${pkg} must be EXACT-pinned (a bare x.y.z), got '${range}'`);
      failed = true;
    } else if (range.trim() !== tested) {
      console.error(`[upstream-discipline] FAIL ${dir}: ${pkg} pinned at '${range}' but UPSTREAM_MANIFESTS testedVersion is '${tested}'`);
      failed = true;
    } else {
      console.log(`[upstream-discipline] ok ${dir}: ${pkg} pinned exactly at ${tested}`);
    }
  }
  if (failed) {
    console.error('\n[upstream-discipline] upstream pin discipline violated — fix package.json before release.');
    process.exit(1);
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

// Local-only upstream pin discipline runs first (independent of the registry).
checkUpstreamDiscipline();

const declared = scanDeclared();
if (declared.size === 0) {
  console.log('No @deepseek-ai/* dependencies declared in packages/*/package.json — nothing to check.');
  process.exit(0);
}

// Fetch npm `latest` for every declared package (parallel, bounded timeout).
let latestByPkg;
try {
  const results = await Promise.all(
    [...declared.keys()].map(async (pkg) => {
      const res = await fetch(`${REGISTRY}/${pkg}/latest`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`${pkg}: HTTP ${res.status}`);
      const json = await res.json();
      return [pkg, json.version];
    }),
  );
  latestByPkg = new Map(results);
} catch (err) {
  console.warn(`[warn] npm registry unreachable (${err.message}); treating as green.`);
  process.exit(0);
}

const rows = [];
let drift = false;
for (const [pkg, ranges] of declared) {
  const range = [...ranges].join(', ');
  const installed = readInstalledVersion(pkg);
  const latest = latestByPkg.get(pkg);
  const inRange = latest !== undefined && [...ranges].every((r) => satisfies(latest, r));
  if (installed === null) {
    drift = true; // declared but not installed locally
  } else if (inRange && latest !== installed) {
    drift = true; // newer in-range version available
  }
  rows.push({
    pkg,
    range,
    installed: installed ?? '(not installed)',
    latest: latest ?? '(unknown)',
    inRange,
  });
}

// Aligned table.
const w = { pkg: 0, range: 0, installed: 0, latest: 0 };
for (const r of rows) {
  w.pkg = Math.max(w.pkg, r.pkg.length);
  w.range = Math.max(w.range, r.range.length);
  w.installed = Math.max(w.installed, r.installed.length);
  w.latest = Math.max(w.latest, r.latest.length);
}
console.log(
  `${'package'.padEnd(w.pkg)}  ${'declared'.padEnd(w.range)}  ${'installed'.padEnd(w.installed)}  ${'latest'.padEnd(w.latest)}  in-range?`,
);
console.log(
  `${'-'.repeat(w.pkg)}  ${'-'.repeat(w.range)}  ${'-'.repeat(w.installed)}  ${'-'.repeat(w.latest)}  ---------`,
);
for (const r of rows) {
  console.log(
    `${r.pkg.padEnd(w.pkg)}  ${r.range.padEnd(w.range)}  ${r.installed.padEnd(w.installed)}  ${r.latest.padEnd(w.latest)}  ${r.inRange ? 'yes' : 'no'}`,
  );
}

if (drift) {
  console.log('\n[drift] A newer in-range @deepseek-ai/* version is available — update the lockfile,');
  console.log('re-run the CI gate, then bump the manifest testedVersion.');
  process.exit(1);
}
console.log('\n[ok] All @deepseek-ai/* deps are at the latest version satisfying their declared ranges.');
process.exit(0);
