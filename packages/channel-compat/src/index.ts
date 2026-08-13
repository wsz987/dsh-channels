/**
 * @dsh/channel-compat — upstream compatibility manifests, version policy and
 * `channels doctor`.
 *
 * A dependency-light library surface: structural `AdapterManifest` reading
 * (adapters never import this package), the Task 13.3 version-state policy,
 * and the Task 13.2 doctor that turns adapters + health into diagnostics.
 *
 * No Cordis plugin is shipped here — a plugin/CLI wrapper can be layered on
 * top of `diagnose`/`formatDoctor` later.
 */
export * from './manifest.js';
export * from './version-policy.js';
export * from './doctor.js';
