/**
 * Structural adapter compatibility manifest (execution plan Task 13.1).
 *
 * `channel-compat` never imports adapter packages. Each adapter exposes a
 * `readonly manifest` field whose declared type is structurally compatible
 * with `AdapterManifest` (see `packages/channel-weixin/src/manifest.ts`,
 * `packages/channel-dingtalk/src/manifest.ts`). `getAdapterManifest` reads it
 * through a zod schema so `channels doctor` can inspect any adapter without a
 * package dependency or platform special-casing; `validateManifest` reuses
 * the same schema pieces for the release-gate checks.
 */
import { z } from 'zod';

/** Compatibility state of an adapter against its upstream (Task 13.3). */
export type ManifestStatus = 'tested' | 'compatible' | 'untested' | 'unsupported' | 'experimental';

/** Upstream (SDK / gateway / protocol) the adapter was verified against. */
export interface AdapterUpstreamManifest {
  /** Human-readable reference to the upstream implementation. */
  reference: string;
  /** Exact upstream version the adapter was tested against. */
  testedVersion: string;
  /** Exact upstream commit SHA (source-port channels); filled only after live gate. */
  testedCommit?: string;
  /** Range of upstream versions the adapter is believed to support, e.g. `'>=0.8.20 <0.9.0'`. */
  versionRange: string;
  /** How the adapter integrates with upstream: `'source'`, `'sdk'`, `'gateway'`, etc. */
  strategy: string;
}

/** SDK-level dependency (when the adapter consumes a platform SDK). */
export interface AdapterSdkManifest {
  /** SDK package name. */
  package: string;
  /** SDK version the adapter was tested against. */
  testedVersion: string;
}

/**
 * Minimal structural manifest every channel adapter should expose via a
 * `readonly manifest` class field. Own manifest types only need to be
 * structurally compatible — no import of `channel-compat` is required.
 */
export interface AdapterManifest {
  /** Channel id, e.g. `'weixin'`. */
  id: string;
  /** Adapter package version. */
  adapterVersion: string;
  /** Upstream reference, tested version, supported range and strategy. */
  upstream: AdapterUpstreamManifest;
  /** Platform SDK dependency, when the adapter consumes one. */
  sdk?: AdapterSdkManifest;
  /** Declared compatibility state (Task 13.3). */
  status: ManifestStatus;
}

export const MANIFEST_STATUSES = [
  'tested',
  'compatible',
  'untested',
  'unsupported',
  'experimental',
] as const;

export const manifestStatusSchema = z.enum(MANIFEST_STATUSES);

const adapterSdkSchema = z.object({
  package: z.string(),
  testedVersion: z.string(),
});

const adapterUpstreamSchema = z.object({
  reference: z.string(),
  testedVersion: z.string(),
  testedCommit: z.string().optional(),
  versionRange: z.string(),
  strategy: z.string(),
});

/**
 * Structural manifest schema used by `getAdapterManifest`: strings stay
 * strings (empty allowed), `status` must be a known enum and `sdk` may be
 * absent. Unknown keys pass through.
 */
export const adapterManifestSchema = z.object({
  id: z.string(),
  adapterVersion: z.string(),
  upstream: adapterUpstreamSchema,
  sdk: adapterSdkSchema.optional(),
  status: manifestStatusSchema,
}).loose();

/** Narrow `unknown` to a `ManifestStatus`. */
export function isManifestStatus(value: unknown): value is ManifestStatus {
  return manifestStatusSchema.safeParse(value).success;
}

/** A pending placeholder such as `<pending-live-verification>` or empty. */
export function isPlaceholder(value: string): boolean {
  if (value.length === 0) return true;
  return /^<[^>]*>$/.test(value);
}

/** A valid Git object id (7–40 hex chars; accepts full and abbreviated SHAs). */
export function isGitSha(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

/**
 * Structural guard over an arbitrary adapter instance. Returns the adapter's
 * manifest when it exposes a structurally valid `manifest` field, otherwise
 * `undefined` (e.g. for a plain `ChannelAdapter`).
 */
export function getAdapterManifest(adapter: unknown): AdapterManifest | undefined {
  if (typeof adapter !== 'object' || adapter === null) return undefined;
  const raw = (adapter as Record<string, unknown>).manifest;
  const parsed = adapterManifestSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  return parsed.data as AdapterManifest;
}

/**
 * Validate a candidate manifest value. Returns a list of field errors (empty
 * when valid). Accepts `unknown` so loosely-typed manifests can be checked
 * before being trusted by the doctor.
 *
 * Unlike the structural reader this tolerates a missing `status` (reported
 * only when present and invalid) and enforces non-empty strings, matching the
 * historical contract. The `tested` release-gate (R6) requires REAL values —
 * never placeholders, a wildcard range, or an invalid source commit —
 * while `experimental` is allowed to stay pending.
 */
export function validateManifest(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) {
    return ['manifest is not an object'];
  }
  const m = value as Record<string, unknown>;
  const errors: string[] = [];

  const parsed = manifestValidationSchema.safeParse(value);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      if (issue.path.length === 0) continue;
      errors.push(issue.message);
    }
  }

  // Release-gate enforcement (R6): a `tested` manifest must carry REAL values —
  // never placeholders, a wildcard range, or an invalid source commit.
  // `experimental` is allowed to stay pending.
  if (m.status === 'tested') {
    const u = (m.upstream ?? {}) as Record<string, unknown>;
    const testedVersion = typeof u.testedVersion === 'string' ? u.testedVersion : '';
    const versionRange = typeof u.versionRange === 'string' ? u.versionRange : '';
    const testedCommit = u.testedCommit;

    if (isPlaceholder(testedVersion)) {
      errors.push('manifest.upstream.testedVersion must be a real version (not a placeholder) when status is tested');
    }
    if (isPlaceholder(versionRange) || versionRange === '*') {
      errors.push("manifest.upstream.versionRange must be pinned (not '*') when status is tested");
    }
    if (testedCommit !== undefined && (typeof testedCommit !== 'string' || !isGitSha(testedCommit))) {
      errors.push('manifest.upstream.testedCommit must be a valid Git SHA (7-40 hex) when status is tested');
    }
  }

  return errors;
}

/** Non-empty string with a stable per-field message. */
function nonEmpty(message: string): z.ZodString {
  return z.string(message).min(1, message);
}

/**
 * Tolerant field schema behind `validateManifest`: every field is checked
 * with the exact legacy message, `status` stays optional and unknown keys
 * pass through.
 */
const manifestValidationSchema = z.object({
  id: nonEmpty('manifest.id must be a non-empty string'),
  adapterVersion: nonEmpty('manifest.adapterVersion must be a non-empty string'),
  status: z.enum(MANIFEST_STATUSES, 'manifest.status must be one of tested|compatible|untested|unsupported|experimental').optional(),
  upstream: z.object({
    reference: nonEmpty('manifest.upstream.reference must be a non-empty string'),
    testedVersion: nonEmpty('manifest.upstream.testedVersion must be a non-empty string'),
    versionRange: nonEmpty('manifest.upstream.versionRange must be a non-empty string'),
    strategy: nonEmpty('manifest.upstream.strategy must be a non-empty string'),
    testedCommit: z.string('manifest.upstream.testedCommit must be a string when present').optional(),
  }, 'manifest.upstream must be an object'),
  sdk: z.object({
    package: nonEmpty('manifest.sdk.package must be a non-empty string'),
    testedVersion: nonEmpty('manifest.sdk.testedVersion must be a non-empty string'),
  }, 'manifest.sdk must be an object when present').optional(),
}).loose();
