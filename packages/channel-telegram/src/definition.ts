/**
 * Telegram ChannelDefinition — the description of the telegram channel exposed
 * to the Channel Control Plane.
 *
 * The control plane drives setup, configured-state reporting and adapter
 * instantiation purely through this object, never through per-channel
 * conditionals.
 *
 * - `setup.fields`   — a single secret field (`token`) backed by the
 *                       `TELEGRAM_BOT_TOKEN_REF` credential reference. The real
 *                       token is only ever written through the credentials seam.
 * - `getConfiguredState` — configured when the token credential exists.
 * - `saveConfig`     — merges only non-secret keys (behavioural tuning) into an
 *                       internal mutable snapshot used by createAdapter. Secret
 *                       fields are rejected upstream by the control plane.
 * - `createAdapter`  — resolves `tokenRef` via the injected credentials seam
 *                       and throws a stable error when it is missing.
 * - `setup.setupUrl` — points at @BotFather, where operators create a bot and
 *                       obtain the Bot API token.
 *
 * Fully offline-testable: inject a fake credentials seam and a fake transport
 * via `deps` — no network, no host.
 */
import type {
  ChannelDefinition,
  ChannelSetupDescriptor,
  ConfiguredState,
} from '@wsz987/channel-control';
import { ControlError } from '@wsz987/channel-control';
import type { TelegramConfig } from './config.js';
import { TELEGRAM_BOT_TOKEN_REF } from './config.js';
import { TelegramAdapter, type TelegramAdapterDeps } from './adapter.js';

/**
 * Structural credential seam used by the definition. Mirrors the tiny slice of
 * `ctx.credentials` the control plane needs; injected so the definition stays
 * host-agnostic and offline-testable. Resolution is per call and must not be
 * cached across calls.
 */
export interface TelegramCredentialSeam {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>;
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>;
  set(ref: string, value: string): Promise<void>;
}

export interface CreateTelegramDefinitionOptions {
  config: TelegramConfig;
  deps?: TelegramAdapterDeps;
  /** Injected credentials seam (wraps ctx.credentials in apply()). */
  credentials: TelegramCredentialSeam;
}

/** Allowed non-secret nested sub-config keys merged by saveConfig. */
const NESTED_KEYS = ['reconnect', 'dedup', 'streaming'] as const;
/** Allowed non-secret top-level scalar keys merged by saveConfig. */
const SCALAR_KEYS = [
  'accountId',
  'baseUrl',
  'timeoutMs',
  'longPollTimeoutMs',
  'maxDownloadBytes',
] as const;

/** Deep-copy a TelegramConfig into an independent mutable snapshot. */
function snapshotOf(config: TelegramConfig): TelegramConfig {
  return {
    ...config,
    reconnect: { ...config.reconnect },
    dedup: { ...config.dedup },
    streaming: { ...config.streaming },
  };
}

function applyScalarPatch(snapshot: TelegramConfig, key: string, value: unknown): void {
  switch (key) {
    case 'accountId':
      if (typeof value === 'string' && value) snapshot.accountId = value;
      return;
    case 'baseUrl':
      if (typeof value === 'string' && value) snapshot.baseUrl = value;
      return;
    case 'timeoutMs':
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        snapshot.timeoutMs = Math.floor(value);
      }
      return;
    case 'longPollTimeoutMs':
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        snapshot.longPollTimeoutMs = Math.floor(value);
      }
      return;
    case 'maxDownloadBytes':
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        snapshot.maxDownloadBytes = Math.floor(value);
      }
      return;
  }
}

/**
 * Build the telegram ChannelDefinition for the control plane. Returns a fresh
 * object each call (cheap) so a plugin can register it against any control
 * instance.
 */
export function createTelegramDefinition(
  options: CreateTelegramDefinitionOptions,
): ChannelDefinition {
  const credentials = options.credentials;
  const deps = options.deps ?? {};
  // Mutable snapshot: saveConfig merges non-secret patches into this; the same
  // object feeds getConfiguredState + createAdapter so both always agree.
  const state = snapshotOf(options.config);

  const tokenRef = (): string => state.tokenRef || TELEGRAM_BOT_TOKEN_REF;

  const setup: ChannelSetupDescriptor = {
    fields: [
      {
        name: 'token',
        kind: 'secret',
        secret: true,
        configured: false,
        writable: true,
        ref: tokenRef(),
      },
    ],
    authMethods: ['credentials'],
    setupUrl: 'https://t.me/BotFather',
  };

  const configuredState = async (): Promise<ConfiguredState> => {
    const described = await credentials.describe(tokenRef());
    return {
      configured: described.configured,
      fields: {
        token: {
          configured: described.configured,
          writable: described.writable,
          source: described.source,
        },
      },
    };
  };

  const saveConfig = async (patch: Record<string, unknown>): Promise<void> => {
    for (const key of NESTED_KEYS) {
      const value = patch[key];
      if (value && typeof value === 'object') {
        Object.assign(state[key], value);
      }
    }
    for (const key of SCALAR_KEYS) {
      if (patch[key] !== undefined) {
        applyScalarPatch(state, key, patch[key]);
      }
    }
    if (patch.enabled !== undefined) state.enabled = Boolean(patch.enabled);
    // `token` / `tokenRef` are secret fields and are rejected by the control
    // plane before reaching this definition; nothing to persist here.
  };

  const restoreConfig = async (saved: unknown): Promise<void> => {
    const restored = snapshotOf(saved as TelegramConfig);
    Object.assign(state, restored);
    state.reconnect = restored.reconnect;
    state.dedup = restored.dedup;
    state.streaming = restored.streaming;
  };

  const createAdapter = async (): Promise<TelegramAdapter> => {
    const resolved = await credentials.resolve(tokenRef());
    const token = resolved?.value;
    if (!token) {
      throw new ControlError(
        'CONTROL_ERROR',
        `telegram credential "${tokenRef()}" is not configured`,
      );
    }
    return new TelegramAdapter(state, { ...deps, token });
  };

  return {
    id: 'telegram',
    enabled: state.enabled,
    setup,
    getConfiguredState: configuredState,
    saveConfig,
    snapshotConfig: () => snapshotOf(state),
    restoreConfig,
    createAdapter,
    autoStart: true,
  };
}
