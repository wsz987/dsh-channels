/**
 * QQ upstream driver — the only module that knows the HTTP endpoints.
 *
 * The upstream is SDK-agnostic: an official QQ platform SDK can slot in later
 * behind this same interface. The gateway owns platform credentials; the
 * adapter never sees or logs them (architecture §21 / red line 3).
 *
 * Endpoints (protocol-level, self-hosted gateway):
 * - GET  /stream         — long-poll for inbound payloads
 * - POST /message/send   — plain text message
 * - POST /message/media  — media (e.g. image) message
 * - GET  /qrcode         — request a fresh QR login challenge
 * - GET  /auth/status    — poll the current QR auth state
 */
import type { HttpTransport } from './transport.js';

/** Login payload returned by the QR endpoint. */
export interface AuthChallengePayload {
  qrUrl: string;
  expiresAt: number;
}

export type QQAuthStatus =
  | 'pending'
  | 'authenticated'
  | 'expired'
  | 'failed';

export interface PollAuthResult {
  state: QQAuthStatus;
  /** User id reported by the gateway after a successful scan. */
  userId?: string;
  detail?: string;
}

/** A media reference for outbound sends. */
export interface QQMedia {
  type: string;
  url: string;
}

export interface QQUpstream {
  /** Request a fresh QR login challenge. */
  login(): Promise<AuthChallengePayload>;

  /** Poll the current auth state. */
  pollAuth(): Promise<PollAuthResult>;

  /**
   * Long-poll for inbound messages until `signal` aborts. Each raw message is
   * passed to `onMessage` as received (unstructured — the mapper owns shape).
   */
  receive(
    signal: AbortSignal,
    onMessage: (raw: unknown) => void,
  ): Promise<void>;

  /** Send a text message; resolves with the gateway response. */
  sendText(to: string, text: string): Promise<unknown>;

  /** Send a media reference (e.g. an image url). */
  sendMedia(to: string, media: QQMedia): Promise<unknown>;
}

export interface HttpQQUpstreamOptions {
  transport: HttpTransport;
  longPollTimeoutMs: number;
}

/** HTTP implementation over a self-hosted qq gateway. */
export class HttpQQUpstream implements QQUpstream {
  constructor(private readonly options: HttpQQUpstreamOptions) {}

  login(): Promise<AuthChallengePayload> {
    return this.options.transport.request('/qrcode').then((raw) => {
      const payload = raw as Partial<AuthChallengePayload>;
      return {
        qrUrl: payload.qrUrl ?? '',
        expiresAt: payload.expiresAt ?? 0,
      };
    });
  }

  pollAuth(): Promise<PollAuthResult> {
    return this.options.transport.request('/auth/status').then((raw) => {
      const value = raw as Partial<PollAuthResult>;
      return {
        state: (value.state as QQAuthStatus) ?? 'pending',
        userId: value.userId,
        detail: value.detail,
      };
    });
  }

  async receive(
    signal: AbortSignal,
    onMessage: (raw: unknown) => void,
  ): Promise<void> {
    while (!signal.aborted) {
      let raw: unknown;
      try {
        raw = await this.options.transport.request(
          '/stream',
          { timeoutMs: this.options.longPollTimeoutMs },
          signal,
        );
      } catch (error) {
        // Abort-driven teardown exits gracefully; other failures propagate to
        // the adapter, which owns reconnect/backoff.
        if (signal.aborted) return;
        throw error;
      }
      if (raw && typeof raw === 'object' && !signal.aborted) {
        onMessage(raw);
      }
    }
  }

  sendText(to: string, text: string): Promise<unknown> {
    return this.options.transport.request('/message/send', {
      method: 'POST',
      body: { to, type: 'text', content: text },
    });
  }

  sendMedia(to: string, media: QQMedia): Promise<unknown> {
    return this.options.transport.request('/message/media', {
      method: 'POST',
      body: { to, type: media.type, url: media.url },
    });
  }
}
