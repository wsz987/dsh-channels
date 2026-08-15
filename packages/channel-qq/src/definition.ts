/**
 * QQ ChannelDefinition for the universal Channel Control Plane (doc §14–§18,
 * §29–§33, §47).
 *
 * Implements the shared `ChannelDefinition` contract so the control plane
 * drives setup / configured-state / config-save / instantiation for QQ purely
 * through this interface. The existing `appSecretRef` credential design is
 * kept: config only carries the reference name; the real AppSecret is resolved
 * through the injected credential seam at createAdapter() time and never
 * enters config, logs or errors (QQ-R5).
 *
 * The definition is fully offline-testable: it depends only on the injected
 * structural credential seam and the `QQAdapterDeps` seam (tests inject the
 * `FakeQQSdkClient`).
 *
 * QQ does not expose provider auth through this definition. Users obtain the
 * bot credentials from the official console and submit them through setup.
 */
import { ControlError } from '@wsz987/channel-control';
import type {
  ChannelAdapter,
  ChannelDefinition,
  ConfiguredState,
  ChannelSetupField,
} from '@wsz987/channel-control';
import type { QQConfig } from './config.js';
import { QQ_APP_SECRET_REF } from './config.js';
import { QQAdapter, type QQAdapterDeps } from './adapter.js';

/**
 * Structural credential seam the definition uses (mirrors channel-control's
 * credentials/manager.ts). Deliberately NOT an import of `@deepseek-ai/dsh-credentials`
 * — the definition is adapter-agnostic and the concrete provider is injected.
 */
export interface CredentialSeam {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>;
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

/** Options for building the QQ definition. */
export interface QQDefinitionOptions {
  config: QQConfig;
  /** Adapter construction deps (e.g. an injected `FakeQQSdkClient` in tests). */
  deps: QQAdapterDeps;
  /** The credential seam used to resolve/describe `appSecretRef`. */
  credentials: CredentialSeam;
}

/**
 * Non-secret config keys saveConfig() applies onto the internal config snapshot.
 * Mirrors QQConfig but omits `enabled` / `appSecretRef` (the reference is
 * wired at construction and never rewritten via saveConfig). Unknown keys in a
 * patch are ignored — the control plane already rejects secret keys before the
 * definition is reached (SECRET_FIELD_REJECTED).
 */
const SAVABLE_KEYS = [
  'appId',
  'markdownSupport',
  'streaming',
  'dedup',
  'startupTimeoutMs',
  'accountId',
] as const;

type SavableKey = (typeof SAVABLE_KEYS)[number];

/** Deep-ish clone of the mutable top-level config sub-objects. */
function cloneSnapshot(config: QQConfig): QQConfig {
  return {
    ...config,
    streaming: { ...config.streaming },
    dedup: { ...config.dedup },
  };
}

/** Validate + clamp one non-secret patch value onto the snapshot. */
function applyPatch(snapshot: QQConfig, key: SavableKey, value: unknown): void {
  switch (key) {
    case 'appId':
      if (typeof value === 'string') snapshot.appId = value;
      return;
    case 'markdownSupport':
      if (typeof value === 'boolean') snapshot.markdownSupport = value;
      return;
    case 'startupTimeoutMs':
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        snapshot.startupTimeoutMs = Math.floor(value);
      }
      return;
    case 'accountId':
      if (typeof value === 'string' && value) snapshot.accountId = value;
      return;
    case 'streaming':
      if (typeof value === 'object' && value !== null) {
        const part = value as Partial<QQConfig['streaming']>;
        if (typeof part?.enabled === 'boolean') snapshot.streaming.enabled = part.enabled;
        if (typeof part?.throttleMs === 'number' && Number.isFinite(part.throttleMs)) {
          snapshot.streaming.throttleMs = Math.max(300, Math.floor(part.throttleMs));
        }
      }
      return;
    case 'dedup':
      if (typeof value === 'object' && value !== null) {
        const part = value as Partial<QQConfig['dedup']>;
        if (typeof part?.enabled === 'boolean') snapshot.dedup.enabled = part.enabled;
        if (typeof part?.windowMs === 'number' && Number.isFinite(part.windowMs)) {
          snapshot.dedup.windowMs = Math.max(0, Math.floor(part.windowMs));
        }
      }
      return;
  }
}

/**
 * Build the QQ `ChannelDefinition`. The returned definition reads from a
 * mutable internal config snapshot (updated by saveConfig) so persisted patches
 * are reflected by createAdapter() and getConfiguredState().
 */
export function createQQDefinition(options: QQDefinitionOptions): ChannelDefinition {
  // Internal mutable config snapshot; saveConfig mutates it, createAdapter reads it.
  const snapshot: QQConfig = cloneSnapshot(options.config);

  const appSecretRef = snapshot.appSecretRef || QQ_APP_SECRET_REF;

  // Static setup surface. The appSecret field's configured/writable flags are
  // best-effort here (a synchronous property cannot await describe()); the
  // authoritative dynamic state is reported by getConfiguredState().
  const fields: ChannelSetupField[] = [
    {
      name: 'appId',
      kind: 'text',
      secret: false,
      configured: Boolean(snapshot.appId),
      writable: true,
    },
    {
      name: 'appSecret',
      kind: 'secret',
      secret: true,
      configured: Boolean(appSecretRef),
      writable: true,
      ref: appSecretRef,
    },
  ];

  return {
    id: 'qq',
    enabled: snapshot.enabled,
    setup: { fields, authMethods: [], setupUrl: 'https://q.qq.com/' },
    autoStart: true,

    async getConfiguredState(): Promise<ConfiguredState> {
      const appId = Boolean(snapshot.appId);
      let appSecret: { configured: boolean; writable: boolean; source?: string } = {
        configured: false,
        writable: false,
      };
      if (appSecretRef) {
        const described = await options.credentials.describe(appSecretRef);
        appSecret = {
          configured: described.configured,
          writable: described.writable,
          source: described.source,
        };
      }
      return {
        configured: appId && appSecret.configured,
        fields: {
          appId: { configured: appId, writable: true },
          appSecret: {
            configured: appSecret.configured,
            writable: appSecret.writable,
            source: appSecret.source,
          },
        },
      };
    },

    async saveConfig(patch: Record<string, unknown>): Promise<void> {
      for (const key of Object.keys(patch)) {
        if ((SAVABLE_KEYS as readonly string[]).includes(key)) {
          applyPatch(snapshot, key as SavableKey, patch[key]);
        }
        // Unknown (incl. secret) keys are ignored; the control plane already
        // rejects secret field names before reaching the definition.
      }
    },

    async createAdapter(): Promise<ChannelAdapter> {
      const credential =
        appSecretRef !== undefined ? await options.credentials.resolve(appSecretRef) : undefined;
      if (!credential) {
        // Stable machine-readable error; never echoes the secret, only the ref.
        throw new ControlError(
          'CONTROL_ERROR',
          `QQ credential "${appSecretRef}" is not configured`,
        );
      }
      return new QQAdapter(snapshot, { ...options.deps, appSecret: credential.value });
    },
  };
}
