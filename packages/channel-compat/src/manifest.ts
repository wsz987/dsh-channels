/**
 * Structural adapter compatibility manifest (execution plan Task 13.1).
 *
 * `channel-compat` never imports adapter packages. Each adapter exposes a
 * `readonly manifest` field whose declared type is structurally compatible
 * with `AdapterManifest` (see `packages/channel-weixin/src/manifest.ts`,
 * `packages/channel-dingtalk/src/manifest.ts`). `getAdapterManifest` reads it
 * through a structural type guard so `channels doctor` can inspect any
 * adapter without a package dependency or platform special-casing.
 */

/** Compatibility state of an adapter against its upstream (Task 13.3). */
export type ManifestStatus = 'tested' | 'compatible' | 'untested' | 'unsupported' | 'experimental';

/** Upstream (SDK / gateway / protocol) the adapter was verified against. */
export interface AdapterUpstreamManifest {
  /** Human-readable reference to the upstream implementation. */
  reference: string;
  /** Exact upstream version the adapter was tested against. */
  testedVersion: string;
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

/** Narrow `unknown` to a `ManifestStatus`. */
export function isManifestStatus(value: unknown): value is ManifestStatus {
  return value === 'tested' || value === 'compatible' || value === 'untested' || value === 'unsupported' || value === 'experimental';
}

/**
 * Structural type guard over an arbitrary adapter instance. Returns the
 * adapter's manifest when it exposes a structurally valid `manifest` field,
 * otherwise `undefined` (e.g. for a plain `ChannelAdapter`).
 */
export function getAdapterManifest(adapter: unknown): AdapterManifest | undefined {
  if (typeof adapter !== 'object' || adapter === null) return undefined;
  const raw = (adapter as Record<string, unknown>).manifest;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;

  if (typeof m.id !== 'string') return undefined;
  if (typeof m.adapterVersion !== 'string') return undefined;
  if (!isManifestStatus(m.status)) return undefined;

  const upstream = m.upstream;
  if (typeof upstream !== 'object' || upstream === null) return undefined;
  const u = upstream as Record<string, unknown>;
  if (typeof u.reference !== 'string') return undefined;
  if (typeof u.testedVersion !== 'string') return undefined;
  if (typeof u.versionRange !== 'string') return undefined;
  if (typeof u.strategy !== 'string') return undefined;

  if (m.sdk !== undefined) {
    if (typeof m.sdk !== 'object' || m.sdk === null) return undefined;
    const sdk = m.sdk as Record<string, unknown>;
    if (typeof sdk.package !== 'string') return undefined;
    if (typeof sdk.testedVersion !== 'string') return undefined;
  }

  return raw as AdapterManifest;
}

/**
 * Validate a candidate manifest value. Returns a list of field errors (empty
 * when valid). Accepts `unknown` so loosely-typed manifests can be checked
 * before being trusted by the doctor.
 */
export function validateManifest(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== 'object' || value === null) {
    return ['manifest is not an object'];
  }
  const m = value as Record<string, unknown>;

  if (typeof m.id !== 'string' || m.id.length === 0) {
    errors.push('manifest.id must be a non-empty string');
  }
  if (typeof m.adapterVersion !== 'string' || m.adapterVersion.length === 0) {
    errors.push('manifest.adapterVersion must be a non-empty string');
  }
  if (m.status !== undefined && !isManifestStatus(m.status)) {
    errors.push('manifest.status must be one of tested|compatible|untested|unsupported|experimental');
  }

  if (typeof m.upstream !== 'object' || m.upstream === null) {
    errors.push('manifest.upstream must be an object');
  } else {
    const u = m.upstream as Record<string, unknown>;
    if (typeof u.reference !== 'string' || u.reference.length === 0) {
      errors.push('manifest.upstream.reference must be a non-empty string');
    }
    if (typeof u.testedVersion !== 'string' || u.testedVersion.length === 0) {
      errors.push('manifest.upstream.testedVersion must be a non-empty string');
    }
    if (typeof u.versionRange !== 'string' || u.versionRange.length === 0) {
      errors.push('manifest.upstream.versionRange must be a non-empty string');
    }
    if (typeof u.strategy !== 'string' || u.strategy.length === 0) {
      errors.push('manifest.upstream.strategy must be a non-empty string');
    }
  }

  if (m.sdk !== undefined) {
    if (typeof m.sdk !== 'object' || m.sdk === null) {
      errors.push('manifest.sdk must be an object when present');
    } else {
      const sdk = m.sdk as Record<string, unknown>;
      if (typeof sdk.package !== 'string' || sdk.package.length === 0) {
        errors.push('manifest.sdk.package must be a non-empty string');
      }
      if (typeof sdk.testedVersion !== 'string' || sdk.testedVersion.length === 0) {
        errors.push('manifest.sdk.testedVersion must be a non-empty string');
      }
    }
  }

  return errors;
}
