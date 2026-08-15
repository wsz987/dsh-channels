/**
 * Public type surface of @wsz987/channel-control (execution plan §14–§18).
 *
 * These types define the stable boundary between the Channel Control Plane
 * and every downstream consumer (channel adapters, the Web control plane in
 * channel-web, and future provider auth helpers). Platform differences stop
 * here: channel-control itself is adapter-agnostic and never branches on a
 * specific channel id.
 *
 * Host-only types ([InternalAuthSession], [AuthProviderSession]) must never
 * cross the browser boundary — see auth/sanitizer.ts for the public DTOs.
 */
import type { ChannelAdapter, ChannelHealth } from '@wsz987/channel-core';

/** How a channel begins an authorization flow (doc §15). */
export type AuthMethod =
  | 'qr'
  | 'device'
  | 'portal-login'
  | 'credentials'
  | 'hybrid';

/**
 * Fine-grained progress of an auth flow (doc §15/§16). The UI switches on
 * this value rather than parsing free-form [PublicAuthStatus.detail] text.
 */
export type AuthPhase =
  | 'preparing'
  | 'waiting-scan'
  | 'scanned'
  | 'waiting-confirm'
  | 'verification-required'
  | 'credentials-required'
  | 'authorized'
  | 'expired'
  | 'failed'
  | 'cancelled';

/** Coarse public auth state, kept M1-compatible (doc §15). */
export type AuthState = 'pending' | 'authenticated' | 'expired' | 'failed';

/**
 * Structured QR payload (doc §17). Replaces the ambiguous bare string:
 * a value is either opaque content to render, a ready-made data URL, or an
 * external URL to open.
 */
export interface PublicQrPayload {
  kind: 'content' | 'data-url' | 'external-url';
  value: string;
  expiresAt?: number;
}

/** Structured user-facing prompt associated with a phase (doc §16). */
export interface PublicAuthPrompt {
  kind:
    | 'verification-code'
    | 'confirm-on-phone'
    | 'credentials-required'
    | 'open-browser';
  message?: string;
}

/** Public auth status returned by polling (doc §16). */
export interface PublicAuthStatus {
  state: AuthState;
  phase: AuthPhase;
  prompt?: PublicAuthPrompt;
  expiresAt?: number;
  detail?: string;
}

/**
 * Browser-facing session (doc §18). It NEVER contains secrets, tokens, the
 * provider challenge or any provider payload. Build it exclusively through
 * auth/sanitizer.ts.
 */
export interface PublicAuthSession {
  id: string;
  channelId: string;
  state: AuthState;
  phase: AuthPhase;
  qr?: PublicQrPayload;
  expiresAt?: number;
  prompt?: PublicAuthPrompt;
}

/**
 * Host-only full session (doc §18). Holds the AbortController and opaque
 * provider state. Must never be serialized to the browser.
 */
export interface InternalAuthSession {
  id: string;
  channelId: string;
  accountId: string;
  provider: string;
  createdAt: number;
  expiresAt: number;
  pollingIntervalMs: number;
  nextPollAt: number;
  deviceCode?: string;
  challenge?: unknown;
  abortController: AbortController;
  providerState: unknown;
}

/** Input that begins an auth flow (doc §14/§19). */
export interface AuthBeginInput {
  method: AuthMethod;
  accountId?: string;
}

/**
 * What a definition's [ChannelDefinition.beginAuth] returns (doc §14/§19).
 * Provider-specific and host-only. [providerState] is opaque and handed back
 * verbatim to [ChannelDefinition.pollAuth] / [ChannelDefinition.submitAuthInput].
 */
export interface AuthProviderSession {
  provider: string;
  expiresAt: number;
  pollingIntervalMs: number;
  qr?: PublicQrPayload;
  prompt?: PublicAuthPrompt;
  deviceCode?: string;
  /** Opaque provider state; pollAuth/submitAuthInput receive this object back. */
  providerState: unknown;
}

/** Auth input submitted during a flow (e.g. a verification code). */
export interface AuthInput {
  kind: 'verification-code';
  value: string;
}

/** One selectable setup field of a channel (doc §29). */
export interface ChannelSetupField {
  name: string;
  kind: 'text' | 'secret';
  secret: boolean;
  configured: boolean;
  writable: boolean;
  /**
   * Credential reference name for secret fields (doc §31). The web layer
   * never sees this — the control plane maps a field name to its ref and
   * calls ctx.credentials. Non-secret fields omit it.
   */
  ref?: string;
  /**
   * Current value for NON-secret fields only (doc §29). Populated dynamically
   * by ChannelControlService.getSetup from ConfiguredState; secret fields never
   * carry it, and static definition.setup.fields leave it undefined.
   */
  value?: string;
}

/** Static setup descriptor advertising a channel's editable surface (doc §29). */
export interface ChannelSetupDescriptor {
  fields: ChannelSetupField[];
  authMethods: AuthMethod[];
  /** Optional official console where users obtain the required credentials. */
  setupUrl?: string;
}

/** One-shot setup payload used by the Web form. Secret values stay host-side. */
export interface ChannelSetupInput {
  config: Record<string, unknown>;
  credentials: Record<string, string>;
}

/** Result of saving setup and reconciling the channel runtime. */
export interface ChannelSetupResult {
  configured: boolean;
  connection: ChannelRuntimeStatus['connection'];
}

/**
 * Dynamic configured state: never returns secret values (doc §14/§29).
 * Per-field `value` carries non-secret config values only (e.g. appId/clientId);
 * secret fields never set it.
 */
export interface ConfiguredState {
  configured: boolean;
  fields: Record<string, { configured: boolean; writable: boolean; source?: string; value?: string }>;
}

/**
 * Runtime status of one mounted (or not) channel (doc §60 / ChannelSummary).
 */
export interface ChannelRuntimeStatus {
  mounted: boolean;
  running: boolean;
  connection: 'connected' | 'degraded' | 'disconnected' | 'unknown';
  health?: ChannelHealth | null;
  lastError?: string | null;
}

/** Row returned by [ChannelControlService.listChannels] (doc §29). */
export interface ChannelSummary {
  id: string;
  configured: boolean;
  enabled: boolean;
  mounted: boolean;
  runtime: 'running' | 'stopped';
  connection: 'connected' | 'degraded' | 'disconnected' | 'unknown';
}

/**
 * One channel's setup/authorization/instantiation spec (doc §14). Platform
 * differences stop here: channel-control drives channels purely through this
 * interface, never through per-channel conditionals.
 */
export interface ChannelDefinition {
  id: string;
  /** Whether the channel is enabled in configuration (doc §29 ChannelSummary.enabled). */
  enabled: boolean;
  /** Static setup descriptor (fields + authMethods). */
  setup: ChannelSetupDescriptor;
  /**
   * Dynamic configured state: reads config + credential describe().
   * NEVER returns secret values.
   */
  getConfiguredState(): Promise<ConfiguredState>;
  /**
   * Persist a non-secret config patch. Secret field names are rejected by the
   * control plane before reaching the definition (see saveConfig rules).
   */
  saveConfig(patch: Record<string, unknown>): Promise<void>;
  /** Begin an auth session (optional: channels without provider auth omit). */
  beginAuth?(input: AuthBeginInput): Promise<AuthProviderSession>;
  /** Poll a provider session (optional). Receives the SAME AuthProviderSession returned by beginAuth. */
  pollAuth?(session: AuthProviderSession): Promise<PublicAuthStatus>;
  /** Submit auth input (verification code etc.) (optional). */
  submitAuthInput?(
    session: AuthProviderSession,
    input: AuthInput,
  ): Promise<PublicAuthStatus> | void;
  /** Build the adapter; resolves credentials itself via the injected credentials seam. */
  createAdapter(): Promise<ChannelAdapter>;
  /** Whether this channel should auto-mount when configured (headless, doc §27). Default true. */
  autoStart?: boolean;
}

export type { ChannelAdapter, ChannelHealth };
