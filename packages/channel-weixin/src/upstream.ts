/**
 * Weixin upstream driver — the only module that knows the HTTP endpoints.
 *
 * SDK/package changes stay isolated behind this interface (architecture §21);
 * the adapter depends on `WeixinUpstream`, never on HTTP paths.
 */
import type { HttpTransport } from './transport.js';

/** Login payload returned by the QR endpoint. */
export interface AuthChallengePayload {
  qrUrl: string;
  expiresAt: number;
}

export type WeixinAuthStatus =
  | 'pending'
  | 'authenticated'
  | 'expired'
  | 'failed';

export interface PollAuthResult {
  state: WeixinAuthStatus;
  /** Sender id reported by the gateway after a successful scan. */
  userId?: string;
  detail?: string;
}

export interface WeixinUpstream {
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

  /** Send a media reference; optional until media support lands. */
  sendMedia?(to: string, media: { type: string; url: string }): Promise<unknown>;
}

export interface HttpWeixinUpstreamOptions {
  transport: HttpTransport;
  longPollTimeoutMs: number;
}

/** HTTP implementation over a self-hosted weixin gateway. */
export class HttpWeixinUpstream implements WeixinUpstream {
  constructor(private readonly options: HttpWeixinUpstreamOptions) {}

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
        state: (value.state as WeixinAuthStatus) ?? 'pending',
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
          '/messages/long-poll',
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

  sendMedia(to: string, media: { type: string; url: string }): Promise<unknown> {
    return this.options.transport.request('/message/send', {
      method: 'POST',
      body: { to, type: media.type, content: media.url },
    });
  }
}
