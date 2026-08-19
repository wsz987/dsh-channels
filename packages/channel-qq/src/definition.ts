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
 * QQ Bot setup uses the official AppID/AppSecret flow. Optional CLI onboarding
 * in the upstream plugin is outside this channel Web control-plane contract.
 */
import type {
  ChannelAdapter,
  ChannelDefinition,
  ChannelSetupDescriptor,
  ConfiguredState,
  ChannelSetupField,
} from '@wsz987/channel-control';
import { ControlError } from '@wsz987/channel-control';
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
  /** Durable store for the non-secret setup field when the host provides one. */
  persistSetup?: (patch: Pick<QQConfig, 'appId'>) => Promise<void>;
  /** Durable store for the enabled intent (doc §21) when the host provides one. */
  persistEnabled?: (enabled: boolean) => Promise<void>;
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

/**
 * Official QQ bot console — one-step entry straight to the QQ openclaw bot page
 * (not the q.qq.com homepage). When the bot's appId is known the link deep-links
 * to that bot (`?appid=`), mirroring the openclaw-toolkit desktop console.
 */
export const QQ_OPEN_PLATFORM_URL = 'https://q.qq.com/qqbot/openclaw/';

export function qqConsoleUrl(appId: string | undefined): string {
  const id = appId?.trim();
  return id ? `${QQ_OPEN_PLATFORM_URL}?appid=${encodeURIComponent(id)}` : QQ_OPEN_PLATFORM_URL;
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
      configured: false,
      writable: true,
      ref: appSecretRef,
    },
  ];

  const setup: ChannelSetupDescriptor = {
    fields,
    authMethods: ['credentials'],
    setupUrl: qqConsoleUrl(snapshot.appId),
  };

  const refreshSetup = () => {
    setup.fields[0]!.configured = Boolean(snapshot.appId);
    setup.setupUrl = qqConsoleUrl(snapshot.appId);
  };

  return {
    id: 'qq',
    get enabled() {
      return snapshot.enabled;
    },
    async setEnabled(enabled: boolean): Promise<void> {
      snapshot.enabled = enabled;
      await options.persistEnabled?.(enabled);
    },
    setup,
    autoStart: true,
    // Declared access capability (plan §11). QQ supports DM + named groups; no
    // mention activation in V1; owner is identified via the /dsh-claim flow.
    access: {
      directMessages: true,
      groups: true,
      mentions: false,
      ownerDiscovery: 'claim',
      identityLabels: { user: 'QQ User OpenID', group: 'QQ Group OpenID' },
    },

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
          appId: { configured: appId, writable: true, value: snapshot.appId },
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
      refreshSetup();
      if (patch.appId !== undefined) await options.persistSetup?.({ appId: snapshot.appId });
    },

    snapshotConfig: () => cloneSnapshot(snapshot),
    async restoreConfig(saved: unknown) {
      const restored = cloneSnapshot(saved as QQConfig);
      Object.assign(snapshot, restored);
      snapshot.streaming = restored.streaming;
      snapshot.dedup = restored.dedup;
      refreshSetup();
      await options.persistSetup?.({ appId: snapshot.appId });
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
