/**
 * `verifyAdapter` — the Task 17.3 verify surface (`dsh channels verify`).
 *
 * Runs a battery of offline checks against an adapter directory and produces
 * a structured `VerifyReport`. Checks run in order and each produces items
 * with a severity:
 *
 * - `ok`      — the check passed
 * - `warning` — the check noticed something that does not fail the adapter
 *               (e.g. no compatibility manifest, no fixtures, credentials
 *               placeholder, untested upstream state)
 * - `fail`    — the check found a real problem; any fail fails the run
 *
 * Checks: package, adapter-surface, manifest, capabilities, fixtures,
 * credentials, contract. Everything runs locally (no network), so the CLI is
 * CI-friendly and offline.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getAdapterManifest,
  manifestVerdict,
  validateManifest,
  versionState,
} from '@dsh/channel-compat';
import { resolveFixturesDir, validateFixture } from '@dsh/channel-testkit/fixture-loader';
import type { ChannelAdapter } from '@dsh/channel-core';

export type VerifySeverity = 'ok' | 'warning' | 'fail';

/** One line of a check result. */
export interface VerifyItem {
  severity: VerifySeverity;
  /** Stable machine-readable code, e.g. `package.json-invalid`. */
  code: string;
  /** Human-readable message. Values of matched secrets are never included. */
  message: string;
}

/** The result of one named check. */
export interface VerifyCheck {
  /** Stable check id: package | adapter-surface | manifest | capabilities | fixtures | credentials | contract. */
  id: string;
  items: VerifyItem[];
}

export interface VerifySummary {
  ok: number;
  warning: number;
  fail: number;
}

export interface VerifyReport {
  /** Resolved absolute path of the verified directory. */
  dir: string;
  checks: VerifyCheck[];
  summary: VerifySummary;
  /** true when there are no `fail` items (warnings do not fail). */
  passed: boolean;
}

export interface VerifyOptions {
  /** Run the adapter's own test suite (`pnpm test`) as the contract check. */
  test?: boolean;
  /** Treat an `unsupported` compatibility state as a warning instead of a failure. */
  allowUnsupported?: boolean;
  /**
   * Internal/testing hook: replace the `pnpm test` spawn with a fake runner
   * returning the process exit code (or `null` when spawning failed).
   */
  runTests?: (dir: string) => Promise<number | null>;
}

const CAPABILITY_FLAGS = [
  'text',
  'image',
  'file',
  'audio',
  'video',
  'markdown',
  'cards',
  'reactions',
  'threads',
] as const;

const STREAMING_MODES = ['native', 'edit', 'buffered'] as const;

/** Structural adapter shape the verifier accepts (class or object form). */
interface AdapterShape {
  id: string;
  capabilities: unknown;
  start: unknown;
  stop: unknown;
  send: unknown;
}

function ok(code: string, message: string): VerifyItem {
  return { severity: 'ok', code, message };
}

function warn(code: string, message: string): VerifyItem {
  return { severity: 'warning', code, message };
}

function fail(code: string, message: string): VerifyItem {
  return { severity: 'fail', code, message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A parsed package.json plus the absolute path it was read from. */
interface PackageInfo {
  record: Record<string, unknown>;
  path: string;
}

/**
 * Verify one adapter directory.
 *
 * @param dir Path to the adapter package directory (relative paths are
 *            resolved against the caller's working directory).
 * @param opts Check options (see `VerifyOptions`).
 */
export async function verifyAdapter(dir: string, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const absDir = resolve(dir);
  const checks: VerifyCheck[] = [];

  // 1. package
  const pkg = await readPackage(absDir);
  checks.push(pkg.check);

  // 2. adapter surface
  const surface = await inspectAdapterSurface(absDir, pkg.info);
  checks.push(surface.check);
  const adapter = surface.adapter;

  // 3. manifest
  checks.push(checkManifest(adapter, opts));

  // 4. capabilities
  checks.push(checkCapabilities(adapter));

  // 5. fixtures
  checks.push(await checkFixtures(absDir, adapter?.id));

  // 6. credentials
  checks.push(await checkCredentials(absDir));

  // 7. contract
  checks.push(await checkContract(absDir, opts));

  const items = checks.flatMap((check) => check.items);
  const summary: VerifySummary = {
    ok: items.filter((item) => item.severity === 'ok').length,
    warning: items.filter((item) => item.severity === 'warning').length,
    fail: items.filter((item) => item.severity === 'fail').length,
  };
  return { dir: absDir, checks, summary, passed: summary.fail === 0 };
}

// ---------------------------------------------------------------------------
// Check: package
// ---------------------------------------------------------------------------

async function readPackage(dir: string): Promise<{ check: VerifyCheck; info: PackageInfo | undefined }> {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) {
    return {
      check: { id: 'package', items: [fail('package.json-missing', 'package.json not found in the adapter directory')] },
      info: undefined,
    };
  }
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(pkgPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('expected a JSON object');
    }
    record = parsed as Record<string, unknown>;
  } catch (error) {
    return {
      check: { id: 'package', items: [fail('package.json-invalid', `package.json is not valid JSON: ${errorMessage(error)}`)] },
      info: undefined,
    };
  }

  const items: VerifyItem[] = [];
  const push = (predicate: boolean, code: string, message: string): void => {
    if (!predicate) items.push(fail(code, message));
  };
  push(typeof record.name === 'string' && record.name.length > 0, 'package-name-missing', 'package.json name must be a non-empty string');
  push(typeof record.version === 'string' && record.version.length > 0, 'package-version-missing', 'package.json version must be a non-empty string');
  push(typeof record.main === 'string' && record.main.length > 0, 'package-main-missing', 'package.json main entry is missing');
  push(typeof record.types === 'string' && record.types.length > 0, 'package-types-missing', 'package.json types entry is missing');
  push(typeof record.exports === 'object' && record.exports !== null, 'package-exports-missing', 'package.json exports map is missing');

  // dsh.bundle.patch: when declared, the referenced patch file must exist.
  const dsh = record.dsh as Record<string, unknown> | undefined;
  const bundle = dsh && typeof dsh === 'object' ? (dsh.bundle as Record<string, unknown> | undefined) : undefined;
  const patch = bundle && typeof bundle === 'object' ? bundle.patch : undefined;
  if (typeof patch === 'string') {
    if (patch.length === 0) {
      items.push(fail('package-patch-invalid', 'dsh.bundle.patch must be a non-empty path'));
    } else if (!existsSync(resolve(dir, patch))) {
      items.push(fail('package-patch-missing', `dsh.bundle.patch references '${patch}' but the file does not exist`));
    }
  }

  if (items.length === 0) {
    items.push(ok('package-ok', `package.json valid: ${record.name}@${record.version}`));
  }
  return { check: { id: 'package', items }, info: { record, path: pkgPath } };
}

// ---------------------------------------------------------------------------
// Check: adapter surface
// ---------------------------------------------------------------------------

interface AdapterSurfaceResult {
  check: VerifyCheck;
  adapter: AdapterShape | undefined;
}

async function inspectAdapterSurface(dir: string, pkg: PackageInfo | undefined): Promise<AdapterSurfaceResult> {
  const items: VerifyItem[] = [];
  const entry = resolveEntryPoint(dir, pkg);
  if (!entry) {
    return {
      check: {
        id: 'adapter-surface',
        items: [
          fail(
            'adapter-entry-missing',
            'could not resolve the package entry (exports["."].default or main; also tried lib/index.js and src/index.ts)',
          ),
        ],
      },
      adapter: undefined,
    };
  }
  if (!existsSync(entry)) {
    return {
      check: {
        id: 'adapter-surface',
        items: [fail('adapter-entry-missing', `declared entry '${relative(dir, entry)}' does not exist`)],
      },
      adapter: undefined,
    };
  }

  let mod: Record<string, unknown>;
  try {
    const imported = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
    mod = imported;
  } catch (error) {
    return {
      check: {
        id: 'adapter-surface',
        items: [fail('adapter-import-failed', `could not import '${relative(dir, entry)}': ${errorMessage(error)}`)],
      },
      adapter: undefined,
    };
  }

  const found = findAdapter(mod);
  if (!found) {
    return {
      check: {
        id: 'adapter-surface',
        items: [
          fail(
            'adapter-not-found',
            'no exported adapter found: expected a class instance-able without args or a defineChannelAdapter object exposing id, capabilities, start, stop and send',
          ),
        ],
      },
      adapter: undefined,
    };
  }
  items.push(ok('adapter-found', `found adapter '${found.adapter.id}' (exported as '${found.exportedName}')`));
  return { check: { id: 'adapter-surface', items }, adapter: found.adapter };
}

/**
 * Resolve the package entry file: exports["."].default → main →
 * lib/index.js → src/index.ts (best-effort fallbacks when the built output
 * is missing).
 */
function resolveEntryPoint(dir: string, pkg: PackageInfo | undefined): string | undefined {
  if (pkg) {
    const exports = pkg.record.exports as Record<string, unknown> | undefined;
    const dot = exports && typeof exports === 'object' ? (exports['.'] as Record<string, unknown> | undefined) : undefined;
    const candidates: unknown[] = [];
    // The runtime entry is the .default (or main); .types is a declaration
    // file and cannot be imported. The fallback loop below covers a missing
    // lib/ by trying src/index.ts.
    if (dot && typeof dot === 'object') candidates.push(dot.default);
    candidates.push(pkg.record.main);
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate.length === 0) continue;
      const abs = resolve(dir, candidate);
      if (existsSync(abs)) return abs;
    }
  }
  for (const candidate of ['lib/index.js', 'src/index.ts', 'src/index.js']) {
    const abs = join(dir, candidate);
    if (existsSync(abs)) return abs;
  }
  return undefined;
}

interface FoundAdapter {
  exportedName: string;
  adapter: AdapterShape;
}

function isAdapterShape(value: unknown): value is AdapterShape {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.start === 'function' &&
    typeof record.stop === 'function' &&
    typeof record.send === 'function'
  );
}

/**
 * Scan a module namespace for an adapter: prefer an already-constructed
 * object (e.g. a `defineChannelAdapter` default export), then try to
 * instantiate exported classes without args, and finally with the module's
 * own `Config` factory (the official adapters require a config).
 */
function findAdapter(mod: Record<string, unknown>): FoundAdapter | undefined {
  const names = [...Object.keys(mod)];
  if (mod.default !== undefined && !names.includes('default')) names.push('default');

  for (const name of names) {
    const value = mod[name];
    if (typeof value === 'object' && value !== null && isAdapterShape(value)) {
      return { exportedName: name, adapter: value };
    }
  }
  for (const name of names) {
    const value = mod[name];
    if (typeof value !== 'function') continue;
    const instances: unknown[] = [];
    try {
      instances.push(new (value as new () => unknown)());
    } catch {
      // constructor requires arguments or is not constructable
    }
    if (instances.length === 0 && typeof mod.Config === 'function') {
      try {
        const config = (mod.Config as (input?: unknown) => unknown)({});
        instances.push(new (value as new (config: unknown) => unknown)(config));
      } catch {
        // not a config-based constructor
      }
    }
    for (const instance of instances) {
      if (isAdapterShape(instance)) return { exportedName: name, adapter: instance };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Check: manifest
// ---------------------------------------------------------------------------

function checkManifest(adapter: AdapterShape | undefined, opts: VerifyOptions): VerifyCheck {
  const items: VerifyItem[] = [];
  if (!adapter) {
    return { id: 'manifest', items: [warn('manifest-skipped', 'no adapter found; manifest check skipped')] };
  }
  const manifest = getAdapterManifest(adapter as unknown as ChannelAdapter);
  if (!manifest) {
    return {
      id: 'manifest',
      items: [warn('manifest-missing', 'adapter exposes no compatibility manifest; treat it as untested')],
    };
  }
  const errors = validateManifest(manifest);
  if (errors.length > 0) {
    for (const message of errors) {
      items.push(fail('manifest-invalid', message));
    }
    return { id: 'manifest', items };
  }
  const policy = { allowUnsupported: opts.allowUnsupported === true };
  const state = versionState(manifest, policy);
  const verdict = manifestVerdict(state.state, policy);
  items.push({ severity: verdict, code: `manifest-${state.state}`, message: state.reason });
  return { id: 'manifest', items };
}

// ---------------------------------------------------------------------------
// Check: capabilities
// ---------------------------------------------------------------------------

function checkCapabilities(adapter: AdapterShape | undefined): VerifyCheck {
  const items: VerifyItem[] = [];
  if (!adapter) {
    return { id: 'capabilities', items: [warn('capabilities-skipped', 'no adapter found; capabilities check skipped')] };
  }
  const caps = adapter.capabilities;
  if (typeof caps !== 'object' || caps === null) {
    return { id: 'capabilities', items: [fail('capabilities-missing', 'adapter.capabilities is missing or not an object')] };
  }
  const record = caps as Record<string, unknown>;
  let problems = 0;
  for (const flag of CAPABILITY_FLAGS) {
    if (typeof record[flag] !== 'boolean') {
      items.push(fail('capabilities-flag-invalid', `capabilities.${flag} must be a boolean`));
      problems += 1;
    }
  }
  if (!STREAMING_MODES.includes(record.streaming as (typeof STREAMING_MODES)[number])) {
    items.push(fail('capabilities-streaming-invalid', "capabilities.streaming must be one of 'native' | 'edit' | 'buffered'"));
    problems += 1;
  }
  if (problems === 0) items.push(ok('capabilities-ok', 'capabilities shape is valid'));
  return { id: 'capabilities', items };
}

// ---------------------------------------------------------------------------
// Check: fixtures
// ---------------------------------------------------------------------------

/**
 * Sweep `<dir>/fixtures/<channel>/*.json` with the testkit validator. When
 * the adapter directory has no local fixtures dir, fall back to an ancestor
 * `fixtures/` directory (the monorepo keeps its fixtures at the repo root)
 * and sweep the subdirectory matching the adapter id.
 */
async function checkFixtures(dir: string, adapterId: string | undefined): Promise<VerifyCheck> {
  const items: VerifyItem[] = [];
  const localFixtures = join(dir, 'fixtures');
  const sources: { root: string; channel: string | undefined }[] = [];
  if (existsSync(localFixtures) && statSync(localFixtures).isDirectory()) {
    sources.push({ root: localFixtures, channel: undefined });
  } else {
    try {
      const ancestor = resolveFixturesDir(dir);
      if (ancestor !== localFixtures) sources.push({ root: ancestor, channel: adapterId });
    } catch {
      // no ancestor fixtures/ directory
    }
  }

  if (sources.length === 0) {
    return {
      id: 'fixtures',
      items: [warn('fixtures-missing', 'no fixtures/ directory found; fixtures are required for Verified maturity')],
    };
  }

  const files: { channel: string; path: string }[] = [];
  for (const source of sources) {
    for (const channel of readdirSync(source.root)) {
      if (source.channel !== undefined && channel !== source.channel) continue;
      const channelDir = join(source.root, channel);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(channelDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      for (const file of readdirSync(channelDir)) {
        if (!file.endsWith('.json')) continue;
        files.push({ channel, path: join(channelDir, file) });
      }
    }
  }

  if (files.length === 0) {
    return {
      id: 'fixtures',
      items: [warn('fixtures-empty', 'no JSON fixtures found for this adapter; fixtures are required for Verified maturity')],
    };
  }

  let valid = 0;
  for (const { channel, path } of files) {
    const label = relative(dir, path);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      items.push(fail('fixtures-unreadable', `${label}: ${errorMessage(error)}`));
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      items.push(fail('fixtures-invalid-json', `${label}: not valid JSON: ${errorMessage(error)}`));
      continue;
    }
    try {
      validateFixture(parsed);
    } catch (error) {
      items.push(fail('fixtures-invalid', `${label}: ${errorMessage(error)}`));
      continue;
    }
    const fixture = parsed as { channel?: unknown };
    if (fixture.channel !== undefined && fixture.channel !== channel) {
      items.push(
        fail('fixtures-channel-mismatch', `${label}: fixture.channel '${fixture.channel}' does not match directory '${channel}'`),
      );
      continue;
    }
    valid += 1;
  }
  items.push(ok('fixtures-ok', `${valid} fixture file(s) valid`));
  return { id: 'fixtures', items };
}

// ---------------------------------------------------------------------------
// Check: credentials
// ---------------------------------------------------------------------------

/** Assignment-like secret patterns; the value group is captured for redaction. */
const SECRET_PATTERN = /\b(token|secret|password|api[_-]?key|authorization)\b\s*[:=]\s*(["'])([^"'\r\n]*)\2/gi;

/** Values that are clearly placeholders and must not be reported. */
const PLACEHOLDER_PATTERN =
  /^(<[^>]+>|xxx+|your[-_ ].*|your_?token|example.*|sample.*|dummy.*|placeholder.*|change_?me|test_[a-z0-9_]+|mock.*|fake.*|\*+)$/i;
const UPPER_PLACEHOLDER_PATTERN = /^[A-Z0-9_]+_PLACEHOLDER$/;

function isPlaceholderValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  if (UPPER_PLACEHOLDER_PATTERN.test(trimmed)) return true;
  return PLACEHOLDER_PATTERN.test(trimmed);
}

async function checkCredentials(dir: string): Promise<VerifyCheck> {
  const items: VerifyItem[] = [];
  const hits: { file: string; key: string }[] = [];
  for (const root of ['src', 'fixtures']) {
    const rootDir = join(dir, root);
    if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) continue;
    await walkFiles(rootDir, (file) => {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        return; // unreadable/binary file: skip
      }
      for (const match of text.matchAll(SECRET_PATTERN)) {
        const key = match[1]?.toLowerCase() ?? 'unknown';
        const value = match[3] ?? '';
        if (isPlaceholderValue(value)) continue;
        hits.push({ file: relative(dir, file), key });
      }
    });
  }

  if (hits.length === 0) {
    items.push(ok('credentials-ok', 'no secret-like assignments found in src/ or fixtures/'));
    return { id: 'credentials', items };
  }
  for (const hit of hits) {
    items.push(
      warn(
        'credentials-suspect',
        `${hit.file}: possible '${hit.key}' assignment with a non-placeholder value (value redacted)`,
      ),
    );
  }
  return { id: 'credentials', items };
}

async function walkFiles(dir: string, onFile: (file: string) => void): Promise<void> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, onFile);
    else if (entry.isFile()) onFile(full);
  }
}

// ---------------------------------------------------------------------------
// Check: contract
// ---------------------------------------------------------------------------

function runPnpmTest(dir: string): Promise<number | null> {
  return new Promise((resolveExit) => {
    const child = spawn('pnpm', ['test'], {
      cwd: dir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.once('error', (error) => {
      console.error(`[channel-verify] failed to spawn pnpm test in ${dir}: ${errorMessage(error)}`);
      resolveExit(null);
    });
    child.once('exit', (code) => resolveExit(code));
  });
}

async function checkContract(dir: string, opts: VerifyOptions): Promise<VerifyCheck> {
  const items: VerifyItem[] = [];
  if (opts.test) {
    const run = opts.runTests ?? runPnpmTest;
    const code = await run(dir);
    if (code === 0) {
      items.push(ok('contract-passed', 'adapter test suite (pnpm test) exited 0'));
    } else {
      items.push(fail('contract-failed', `adapter test suite (pnpm test) exited with code ${code ?? 'unknown'}`));
    }
  } else {
    items.push(
      ok('contract-skipped', 'contract suite runs via the package test script (pnpm test); pass --test to execute it'),
    );
  }
  return { id: 'contract', items };
}
