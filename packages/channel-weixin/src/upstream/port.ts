/**
 * port.ts — DSH-side minimal upstream interface (execution plan §15/§7).
 *
 * `WeixinUpstream` is the ONLY surface the Weixin adapter depends on. It is a
 * thin, protocol-agnostic port: the adapter no longer knows AES keys,
 * getuploadurl payloads, CDN query assembly, or iLink endpoints (plan DoD #1) —
 * those all live inside the DSH-hosted source-port implementation
 * (tencent-upstream.ts).
 *
 * Design constraints (plan §7):
 *   - method count stays small — only what DSH genuinely consumes;
 *   - no token/retry/reconnect/AES/upload-algorithm logic here — pure shape;
 *   - a capability that the upstream cannot yet provide is surfaced as a
 *     typed `UpstreamCapabilityError` — NEVER faked.
 */
import type { ChannelAdapterContext } from '@wsz987/channel-core';
import type { SecretStore, ChannelStorage } from '@wsz987/channel-core';

/** Uniform upstream-facing QR state (normalizes the Weixin iLink machine). */
export type QrAuthState = 'pending' | 'authenticated' | 'expired' | 'failed';

/** A QR login ticket handed to the operator. */
export interface WeixinQrTicket {
  /** Stable ticket id used by later pollQrAuth calls. */
  id: string;
  /** QR payload (URL or data:image) for the operator to scan/render. */
  qrUrl?: string;
  /** Short human instruction (e.g. "scan with WeChat"). */
  instruction?: string;
  /** Expiry instant (ms epoch). */
  expiresAt?: number;
}

/** Credential produced once a QR login is confirmed. */
export interface WeixinAuthCredential {
  token: string;
  ilinkBotId: string;
  userId?: string;
  baseUrl: string;
}

/** One QR auth poll result. */
export interface WeixinQrAuthPoll {
  state: QrAuthState;
  detail?: string;
  /** Present only when `state === 'authenticated'`. */
  credential?: WeixinAuthCredential;
}

/** Context referencing a Weixin media resource for download. */
export interface WeixinMediaRef {
  /** CDN base URL override (derives a download URL when no fullUrl). */
  cdnBaseUrl?: string;
  /** Server-returned full_url (preferred carrier). */
  fullUrl?: string;
  /** `encrypt_query_param` when the CDN URL must be derived. */
  encryptQueryParam?: string;
  /** AES-128 key as 16-byte HEX (image item `aeskey`), preferred. */
  aesKeyHex?: string;
  /** AES-128 key as base64 (CDN media `aes_key`). */
  aesKeyBase64?: string;
  /** MIME hint (image/jpeg …) when known from item metadata. */
  mimeType?: string;
}

/** Result of a media download. */
export interface WeixinDownloadResult {
  /** Plaintext (decrypted) bytes. */
  data: Uint8Array;
  mimeType?: string;
}

/** Target for an outbound send + optional turn correlation. */
export interface WeixinSendTarget {
  to: string;
  contextToken?: string;
  runId?: string;
}

export interface WeixinTextParams extends WeixinSendTarget {
  text: string;
}

export interface WeixinImageParams extends WeixinSendTarget {
  /** Plaintext image bytes. */
  data: Uint8Array;
  mimeType?: string;
}

export interface WeixinFileParams extends WeixinSendTarget {
  data: Uint8Array;
  fileName: string;
  mimeType?: string;
}

export interface WeixinVideoParams extends WeixinSendTarget {
  data: Uint8Array;
  mimeType?: string;
}

/** Result of one outbound send. */
export interface WeixinSendResult {
  messageId?: string;
  delivered: boolean;
}

/**
 * Upstream resources wired once by the host (adapter) at start. Provides the
 * harness seam the monitor needs (emit/dispatch, signal, logger) and the store
 * boundaries for credentials / sync-cursor / context-token / dedup.
 */
export interface WeixinUpstreamHostEnv {
  ctx: ChannelAdapterContext;
  secrets: SecretStore;
  storage: ChannelStorage;
  /** Optional connection-state callback (monitor health → adapter/heartbeat). */
  onConnectionChange?: (state: 'connected' | 'reconnecting' | 'disconnected') => void;
}

/**
 * The DSH-side upstream port implemented by TencentWeixinUpstream.
 */
export interface WeixinUpstream {
  readonly id: 'weixin';

  /** Begin a WeChat QR login; returns a fresh ticket. */
  beginQrAuth(): Promise<WeixinQrTicket>;
  /** Poll the active QR ticket. */
  pollQrAuth(ticketId: string): Promise<WeixinQrAuthPoll>;
  /** Submit a phone-verify code for the active QR ticket (adapter-specific). */
  submitVerifyCode(code: string): void;

  /** Start the getUpdates monitor; requires the host env to be bound first. */
  startMonitor(): Promise<void>;
  /** Stop the getUpdates monitor (best effort). */
  stopMonitor(): Promise<void>;

  /** Send a text message. */
  sendText(params: WeixinTextParams): Promise<WeixinSendResult>;
  /** Send an image message (uploads plaintext bytes, sends an image item). */
  sendImage(params: WeixinImageParams): Promise<WeixinSendResult>;
  /** Send a file message. */
  sendFile(params: WeixinFileParams): Promise<WeixinSendResult>;
  /** Send a video message. */
  sendVideo(params: WeixinVideoParams): Promise<WeixinSendResult>;

  /** Download + decrypt an inbound image (zero-change with legacy download). */
  downloadImage(ref: WeixinMediaRef): Promise<WeixinDownloadResult>;
  /** Download + decrypt an inbound file. */
  downloadFile(ref: WeixinMediaRef): Promise<WeixinDownloadResult>;
  /** Download + decrypt an inbound audio attachment. */
  downloadAudio(ref: WeixinMediaRef, options?: { encodeType?: number; sampleRate?: number }): Promise<WeixinDownloadResult>;
  /** Download + decrypt an inbound video attachment. */
  downloadVideo(ref: WeixinMediaRef): Promise<WeixinDownloadResult>;

  /** True when the bound credential is present and non-empty. */
  hasCredential(): boolean;
}

/**
 * A typed capability error: the requested operation is not (yet) provided by
 * the upstream. Thrown instead of fabricating support (plan §15 — "do not fake
 * support").
 */
export class UpstreamCapabilityError extends Error {
  /** Which capability is missing. */
  readonly capability: string;

  constructor(capability: string, reason: string) {
    super(`weixin upstream capability '${capability}' is unavailable: ${reason}`);
    this.name = 'UpstreamCapabilityError';
    this.capability = capability;
  }
}
