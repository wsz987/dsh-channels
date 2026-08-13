/**
 * Version state policy (execution plan Task 13.3).
 *
 * The four compatibility states and their default treatment:
 *
 * - `tested`     → ok
 * - `compatible` → ok
 * - `untested`   → warning (default state when there is no evidence)
 * - `unsupported`→ fail unless overridden via `opts.allowUnsupported`
 *
 * The core states come from the manifest's own `status` field. When a target
 * upstream version is supplied, the manifest's declared `versionRange` is
 * checked best-effort against it; a target outside the declared range
 * downgrades the state to `untested` (we have no evidence for that version).
 *
 * Everything here is pure and unit-testable — no I/O, no adapters.
 */
import type { AdapterManifest, ManifestStatus } from './manifest.js';

export interface VersionPolicyOptions {
  /**
   * Target upstream version to check against the manifest's declared
   * `versionRange`. When absent the manifest's own `status` is authoritative.
   */
  targetVersion?: string;
  /** Treat `unsupported` as a warning instead of a failure (default false). */
  allowUnsupported?: boolean;
}

/** How a doctor should treat a resolved state. */
export type ManifestVerdict = 'ok' | 'warning' | 'fail';

export interface VersionStateResult {
  state: ManifestStatus;
  /** Human-readable reason for the state. */
  reason: string;
}

/**
 * Compare two dotted numeric version strings (`'0.8.20'` vs `'0.9.0'`).
 * Non-numeric segments are compared as strings (best-effort). Returns <0, 0
 * or >0.
 */
export function compareVersions(a: string, b: string): number {
  const aParts = a.split('.');
  const bParts = b.split('.');
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i += 1) {
    const aPart = aParts[i];
    const bPart = bParts[i];
    if (aPart === undefined) return bPart === undefined ? 0 : -1;
    if (bPart === undefined) return 1;
    const aNum = Number(aPart);
    const bNum = Number(bPart);
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
      if (aNum !== bNum) return aNum - bNum;
    } else if (aPart !== bPart) {
      return aPart < bPart ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Best-effort range satisfaction check for ranges like `'>=0.8.20 <0.9.0'`.
 * Supports `>`, `>=`, `<`, `<=`, `=`, `^`, `~` operators on dotted numeric
 * versions. `^`/`~` are treated as exact matches (best-effort). `'*'`, empty
 * ranges and unrecognized operators are treated as satisfied (documented
 * best-effort: an unknown range must not fail a deploy by guess).
 */
export function satisfiesVersion(version: string, range: string): boolean {
  const trimmed = range.trim();
  if (!trimmed || trimmed === '*') return true;

  const tokens = trimmed.match(/(?:>=|<=|>|<|=|\^|~)\s*[^\s]+/g) ?? [];
  for (const token of tokens) {
    const match = token.match(/^(>=|<=|>|<|=|\^|~)\s*(.+)$/);
    if (!match) continue;
    const op = match[1]!;
    const target = match[2]!.trim();
    const cmp = compareVersions(version, target);
    switch (op) {
      case '>=':
        if (cmp < 0) return false;
        break;
      case '>':
        if (cmp <= 0) return false;
        break;
      case '<':
        if (cmp >= 0) return false;
        break;
      case '<=':
        if (cmp > 0) return false;
        break;
      case '=':
      case '^':
      case '~':
        if (cmp !== 0) return false;
        break;
      default:
        // Unknown operator: best-effort, treat as satisfied.
        break;
    }
  }
  return true;
}

/**
 * Resolve the effective compatibility state of a manifest.
 *
 * Priority: an explicitly declared `unsupported` status is authoritative;
 * otherwise a supplied target version outside the declared range downgrades
 * to `untested`; otherwise the manifest's own `status` stands.
 */
export function versionState(
  manifest: AdapterManifest,
  opts: VersionPolicyOptions = {},
): VersionStateResult {
  if (manifest.status === 'unsupported') {
    return {
      state: 'unsupported',
      reason: `${manifest.id} ${manifest.adapterVersion} is declared unsupported; pass allowUnsupported to override`,
    };
  }

  if (opts.targetVersion !== undefined && !satisfiesVersion(opts.targetVersion, manifest.upstream.versionRange)) {
    return {
      state: 'untested',
      reason: `${manifest.id} ${manifest.adapterVersion} is declared ${manifest.status} but target upstream ${opts.targetVersion} falls outside declared range ${manifest.upstream.versionRange}`,
    };
  }

  switch (manifest.status) {
    case 'tested':
      return {
        state: 'tested',
        reason: `${manifest.id} ${manifest.adapterVersion} tested against upstream ${manifest.upstream.testedVersion}`,
      };
    case 'compatible':
      return {
        state: 'compatible',
        reason: `${manifest.id} ${manifest.adapterVersion} compatible with upstream range ${manifest.upstream.versionRange}`,
      };
    case 'untested':
      return {
        state: 'untested',
        reason: `${manifest.id} ${manifest.adapterVersion} has not been tested against upstream; treat with caution`,
      };
    default:
      return {
        state: 'unsupported',
        reason: `${manifest.id} ${manifest.adapterVersion} is unsupported`,
      };
  }
}

/**
 * Policy verdict for a resolved state. `tested`/`compatible` are ok,
 * `untested` is a warning, and `unsupported` fails unless overridden.
 */
export function manifestVerdict(state: ManifestStatus, opts: VersionPolicyOptions = {}): ManifestVerdict {
  switch (state) {
    case 'tested':
    case 'compatible':
      return 'ok';
    case 'untested':
      return 'warning';
    case 'unsupported':
      return opts.allowUnsupported ? 'warning' : 'fail';
  }
}
