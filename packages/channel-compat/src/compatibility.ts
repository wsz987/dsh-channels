/**
 * Adapter compatibility aggregation (execution plan Task 13.1–13.3, M4).
 *
 * `checkAdapterCompatibility` is the single-entry governance check for one
 * adapter: it reads the adapter's structural manifest, validates it, resolves
 * the effective compatibility state against the version policy (optionally
 * against a target upstream version) and maps it to a doctor verdict.
 *
 * Pure and synchronous — no I/O, no health probing. The doctor's async
 * `diagnose` builds on the same primitives; this function is the
 * governance-layer counterpart used by CI gates and manifest sync checks.
 */
import type { AdapterManifest, ManifestStatus } from './manifest.js';
import { getAdapterManifest, validateManifest } from './manifest.js';
import type { ManifestVerdict } from './version-policy.js';
import { manifestVerdict, versionState } from './version-policy.js';

export interface CompatibilityCheckOptions {
  /**
   * Target upstream version to check against the manifest's declared
   * `versionRange`. When absent the manifest's own `status` is
   * authoritative.
   */
  targetVersion?: string;
  /** Treat `unsupported` as a warning instead of a failure (default false). */
  allowUnsupported?: boolean;
}

export interface CompatibilityCheckResult {
  /** The adapter's structural manifest, when it exposes one. */
  manifest: AdapterManifest | undefined;
  /** Field-level validation errors from `validateManifest` (empty when valid). */
  validationErrors: string[];
  /** Effective compatibility state resolved by the version policy. */
  state: ManifestStatus;
  /** Doctor verdict for the resolved state. */
  verdict: ManifestVerdict;
  /** Human-readable reason for the state. */
  reason: string;
}

/** Best-effort channel id for diagnostics; falls back to `'adapter'`. */
function adapterId(adapter: unknown): string {
  if (typeof adapter === 'object' && adapter !== null) {
    const id = (adapter as Record<string, unknown>).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return 'adapter';
}

/**
 * Check one adapter against the compatibility governance policy.
 *
 * - No structural manifest → `untested` / `warning` (no evidence).
 * - Manifest present → validate, then resolve the version state and verdict
 *   with the supplied options (target version / allowUnsupported).
 */
export function checkAdapterCompatibility(
  adapter: unknown,
  opts: CompatibilityCheckOptions = {},
): CompatibilityCheckResult {
  const manifest = getAdapterManifest(adapter);
  if (!manifest) {
    return {
      manifest: undefined,
      validationErrors: [],
      state: 'untested',
      verdict: 'warning',
      reason: `${adapterId(adapter)} does not expose a compatibility manifest; treat as untested`,
    };
  }

  const validationErrors = validateManifest(manifest);
  const { state, reason } = versionState(manifest, opts);
  return {
    manifest,
    validationErrors,
    state,
    verdict: manifestVerdict(state, opts),
    reason,
  };
}
