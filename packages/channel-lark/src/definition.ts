/**
 * Lark ChannelDefinition — the description of the lark channel exposed to the
 * Channel Control Plane (doc §14, §26, §29, §49, §52 Task 5).
 *
 * The control plane (when present) drives setup, configured-state reporting and
 * adapter instantiation purely through this object, never through per-channel
 * conditionals. Binding the definition:
 *
 * - `setup.fields`   — `appId` is a plain config string (kind 'text'); `appSecret`
 *                       is a secret referenced by `LARK_APP_SECRET_REF` and only
 *                       ever written through the credentials seam (doc §31).
 * - `getConfiguredState` — SDK mode is configured when both `appId` (config) and
 *                       the `appSecretRef` credential exist; gateway mode owns its
 *                       credentials inside the self-hosted gateway so it reports
 *                       configured=true.
 * - `saveConfig`     — merges only non-secret keys (appId/domain/mode + nested
 *                       reconnect/dedup/card + accountId/enabled) into an internal
 *                       mutable snapshot used by createAdapter. Secret fields are
 *                       rejected upstream by the control plane.
 * - `createAdapter`  — SDK mode resolves `appSecretRef` via the injected credentials
 *                       seam and throws a stable error when it is missing; gateway
 *                       mode needs no resolved credentials.
 * - `setup.setupUrl` — points at the official Feishu/Lark console. Console
 *                       navigation is not modeled as an auth session.
 *
 * Fully offline-testable: inject a fake credentials seam and fake
 * sdk/openapi clients via `deps` — no network, no host.
 */
import type {
  ChannelDefinition,
  ChannelSetupDescriptor,
  ConfiguredState,
} from '@wsz987/channel-control';
import { ControlError } from '@wsz987/channel-control';
import { ChannelError } from '@wsz987/channel-core';
import type { LarkConfig } from './config.js';
import { LARK_APP_SECRET_REF } from './config.js';
import { LarkAdapter, type LarkAdapterDeps } from './adapter.js';
import {
  beginLarkDeviceAuthorization,
  pollLarkDeviceAuthorization,
} from './auth/device-authorization.js';

/**
 * Structural credential seam used by the definition. Mirrors the tiny slice of
 * `ctx.credentials` the control plane needs; injected so the definition stays
 * host-agnostic and offline-testable. Resolution is per call and must not be
 * cached across calls.
 */
export interface LarkCredentialSeam {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>;
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>;
  set(ref: string, value: string): Promise<void>;
}

export interface CreateLarkDefinitionOptions {
  config: LarkConfig;
  deps?: LarkAdapterDeps;
  /** Injected credentials seam (wraps ctx.credentials in apply()). */
  credentials: LarkCredentialSeam;
  /** Durable store for the non-secret setup field when the host provides one. */
  persistSetup?: (patch: { upstream: Pick<LarkConfig['upstream'], 'appId'> }) => Promise<void>;
  /** Durable store for the enabled intent (doc §21) when the host provides one. */
  persistEnabled?: (enabled: boolean) => Promise<void>;
}

/** Allowed non-secret nested sub-config keys merged by saveConfig. */
const NESTED_KEYS = ['reconnect', 'dedup', 'card'] as const;
/** Allowed non-secret 'upstream.*' keys merged by saveConfig (doc §30). */
const UPSTREAM_KEYS = ['appId', 'domain', 'mode'] as const;

/** Deep-copy a LarkConfig into an independent mutable snapshot. */
function snapshotOf(config: LarkConfig): LarkConfig {
  const copy: LarkConfig = { ...config };
  copy.reconnect = { ...config.reconnect };
  copy.dedup = { ...config.dedup };
  copy.card = { ...config.card };
  copy.upstream = { ...config.upstream };
  return copy;
}

/**
 * Feishu/Lark open-platform console "Apps" URL derived from the configured API
 * domain (doc §39/§40). Mirrors `resolveDomain`: the well-known 'feishu' and
 * 'lark' map to their official consoles; any other value is treated as a custom
 * base domain and prefixed with https + '/app'. When the app's appId is known
 * the link deep-links to that app (`/app/<appId>`), mirroring openclaw-toolkit.
 */
export function larkConsoleAppUrl(domain: string | undefined, appId?: string): string {
  const base =
    domain === 'lark'
      ? 'https://open.larksuite.com/app'
      : domain && domain !== 'feishu'
        ? `https://${domain.replace(originRE, '').replace(trailRE, '')}/app`
        : 'https://open.feishu.cn/app';
  const id = appId?.trim();
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

const originRE = /^https?:\/\//;
const trailRE = /\/+$/;

/**
 * Build the lark ChannelDefinition for the control plane. Returns a fresh object
 * each call (cheap) so a plugin can register it against any control instance.
 */
export function createLarkDefinition(
  options: CreateLarkDefinitionOptions,
): ChannelDefinition {
  const credentials = options.credentials;
  const deps = options.deps ?? {};
  // Mutable snapshot: saveConfig merges non-secret patches into this; the same
  // object feeds getConfiguredState + createAdapter so both always agree.
  const state = snapshotOf(options.config);

  const appSecretRef = (): string => state.upstream.appSecretRef ?? LARK_APP_SECRET_REF;

  const setup: ChannelSetupDescriptor = {
    fields: [
      {
        name: 'appId',
        kind: 'text',
        secret: false,
        configured: Boolean(state.upstream.appId),
        writable: true,
      },
      {
        name: 'appSecret',
        kind: 'secret',
        secret: true,
        configured: false,
        writable: true,
        ref: appSecretRef(),
      },
    ],
    authMethods: ['credentials', 'hybrid'],
    setupUrl: larkConsoleAppUrl(state.upstream.domain, state.upstream.appId),
  };

  const configuredState = async (): Promise<ConfiguredState> => {
    const appIdConfigured = Boolean(state.upstream.appId);
    const secret = await credentials.describe(appSecretRef());
    if (state.upstream.mode === 'gateway') {
      // Gateway owns platform credentials; only appId is plain config here.
      return {
        configured: true,
        fields: {
          appId: { configured: appIdConfigured, writable: true, value: state.upstream.appId },
          appSecret: { configured: true, writable: true },
        },
      };
    }
    const configured = appIdConfigured && secret.configured;
    return {
      configured,
      fields: {
        appId: { configured: appIdConfigured, writable: true, value: state.upstream.appId },
        appSecret: {
          configured: secret.configured,
          writable: secret.writable,
          source: secret.source,
        },
      },
    };
  };

  const saveConfig = async (patch: Record<string, unknown>): Promise<void> => {
    // Nested sub-objects (deep-merge): reconnect / dedup / card.
    for (const key of NESTED_KEYS) {
      const value = patch[key];
      if (value && typeof value === 'object') {
        Object.assign(state[key], value);
      }
    }
    // Object-form 'upstream' non-secret keys.
    const upstreamPatch = patch.upstream;
    if (upstreamPatch && typeof upstreamPatch === 'object') {
      const target = state.upstream as unknown as Record<string, unknown>;
      for (const key of UPSTREAM_KEYS) {
        const value = (upstreamPatch as Record<string, unknown>)[key];
        if (value !== undefined) target[key] = value;
      }
    }
    // Dot-path 'upstream.*' non-secret keys.
    for (const key of UPSTREAM_KEYS.map((k) => `upstream.${k}`)) {
      const value = patch[key];
      if (value === undefined) continue;
      const field = key.slice('upstream.'.length);
      (state.upstream as unknown as Record<string, unknown>)[field] = value;
    }
    if (typeof patch.appId === 'string') state.upstream.appId = patch.appId;
    if (patch.accountId !== undefined) state.accountId = String(patch.accountId);
    if (patch.enabled !== undefined) state.enabled = Boolean(patch.enabled);
    setup.setupUrl = larkConsoleAppUrl(state.upstream.domain, state.upstream.appId);
    const hasUpstreamAppId =
      patch.upstream !== null &&
      typeof patch.upstream === 'object' &&
      !Array.isArray(patch.upstream) &&
      (patch.upstream as Record<string, unknown>).appId !== undefined;
    if (patch.appId !== undefined || hasUpstreamAppId) {
      await options.persistSetup?.({ upstream: { appId: state.upstream.appId } });
    }
  };

  const restoreConfig = async (saved: unknown): Promise<void> => {
    const restored = snapshotOf(saved as LarkConfig);
    Object.assign(state, restored);
    state.reconnect = restored.reconnect;
    state.dedup = restored.dedup;
    state.card = restored.card;
    state.upstream = restored.upstream;
    setup.setupUrl = larkConsoleAppUrl(state.upstream.domain, state.upstream.appId);
    await options.persistSetup?.({ upstream: { appId: state.upstream.appId } });
  };

  const createAdapter = async () => {
    if (state.upstream.mode === 'gateway') {
      return new LarkAdapter(state, deps);
    }
    const appId = state.upstream.appId;
    const resolved = await credentials.resolve(appSecretRef());
    const appSecret = resolved?.value;
    if (!appId || !appSecret) {
      // Stable, logged-out error — never includes the secret value.
      throw new ChannelError(
        'CHANNEL_ERROR',
        `lark upstream mode "sdk" requires configured appId (config) and appSecret (credentials ref ${appSecretRef()})`,
      );
    }
    return new LarkAdapter(state, { ...deps, appId, appSecret });
  };

  return {
    id: 'lark',
    get enabled() {
      return state.enabled;
    },
    async setEnabled(enabled: boolean): Promise<void> {
      state.enabled = enabled;
      await options.persistEnabled?.(enabled);
    },
    setup,
    getConfiguredState: configuredState,
    saveConfig,
    snapshotConfig: () => snapshotOf(state),
    restoreConfig,
    async beginAuth(input) {
      if (input.method !== 'hybrid' && input.method !== 'device') {
        throw new ControlError('AUTH_NOT_SUPPORTED', 'lark supports device authorization after credentials setup');
      }
      const resolved = await credentials.resolve(appSecretRef());
      return beginLarkDeviceAuthorization({
        appId: state.upstream.appId ?? '',
        appSecret: resolved?.value ?? '',
        domain: state.upstream.domain,
      });
    },
    async pollAuth(session) {
      return pollLarkDeviceAuthorization(session);
    },
    createAdapter,
    autoStart: true,
    // Declared access capability (plan §11). Lark supports DM + groups; no
    // mention activation in V1; owner is identified via the /dsh-claim flow.
    access: {
      directMessages: true,
      groups: true,
      mentions: false,
      ownerDiscovery: 'claim',
      identityLabels: { user: 'Lark User ID', group: 'Lark Chat ID' },
    },
  };
}
