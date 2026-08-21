#!/usr/bin/env node
/**
 * check-upstream — upstream dependency governance for dsh-channels.
 * Zero dependencies (Node 22 ESM, global fetch).
 *
 * Three layers:
 *
 *   1. Channel upstream pin discipline (local-only, always runs in blocking
 *      modes): official channel SDK pins must match the manifest
 *      testedVersion boundary (see UPSTREAM_DISCIPLINE below).
 *
 *   2. Harness baseline compatibility (blocking) for the `@deepseek-ai/dsh-*`
 *      family. The single source of truth is HARNESS_TESTED_VERSION below —
 *      NOT the npm `latest` dist-tag. Harness is in Developer Preview and
 *      its `latest` tag has been observed stuck on an old prerelease wave
 *      (e.g. latest=0.1.0-rc.6 while 0.1.1-rc.2 lived under `next`), so
 *      "npm latest" is not a compatibility truth for this family
 *      ("supported baseline ≠ npm latest", upgrade plan §15).
 *
 *      Blocking rules for every dsh-* package declared in packages/*:
 *        a) the registry must publish HARNESS_TESTED_VERSION for it
 *           (a missing version means the baseline is misconfigured);
 *        b) every dependencies / devDependencies / peerDependencies entry
 *           must be exactly HARNESS_TESTED_VERSION — rc.7 residue, other
 *           versions or any range syntax fail;
 *        c) peerDependencies carry no `^` / `~` / ranges at all: the tested
 *           compatibility band principle (plan §16 / AGENTS.md red line 6)
 *           is that an unverified prerelease must never be claimed as
 *           compatible. When a newer Harness release passes the
 *           compatibility suite, widen the explicit OR list
 *           (`"0.1.1-rc.2 || 0.1.1-rc.3"`), never a caret.
 *
 *      Baseline upgrade flow (AGENTS.md red line 6): Renovate PR →
 *      typecheck → contract tests → payload fixtures → adapter tests →
 *      update HARNESS_TESTED_VERSION here together with the workspace pins.
 *
 *   3. Non-dsh `@deepseek-ai/*` drift (cordis / schemastery — mature,
 *      stable dependencies): unchanged report against the npm `latest` tag.
 *
 * Modes:
 *   (default)         all layers, blocking (`pnpm check:upstream`)
 *   --harness-compat  layers 2 only, blocking (`pnpm check:harness-compat`)
 *   --harness-newer   informational only (`pnpm check:harness-newer`):
 *                     reports dsh-* versions published above
 *                     HARNESS_TESTED_VERSION ("released, not yet verified")
 *                     by scanning every registry version and dist-tag. This
 *                     is a hint to start the upgrade flow, never a gate.
 *
 * Exit codes:
 *   Blocking modes (default / --harness-compat):
 *     0 — every gate is green, or the npm registry was unreachable
 *         (offline: warning, treated as green so CI stays usable without
 *         network).
 *     1 — a gate failed: channel SDK pin discipline violated, Harness
 *         baseline misaligned (missing registry version / rc residue /
 *         ranged peer), or a newer in-range non-dsh @deepseek-ai/* version
 *         exists on the registry (or a declared dep is not installed).
 *   --harness-newer: always 0 (offline: warning, exit 0).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 15000;

// Single source of truth for the tested DeepSeek Harness baseline.
// Upgrade flow: Renovate → typecheck → contract → fixtures → update this
// value together with every workspace dsh-* pin (AGENTS.md red line 6).
const HARNESS_TESTED_VERSION = '0.1.1-rc.2';
const HARNESS_PKG_PREFIX = '@deepseek-ai/dsh-';

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const MODE = argv.includes('--harness-newer')
  ? 'newer'
  : argv.includes('--harness-compat')
    ? 'harness-compat'
    : 'all';

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

// Collect @deepseek-ai/* deps from every packages/*/package.json. Returns
// Map<pkg, Array<{ dir, section, range }>> preserving where each range is
// declared (section is 'dependencies' | 'devDependencies' | 'peerDependencies').
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
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(json[section] ?? {})) {
        if (!name.startsWith('@deepseek-ai/')) continue;
        if (!map.has(name)) map.set(name, []);
        map.get(name).push({ dir: entry.name, section, range: String(range).trim() });
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
/* npm registry                                                        */
/* ------------------------------------------------------------------ */

// Fetch the full packument (all versions + dist-tags) for every package in
// `names`, in parallel with a bounded timeout. Throws on the first failure so
// callers can apply the shared offline tolerance in one place.
async function fetchPackuments(names) {
  const entries = await Promise.all(
    names.map(async (pkg) => {
      const res = await fetch(`${REGISTRY}/${pkg}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`${pkg}: HTTP ${res.status}`);
      const json = await res.json();
      return [pkg, json];
    }),
  );
  return new Map(entries);
}

// Fetch npm `latest` for every package in `names` (parallel, bounded timeout).
async function fetchLatestTags(names) {
  const entries = await Promise.all(
    names.map(async (pkg) => {
      const res = await fetch(`${REGISTRY}/${pkg}/latest`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`${pkg}: HTTP ${res.status}`);
      const json = await res.json();
      return [pkg, json.version];
    }),
  );
  return new Map(entries);
}

function offlineExit(mode) {
  if (mode === 'newer') {
    console.warn(
      `[warn] npm registry unreachable; skipping the harness-newer report (informational, exit 0).`,
    );
    process.exit(0);
  }
  console.warn(`[warn] npm registry unreachable; treating as green.`);
  process.exit(0);
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
/* Harness baseline compatibility (blocking, plan §15/§16/§21 P0-8)    */
/* ------------------------------------------------------------------ */

function checkHarnessCompat(declared, packuments) {
  let failed = false;
  const rows = [];
  for (const [pkg, decls] of declared) {
    if (!pkg.startsWith(HARNESS_PKG_PREFIX)) continue;
    const doc = packuments.get(pkg);
    const versions = doc ? Object.keys(doc.versions ?? {}) : [];
    const hasBaseline = versions.includes(HARNESS_TESTED_VERSION);
    if (!hasBaseline) {
      console.error(
        `[harness-compat] FAIL ${pkg}: the registry does not publish ${HARNESS_TESTED_VERSION} ` +
          `(versions: ${versions.join(', ') || 'none'}) — HARNESS_TESTED_VERSION is misconfigured ` +
          `or the package name drifted.`,
      );
      failed = true;
    }
    for (const { dir, section, range } of decls) {
      if (range !== HARNESS_TESTED_VERSION) {
        const peerNote =
          section === 'peerDependencies'
            ? ' Peer declarations must be the EXACT tested version (no ^ / ~ / range) — tested compatibility band, plan §16.'
            : '';
        console.error(
          `[harness-compat] FAIL packages/${dir}/package.json ${section}: ${pkg} is '${range}' ` +
            `but the tested baseline is exactly '${HARNESS_TESTED_VERSION}' ` +
            `(rc residue / mismatched version / range syntax are all rejected).${peerNote}`,
        );
        failed = true;
      }
    }
    const ranges = [...new Set(decls.map((d) => d.range))];
    rows.push({ pkg, declared: ranges.join(' | '), hasBaseline: hasBaseline ? 'yes' : 'NO' });
  }
  if (rows.length === 0) return false;

  console.log(`\nHarness baseline: ${HARNESS_TESTED_VERSION} (supported baseline ≠ npm latest; plan §15/§16).`);
  const w = { pkg: 0, declared: 0 };
  for (const r of rows) {
    w.pkg = Math.max(w.pkg, r.pkg.length);
    w.declared = Math.max(w.declared, r.declared.length);
  }
  console.log(`${'package'.padEnd(w.pkg)}  ${'declared'.padEnd(w.declared)}  registry has baseline`);
  console.log(`${'-'.repeat(w.pkg)}  ${'-'.repeat(w.declared)}  -------------------`);
  for (const r of rows) {
    console.log(`${r.pkg.padEnd(w.pkg)}  ${r.declared.padEnd(w.declared)}  ${r.hasBaseline}`);
  }
  return failed;
}

/* ------------------------------------------------------------------ */
/* harness-newer (informational, always exit 0)                        */
/* ------------------------------------------------------------------ */

function reportHarnessNewer(declared, packuments) {
  let newerCount = 0;
  for (const [pkg] of declared) {
    if (!pkg.startsWith(HARNESS_PKG_PREFIX)) continue;
    const doc = packuments.get(pkg);
    const versions = doc ? Object.keys(doc.versions ?? {}) : [];
    const distTags = doc?.['dist-tags'] ?? {};
    const tagFor = (v) =>
      Object.entries(distTags)
        .filter(([, tag]) => tag === v)
        .map(([tag]) => tag)
        .join('/');
    const newer = versions.filter((v) => compareVersions(v, HARNESS_TESTED_VERSION) > 0).sort(compareVersions);
    for (const v of newer) {
      const tag = tagFor(v);
      newerCount += 1;
      console.log(
        `[harness-newer] ${pkg}@${v} 已发布，尚未验证${tag ? ` (dist-tag: ${tag})` : ''} — tested baseline is ${HARNESS_TESTED_VERSION}.`,
      );
    }
  }
  if (newerCount === 0) {
    console.log(`\n[harness-newer] No published @deepseek-ai/dsh-* version is newer than ${HARNESS_TESTED_VERSION}.`);
  } else {
    console.log(
      `\n[harness-newer] ${newerCount} published version(s) above the tested baseline were found — informational only.\n` +
        `A newer prerelease is NOT automatically compatible. Before raising the baseline run the\n` +
        `compatibility suite: Renovate PR → typecheck → contract → fixtures → adapter tests, then bump\n` +
        `HARNESS_TESTED_VERSION and every workspace dsh-* pin together (AGENTS.md red line 6).`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Non-dsh @deepseek-ai/* latest-drift report (mature deps, unchanged) */
/* ------------------------------------------------------------------ */

function reportNonDshDrift(declared, latestByPkg) {
  const rows = [];
  let drift = false;
  for (const [pkg, decls] of declared) {
    if (pkg.startsWith(HARNESS_PKG_PREFIX)) continue;
    const ranges = [...new Set(decls.map((d) => d.range))];
    const range = ranges.join(', ');
    const installed = readInstalledVersion(pkg);
    const latest = latestByPkg.get(pkg);
    const inRange = latest !== undefined && ranges.every((r) => satisfies(latest, r));
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
  if (rows.length === 0) return false;

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
  return drift;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

// Local-only upstream pin discipline runs first (independent of the registry).
if (MODE !== 'newer') {
  checkUpstreamDiscipline();
}

const declared = scanDeclared();
if (declared.size === 0) {
  console.log('No @deepseek-ai/* dependencies declared in packages/*/package.json — nothing to check.');
  process.exit(0);
}

const harnessPkgs = [...declared.keys()].filter((pkg) => pkg.startsWith(HARNESS_PKG_PREFIX));
const otherPkgs = [...declared.keys()].filter((pkg) => !pkg.startsWith(HARNESS_PKG_PREFIX));

// Informational mode: only the newer-than-baseline report, always exit 0.
if (MODE === 'newer') {
  let packuments;
  try {
    packuments = await fetchPackuments(harnessPkgs);
  } catch (err) {
    offlineExit('newer');
  }
  reportHarnessNewer(declared, packuments);
  process.exit(0);
}

// Blocking modes: the dsh-* family needs full packuments (baseline existence +
// informational newer note); non-dsh packages only need the `latest` tag.
let packuments = new Map();
let latestByPkg = new Map();
try {
  if (harnessPkgs.length > 0) {
    packuments = await fetchPackuments(harnessPkgs);
  }
  if (MODE === 'all' && otherPkgs.length > 0) {
    latestByPkg = await fetchLatestTags(otherPkgs);
  }
} catch (err) {
  offlineExit(MODE);
}

let failed = false;

// Layer 2 — Harness baseline compatibility (blocking).
failed = checkHarnessCompat(declared, packuments) || failed;

// Layer 3 — non-dsh latest-drift report (mature deps, blocking on drift).
// Only in the full mode: --harness-compat is scoped to the dsh-* baseline.
if (MODE === 'all') {
  const drift = reportNonDshDrift(declared, latestByPkg);
  if (drift) {
    console.log('\n[drift] A newer in-range @deepseek-ai/* version is available — update the lockfile,');
    console.log('re-run the CI gate, then bump the manifest testedVersion.');
    failed = true;
  }
}

// Informational footer (never blocks): newer-than-baseline dsh-* versions.
if (harnessPkgs.length > 0) {
  reportHarnessNewer(declared, packuments);
}

if (failed) {
  console.error('\n[check-upstream] gate failed — see the FAIL / drift lines above.');
  process.exit(1);
}
console.log(
  `\n[ok] All @deepseek-ai/dsh-* deps are exactly ${HARNESS_TESTED_VERSION} and the registry publishes that baseline.` +
    (MODE === 'all' ? ' Non-dsh @deepseek-ai/* deps are at the latest in-range version.' : ''),
);
process.exit(0);
