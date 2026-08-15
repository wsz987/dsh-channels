/**
 * @wsz987/channel-web — client-safe DTO types shared across the host API and
 * the Web client ("protocol").
 *
 * These are deliberately plain, serialisable wire types. They never carry
 * secrets or adapter-internal payloads; anything that would leak a credential
 * is intentionally omitted. The client half does not typecheck against these
 * via tsc (it is bundled by esbuild), but keeping them here documents the
 * exact shape the host API promises and gives M1 a stable contract.
 */

/** Public view of one channel for the Web dashboard. */
export interface ChannelView {
  /** Stable adapter / channel id (e.g. "weixin"). */
  id: string;
  /** Whether the channel is enabled in configuration. */
  enabled: boolean;
  /** Whether credentials are configured. */
  configured: boolean;
  /** Whether the adapter is currently mounted for this process. */
  mounted: boolean;
  /** Free-form status string, e.g. "connected" | "disconnected". */
  status: string;
  /** Optional health summary when the adapter exposes getHealth. */
  health?: ChannelHealthView | null;
  /** Adapter capability flags relevant to the dashboard. */
  capabilities?: {
    send?: boolean;
    receive?: boolean;
    auth?: boolean;
    streaming?: boolean;
    [key: string]: boolean | string | undefined;
  } | null;
  /** Sanitised last error message; never a raw secret/credential. */
  lastError?: string | null;
}

/** Client-safe projection of ChannelHealth (never a credential). */
export interface ChannelHealthView {
  status: 'ok' | 'degraded' | 'down' | 'unknown';
  detail?: string | null;
  connection?: boolean | null;
  authenticated?: boolean | null;
}

/** Public QR auth challenge — never includes the adapter's private payload. */
export interface PublicAuthChallenge {
  /** Stable challenge id used to poll/complete this flow. */
  id: string;
  /** Human-readable instruction. */
  instruction: string;
  /** Optional QR image as a data URL or URL for the dialog. */
  qrUrl?: string | null;
  /** Optional expiry epoch ms. */
  expiresAt?: number | null;
}

/** Public auth-flow poll response. */
export interface PublicAuthPoll {
  /** Flow state. */
  state: 'pending' | 'authenticated' | 'expired' | 'failed';
  /** Human-readable detail when the state is not pending. */
  detail?: string | null;
  /** Optional hint the UI should surface (e.g. "enter verification code"). */
  prompt?: string | null;
}

/** Request body for the verification-code (auth/input) endpoint. */
export interface PublicAuthInput {
  kind: 'verification-code';
  value: string;
}

/** Standard structured error body returned by the host API. */
export interface PublicError {
  error: {
    code: string;
    message: string;
  };
}

// ----------------------------------------------------------------------------
// v2 control-plane DTOs (doc §28–§33). The web client builds these from
// /dsh-channels/api/v2 responses; they NEVER carry credential values or refs.
// The ChannelControlService maps a field name to its credential ref server-side,
// so the wire never leaks a ref or a secret value (doc §31).
// ----------------------------------------------------------------------------

/** How a channel begins an authorization flow (doc §15). */
export type AuthMethod = 'qr' | 'device' | 'portal-login' | 'credentials' | 'hybrid';

/** Fine-grained progress of an auth flow (doc §15/§16). */
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

/** Structured QR payload (doc §17): opaque content, data URL, or external URL. */
export interface PublicQrPayload {
  kind: 'content' | 'data-url' | 'external-url';
  value: string;
  expiresAt?: number | null;
}

/** Structured user-facing prompt associated with a phase (doc §16). */
export interface PublicAuthPrompt {
  kind: 'verification-code' | 'confirm-on-phone' | 'credentials-required' | 'open-browser';
  message?: string | null;
}

/** Public auth status returned by polling (doc §16). */
export interface PublicAuthStatus {
  state: AuthState;
  phase: AuthPhase;
  prompt?: PublicAuthPrompt | null;
  expiresAt?: number | null;
  detail?: string | null;
}

/** Browser-facing auth session (doc §18). Never contains secret values. */
export interface PublicAuthSession {
  id: string;
  channelId: string;
  state: AuthState;
  phase: AuthPhase;
  qr?: PublicQrPayload | null;
  expiresAt?: number | null;
  prompt?: PublicAuthPrompt | null;
}

/** Input that begins an auth flow (doc §14/§19). */
export interface AuthBeginInput {
  method: AuthMethod;
  accountId?: string;
}

/** Auth input submitted during a flow (e.g. a verification code). */
export interface AuthInput {
  kind: 'verification-code';
  value: string;
}

/** One selectable setup field of a channel. Secret refs are never exposed. */
export interface ChannelSetupField {
  name: string;
  kind: 'text' | 'secret';
  secret: boolean;
  configured: boolean;
  writable: boolean;
}

/** Static setup descriptor advertising a channel's editable surface (doc §29). */
export interface ChannelSetupDescriptor {
  fields: ChannelSetupField[];
  authMethods: AuthMethod[];
  setupUrl?: string;
}

/** Dynamic configured state: never returns secret values (doc §14/§29). */
export interface ConfiguredState {
  configured: boolean;
  fields: Record<string, { configured: boolean; writable: boolean; source?: string }>;
}

/** Row returned by GET /v2/channels (doc §29). */
export interface ChannelSummary {
  id: string;
  configured: boolean;
  enabled: boolean;
  mounted: boolean;
  runtime: 'running' | 'stopped';
  connection: 'connected' | 'degraded' | 'disconnected' | 'unknown';
}
