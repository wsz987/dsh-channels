/**
 * Weixin ChannelDefinition — control-plane entry (execution plan §43).
 *
 * Weixin has NO credentials/config fields: it mounts at startup (autoStart)
 * and the QR login happens on the MOUNTED adapter. The definition therefore
 * delegates beginAuth/pollAuth/submitAuthInput to the live adapter so the M1
 * QR flow itself is byte-for-byte unchanged (same WeixinAdapter methods, same
 * challenge/state shapes). Only the ENTRY moves to the control plane.
 *
 * getConfiguredState() always reports configured=true because there is nothing
 * to configure — the auth session decides authenticity. The UI never parses
 * free-form detail text: [toPublicStatus] derives a structured AuthPhase and
 * prompt entirely inside this host definition (doc §16).
 */
import type { ChannelAdapter, AuthChallenge, AuthStatePoll } from '@wsz987/channel-core';
import type {
  AuthInput,
  AuthProviderSession,
  ChannelDefinition,
  PublicAuthPrompt,
  PublicAuthStatus,
  PublicQrPayload,
} from '@wsz987/channel-control';
import { ControlError } from '@wsz987/channel-control';
import type { WeixinConfig } from './config.js';
import { WeixinAdapter, type WeixinAdapterDeps } from './adapter.js';

/** Options for [createWeixinDefinition]. */
export interface WeixinDefinitionOptions {
  /** Resolved Weixin config (already validated by Schemastery). */
  config: WeixinConfig;
  /** Injectable adapter deps (tests). */
  deps: WeixinAdapterDeps;
  /**
   * Resolve the currently mounted adapter (doc §43). The definition drives the
   * M1 auth flow through this seam so behavior stays identical to headless.
   */
  getAdapter: () => ChannelAdapter | undefined;
  /** Durable store for the enabled intent (doc §21) when the host provides one. */
  persistEnabled?: (enabled: boolean) => Promise<void>;
  /**
   * Optional owner-identity resolver (plan §11 / §52). Returns the canonical
   * sender.id of the Weixin account owner (the scanning QR userId). When
   * provided, the returned definition exposes `resolveOwnerIdentity` so the
   * control plane can safely bootstrap an owner-only policy. The caller is
   * responsible for mapping storage — never exposes platform credential keys.
   */
  resolveOwnerIdentity?: (accountId: string) => Promise<string | undefined>;
}

const AUTH_NOT_READY_MSG = 'weixin adapter is not mounted; start the channel first';

/**
 * Map a raw adapter AuthStatePoll into a structured control-plane
 * PublicAuthStatus (doc §16/§17). This is the ONLY place detail text is
 * interpreted — the Web plane switches on .phase, never on .detail.
 */
export function toPublicStatus(
  poll: AuthStatePoll,
  session: AuthProviderSession,
): PublicAuthStatus {
  if (poll.state === 'authenticated') {
    return { state: 'authenticated', phase: 'authorized', expiresAt: session.expiresAt };
  }
  if (poll.state === 'expired') {
    return { state: 'expired', phase: 'expired', expiresAt: session.expiresAt };
  }
  if (poll.state === 'failed') {
    return { state: 'failed', phase: 'failed', expiresAt: session.expiresAt };
  }

  // pending — derive a structured phase + prompt from the adapter detail.
  const detail = poll.detail ?? '';
  let phase: PublicAuthStatus['phase'] = 'waiting-scan';
  let prompt: PublicAuthPrompt | undefined;
  if (/verify|code/i.test(detail)) {
    phase = 'verification-required';
    prompt = { kind: 'verification-code', message: detail };
  } else if (/confirm|redirect/i.test(detail)) {
    phase = 'waiting-confirm';
    prompt = { kind: 'confirm-on-phone', message: detail };
  }
  return { state: 'pending', phase, prompt, expiresAt: session.expiresAt, detail };
}

/**
 * Wrap a QR login URL into a structured PublicQrPayload (doc §17). A ready-made
 * data:image is passed through as 'data-url'; every other value is 'content'
 * that the browser renders into a QR image (via QRCode.toDataURL).
 */
export function toQrPayload(value: string, expiresAt?: number): PublicQrPayload {
  return {
    kind: /^data:image\//i.test(value) ? 'data-url' : 'content',
    value,
    expiresAt,
  };
}

/** Extract the stored AuthChallenge from a provider session's opaque state. */
function challengeOf(session: AuthProviderSession): AuthChallenge {
  return (session.providerState as { challenge: AuthChallenge }).challenge;
}

const POLL_INTERVAL_MS = 3000;
const DEFAULT_EXPIRES_MS = 3 * 60_000;

/**
 * Build the Weixin ChannelDefinition. Weixin has no config fields (setup
 * fields = []) and only the QR auth method. All auth methods delegate to the
 * mounted adapter via [options.getAdapter].
 */
export function createWeixinDefinition(options: WeixinDefinitionOptions): ChannelDefinition {
  const { config, deps, getAdapter } = options;

  // In the control-plane wiring `config` is the (frozen) settings-scope object
  // (`settings.register(...).get()`), so `config.enabled` is READ-ONLY — an
  // in-process write throws "Cannot assign to read only property 'enabled'"
  // and breaks disabling the channel. Keep the live flag in a local mutable
  // snapshot (mirrors qq/telegram's `snapshot.enabled`) and let
  // persistEnabled() persist the intent through the settings scope.
  const state: { enabled: boolean } = { enabled: config.enabled };

  const requireAdapter = () => getAdapter();

  const pollCurrent = async (session: AuthProviderSession): Promise<PublicAuthStatus> => {
    const adapter = requireAdapter();
    if (!adapter?.pollAuth) {
      throw new ControlError('AUTH_NOT_READY', AUTH_NOT_READY_MSG);
    }
    const poll = await adapter.pollAuth(challengeOf(session));
    return toPublicStatus(poll, session);
  };

  return {
    id: 'weixin',
    get enabled() {
      return state.enabled;
    },
    async setEnabled(enabled: boolean): Promise<void> {
      state.enabled = enabled;
      await options.persistEnabled?.(enabled);
    },
    setup: {
      fields: [],
      authMethods: ['qr'],
    },
    getConfiguredState: async () => ({ configured: true, fields: {} }),
    saveConfig: async () => {
      // Nothing configurable — accept and ignore unknown keys (no-op).
    },
    beginAuth: async (): Promise<AuthProviderSession> => {
      const adapter = requireAdapter();
      if (!adapter?.beginAuth) {
        throw new ControlError('AUTH_NOT_READY', AUTH_NOT_READY_MSG);
      }
      const challenge = await adapter.beginAuth();
      return {
        provider: 'weixin',
        expiresAt: challenge.expiresAt ?? Date.now() + DEFAULT_EXPIRES_MS,
        pollingIntervalMs: POLL_INTERVAL_MS,
        qr: challenge.qrUrl ? toQrPayload(challenge.qrUrl, challenge.expiresAt) : undefined,
        prompt: { kind: 'confirm-on-phone', message: challenge.instruction },
        providerState: { challenge },
      };
    },
    pollAuth: pollCurrent,
    submitAuthInput: async (
      session: AuthProviderSession,
      input: AuthInput,
    ): Promise<PublicAuthStatus> => {
      const adapter = requireAdapter();
      if (!adapter?.submitAuthInput) {
        throw new ControlError('AUTH_NOT_READY', AUTH_NOT_READY_MSG);
      }
      await adapter.submitAuthInput(challengeOf(session), input);
      return pollCurrent(session);
    },
    createAdapter: async () => new WeixinAdapter(config, deps),
    autoStart: true,
    // Declared access capability (plan §11). Weixin is DM-only, no group
    // mention activation in V1; owner is discovered from the account.
    access: {
      directMessages: true,
      groups: false,
      mentions: false,
      ownerDiscovery: 'account',
      identityLabels: { user: 'Weixin User ID' },
    },
    // Expose the optional owner-identity resolver wired by the plugin.
    ...(options.resolveOwnerIdentity
      ? { resolveOwnerIdentity: options.resolveOwnerIdentity }
      : {}),
  };
}
