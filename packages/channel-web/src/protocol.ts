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
