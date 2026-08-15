/**
 * DingTalkChannelDefinition — the universal Control Plane spec for DingTalk.
 *
 * Advertises the channel's setup surface (AppKey as a plain text field, the
 * AppSecret as a credentialed secret field pointing at
 * `DSH_CHANNEL_DINGTALK_MAIN_CLIENT_SECRET`), reports configured state by
 * combining config + the credentials seam, persists non-secret config patches
 * into an internal snapshot, and builds the adapter — resolving SDK-mode
 * credentials through the injected credentials seam and injecting them as
 * `deps.clientSecret` (mirrors channel-qq deps.appSecret).
 *
 * The view is fully offline-testable: pass a fake credentials seam and fake
 * transport/sdkClient via deps. No secret value ever leaves the seam.
 */
import {
  type ChannelDefinition,
  type ChannelSetupDescriptor,
  type ConfiguredState,
  type AuthBeginInput,
} from '@wsz987/channel-control';
import { ControlError } from '@wsz987/channel-control';
import type { DingTalkConfig, DingTalkUpstreamConfig } from './config.js';
import { DINGTALK_CLIENT_SECRET_REF } from './config.js';
import { DingTalkAdapter, type DingTalkAdapterDeps } from './adapter.js';
import {
  beginDingTalkDeviceAuth,
  pollDingTalkDeviceAuth,
} from './auth/device-registration.js';

/** Structural credential seam (matches the channel-control CredentialSeam). */
export interface DingTalkCredentialSeam {
  resolve(
    ref: string,
  ): Promise<{ value: string; source: string } | undefined>;
  describe(ref: string): Promise<{ configured: boolean; writable: boolean; source?: string }>;
  set(ref: string, value: string): Promise<void>;
}

export interface DingTalkDefinitionOptions {
  config: DingTalkConfig;
  deps: DingTalkAdapterDeps;
  /** The injected ctx.credentials seam (never the secret values themselves). */
  credentials: DingTalkCredentialSeam;
  /** Durable store for the non-secret setup field when the host provides one. */
  persistSetup?: (patch: { upstream: Pick<DingTalkConfig['upstream'], 'clientId'> }) => Promise<void>;
  /** Reconcile the runtime after device registration writes new credentials. */
  onAuthCompleted?: () => Promise<void>;
}

/** Non-secret config keys accepted by saveConfig (deep-merged sub-objects). */
const SAVABLE_KEYS = [
  'baseUrl',
  'timeoutMs',
  'longPollTimeoutMs',
  'reconnect',
  'dedup',
  'card',
  'accountId',
  'upstream.mode',
  'upstream.clientId',
] as const;

/**
 * Official DingTalk developer console (open-dev) — one-step entry to the app
 * list, not the marketing homepage. When the app's clientId is known the link
 * deep-links to that app (`#/app?clientId=`), mirroring openclaw-toolkit.
 */
export const DINGTALK_OPEN_PLATFORM_URL = 'https://open-dev.dingtalk.com';

export function dingtalkConsoleUrl(clientId: string | undefined): string {
  const id = clientId?.trim();
  return id
    ? `${DINGTALK_OPEN_PLATFORM_URL}/#/app?clientId=${encodeURIComponent(id)}`
    : `${DINGTALK_OPEN_PLATFORM_URL}/#/app`;
}

export function createDingTalkDefinition(options: DingTalkDefinitionOptions): ChannelDefinition {
  const { config, deps, credentials } = options;
  // Internal mutable snapshot that saveConfig patches and createAdapter reads,
  // so the control plane can persist changes without rewriting plugin config.
  const state = cloneConfig(config);

  const clientSecretRef = (): string => state.upstream.clientSecretRef ?? DINGTALK_CLIENT_SECRET_REF;

  const setup: ChannelSetupDescriptor = {
    fields: [
      { name: 'clientId', kind: 'text', secret: false, configured: Boolean(state.upstream.clientId), writable: true },
      { name: 'clientSecret', kind: 'secret', secret: true, configured: false, writable: true, ref: clientSecretRef() },
    ],
    authMethods: ['device', 'credentials'],
    setupUrl: dingtalkConsoleUrl(state.upstream.clientId),
  };

  const refreshSetup = () => {
    setup.fields = [
      { name: 'clientId', kind: 'text', secret: false, configured: Boolean(state.upstream.clientId), writable: true },
      { name: 'clientSecret', kind: 'secret', secret: true, configured: false, writable: true, ref: clientSecretRef() },
    ];
    setup.setupUrl = dingtalkConsoleUrl(state.upstream.clientId);
  };

  const saveConfig = async (patch: Record<string, unknown>): Promise<void> => {
    applyPatch(state, patch);
    refreshSetup();
    if (patch.clientId !== undefined || isPlainObject(patch.upstream) && patch.upstream.clientId !== undefined) {
      await options.persistSetup?.({ upstream: { clientId: state.upstream.clientId } });
    }
  };

  return {
    id: 'dingtalk',
    enabled: state.enabled,

    setup,

    async getConfiguredState(): Promise<ConfiguredState> {
      if (state.upstream.mode === 'gateway') {
        const baseUrlConfigured = Boolean(state.baseUrl);
        const fields: ConfiguredState['fields'] = {
          clientId: { configured: false, writable: true },
          clientSecret: { configured: false, writable: true },
          baseUrl: { configured: baseUrlConfigured, writable: true },
        };
        return { configured: baseUrlConfigured, fields };
      }
      // SDK mode: configured when clientId is set and the secret credential is configured.
      const clientIdConfigured = Boolean(state.upstream.clientId);
      const secretDescribed = await credentials.describe(clientSecretRef());
      const fields: ConfiguredState['fields'] = {
        clientId: { configured: clientIdConfigured, writable: true, value: state.upstream.clientId },
        clientSecret: {
          configured: secretDescribed.configured,
          writable: secretDescribed.writable,
          source: secretDescribed.source,
        },
      };
      return { configured: clientIdConfigured && secretDescribed.configured, fields };
    },

    saveConfig,

    async beginAuth(input: AuthBeginInput) {
      if (input.method !== 'device') {
        throw new ControlError('AUTH_NOT_SUPPORTED', 'dingtalk supports device authorization or credentials setup');
      }
      return beginDingTalkDeviceAuth({
        baseUrl: process.env.DINGTALK_REGISTRATION_BASE_URL,
        source: process.env.DINGTALK_REGISTRATION_SOURCE,
      });
    },

    async pollAuth(session) {
      const result = await pollDingTalkDeviceAuth(session);
      if (result.credentials) {
        await credentials.set(clientSecretRef(), result.credentials.clientSecret);
        await saveConfig({ clientId: result.credentials.clientId });
        await options.onAuthCompleted?.();
      }
      return result.status;
    },

    snapshotConfig: () => cloneConfig(state),
    async restoreConfig(saved: unknown) {
      const restored = cloneConfig(saved as DingTalkConfig);
      Object.assign(state, restored);
      state.reconnect = restored.reconnect;
      state.dedup = restored.dedup;
      state.card = restored.card;
      state.upstream = restored.upstream;
      refreshSetup();
      await options.persistSetup?.({ upstream: { clientId: state.upstream.clientId } });
    },

    async createAdapter() {
      let resolvedSecret: string | undefined;
      if (state.upstream.mode === 'sdk') {
        const ref = clientSecretRef();
        const credential = await credentials.resolve(ref);
        resolvedSecret = credential?.value;
        if (!resolvedSecret) {
          throw new Error(`dingtalk credential "${ref}" is not configured`);
        }
      }
      const adapterDeps = resolvedSecret ? { ...deps, clientSecret: resolvedSecret } : deps;
      return new DingTalkAdapter(state, adapterDeps);
    },

    autoStart: true,
  };
}

function cloneConfig(config: DingTalkConfig): DingTalkConfig {
  return {
    ...config,
    reconnect: { ...config.reconnect },
    dedup: { ...config.dedup },
    card: { ...config.card },
    upstream: { ...config.upstream },
  };
}

/**
 * Deep-merge a non-secret config patch into a mutable snapshot. Accepts both
 * the flat dotted form (`upstream.mode`) and the nested object form
 * (`upstream: { mode }`); sub-objects (reconnect/dedup/card/upstream) are
 * merged shallowly so a partial patch updates only the supplied keys. Secret
 * values are intentionally never accepted here.
 */
function applyPatch(state: DingTalkConfig, patch: Record<string, unknown>): void {
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === undefined) continue;
    if (key === 'reconnect' && isPlainObject(value)) {
      Object.assign(state.reconnect, value);
    } else if (key === 'dedup' && isPlainObject(value)) {
      Object.assign(state.dedup, value);
    } else if (key === 'card' && isPlainObject(value)) {
      Object.assign(state.card, value);
    } else if (key === 'upstream' && isPlainObject(value)) {
      mergeUpstream(state.upstream, value as Partial<DingTalkUpstreamConfig>);
    } else if (key === 'upstream.mode' && (value === 'sdk' || value === 'gateway')) {
      state.upstream.mode = value;
    } else if (key === 'upstream.clientId' && typeof value === 'string') {
      state.upstream.clientId = value;
    } else if (key === 'clientId' && typeof value === 'string') {
      // Web setup fields use a flat, user-facing name; the runtime config
      // keeps the value under upstream.
      state.upstream.clientId = value;
    } else if (SAVABLE_KEYS.includes(key as (typeof SAVABLE_KEYS)[number])) {
      (state as unknown as Record<string, unknown>)[key] = value;
    }
    // Unknown / secret keys are silently ignored (the control plane rejects
    // secret field names before reaching us; this is a final safety net).
  }
}

function mergeUpstream(upstream: DingTalkUpstreamConfig, patch: Partial<DingTalkUpstreamConfig>): void {
  if (patch.mode !== undefined) upstream.mode = patch.mode;
  if (patch.clientId !== undefined) upstream.clientId = patch.clientId;
  if (patch.clientSecretRef !== undefined) upstream.clientSecretRef = patch.clientSecretRef;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
