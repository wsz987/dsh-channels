/**
 * @wsz987/channel-compat — upstream compatibility manifests, version policy,
 * `channels doctor` and the M4 governance aggregation.
 *
 * A dependency-light library surface: structural `AdapterManifest` reading
 * (adapters never import this package), the Task 13.3 version-state policy,
 * the Task 13.2 doctor that turns adapters + health into diagnostics, and
 * `checkAdapterCompatibility` — the single-entry compatibility check used by
 * CI gates and manifest sync checks.
 *
 * No Cordis plugin is shipped here — a plugin/CLI wrapper can be layered on
 * top of `diagnose`/`formatDoctor` later.
 */
export * from './manifest.js';
export * from './version-policy.js';
export * from './doctor.js';
export * from './compatibility.js';
