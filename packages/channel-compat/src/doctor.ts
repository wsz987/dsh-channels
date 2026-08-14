/**
 * Channels doctor (execution plan Task 13.2).
 *
 * `diagnose` inspects a set of channel adapters, reads each adapter's
 * structural `manifest` (when present) and its `getHealth()` surface, and
 * produces one `ChannelDiagnostic` per adapter. `formatDoctor` renders them
 * in the Task 13.2 layout. The doctor reads `id` and manifest data as data —
 * there is no platform special-casing and no credentials anywhere.
 */
import type { AuthState, ChannelHealth } from '@dsh/channel-core';
import type { AdapterManifest, ManifestStatus } from './manifest.js';
import { getAdapterManifest } from './manifest.js';
import type { VersionPolicyOptions } from './version-policy.js';
import { versionState } from './version-policy.js';

/** Per-adapter diagnostics produced by `diagnose`. */
export interface ChannelDiagnostic {
  /** Channel id (from the adapter, or its manifest when the adapter is opaque). */
  id: string;
  adapterVersion: string;
  upstreamReference: string;
  upstreamTestedVersion: string;
  upstreamVersionRange: string;
  upstreamStrategy: string;
  /** SDK package info, when the manifest declares one. */
  sdk?: { package: string; testedVersion: string };
  /** Resolved compatibility state (Task 13.3). */
  compatibility: ManifestStatus;
  /** Human-readable reason for the compatibility state. */
  compatibilityReason: string;
  /** Connection state surfaced by `getHealth()`, when reported. */
  connection?: ChannelHealth['connection'];
  /** Auth state surfaced by `getHealth()`, when reported. */
  auth?: AuthState;
  /** Raw health surface from the adapter. */
  health: ChannelHealth;
  /** Whether the adapter's `start()` has been called (best-effort via `started` flag). */
  started: boolean;
}

export interface DiagnoseOptions {
  /** Upstream target version for the version policy (optional). */
  targetVersion?: string;
  /** Override policy passed through to the version state resolution. */
  policy?: VersionPolicyOptions;
}

interface AdapterSurface {
  id: string;
  manifest?: AdapterManifest;
  getHealth?: () => Promise<ChannelHealth>;
  started?: boolean;
}

/** Narrow `unknown` to the minimal adapter surface the doctor needs. */
function adapterSurface(adapter: unknown): AdapterSurface | undefined {
  if (typeof adapter !== 'object' || adapter === null) return undefined;
  const value = adapter as Record<string, unknown>;
  if (typeof value.id !== 'string') return undefined;
  const getHealth = value.getHealth;
  const surface: AdapterSurface = {
    id: value.id,
    // Bind to the adapter instance so `this`-dependent implementations work.
    getHealth: typeof getHealth === 'function' ? (getHealth as () => Promise<ChannelHealth>).bind(value) : undefined,
    started: typeof value.started === 'boolean' ? value.started : undefined,
  };
  surface.manifest = getAdapterManifest(adapter);
  return surface;
}

/** Map the health `authenticated` boolean to an `AuthState`, if expressible. */
function authFromHealth(health: ChannelHealth): AuthState | undefined {
  return health.authenticated === true ? 'authenticated' : undefined;
}

/**
 * Diagnose a set of adapters. Resolves health asynchronously via
 * `getHealth()` when the adapter implements it; adapters without health
 * reporting yield an `unknown` health surface instead of failing the doctor.
 */
export async function diagnose(adapters: readonly unknown[], opts: DiagnoseOptions = {}): Promise<ChannelDiagnostic[]> {
  const diagnostics: ChannelDiagnostic[] = [];
  for (const adapter of adapters) {
    const surface = adapterSurface(adapter);
    if (!surface) continue;

    let health: ChannelHealth;
    try {
      health = (await surface.getHealth?.()) ?? { status: 'unknown' };
    } catch {
      health = { status: 'down', detail: 'getHealth() threw', authenticated: false };
    }

    const manifest = surface.manifest;
    if (!manifest) {
      diagnostics.push({
        id: surface.id,
        adapterVersion: 'unknown',
        upstreamReference: 'unavailable',
        upstreamTestedVersion: 'unknown',
        upstreamVersionRange: 'unknown',
        upstreamStrategy: 'unavailable',
        compatibility: 'untested',
        compatibilityReason: `${surface.id} does not expose a compatibility manifest; treat as untested`,
        connection: health.connection,
        auth: authFromHealth(health),
        health,
        started: surface.started ?? false,
      });
      continue;
    }

    const state = versionState(manifest, { ...opts.policy, targetVersion: opts.targetVersion });
    diagnostics.push({
      id: manifest.id,
      adapterVersion: manifest.adapterVersion,
      upstreamReference: manifest.upstream.reference,
      upstreamTestedVersion: manifest.upstream.testedVersion,
      upstreamVersionRange: manifest.upstream.versionRange,
      upstreamStrategy: manifest.upstream.strategy,
      sdk: manifest.sdk,
      compatibility: state.state,
      compatibilityReason: state.reason,
      connection: health.connection,
      auth: authFromHealth(health),
      health,
      started: surface.started ?? false,
    });
  }
  return diagnostics;
}

/** Format one diagnostic in the Task 13.2 text layout. */
export function formatDiagnostic(d: ChannelDiagnostic): string {
  const lines: string[] = [
    d.id,
    `Adapter: ${d.adapterVersion}`,
    `Upstream: ${d.upstreamReference}`,
    `Tested upstream: ${d.upstreamTestedVersion}`,
    `Upstream range: ${d.upstreamVersionRange}`,
    `Strategy: ${d.upstreamStrategy}`,
  ];
  if (d.sdk) {
    lines.push(`SDK: ${d.sdk.package} ${d.sdk.testedVersion}`);
  } else {
    lines.push('SDK: undefined');
  }
  lines.push(`Compatibility: ${d.compatibility}`);
  if (d.compatibility === 'untested' || d.compatibility === 'experimental' || d.compatibility === 'unsupported') {
    lines.push(`Note: ${d.compatibilityReason}`);
  }
  lines.push(`Connection: ${d.connection ?? 'unknown'}`);
  if (d.auth !== undefined) {
    lines.push(`Auth: ${d.auth}`);
  }
  lines.push(`Health: ${d.health.status}`);
  return lines.join('\n');
}

/** Render diagnostics for the doctor CLI / plugin surface. */
export function formatDoctor(diagnostics: ChannelDiagnostic[]): string {
  return diagnostics.map(formatDiagnostic).join('\n\n');
}
