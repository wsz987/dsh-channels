/**
 * <ChannelName> upstream driver — the only module that knows the HTTP
 * endpoints (or the platform SDK).
 *
 * The upstream is SDK-agnostic: an official platform SDK can slot in later
 * behind this same interface. The gateway owns platform credentials; the
 * adapter never sees or logs them (architecture §21 / red line 3).
 *
 * Endpoints (protocol-level, self-hosted gateway — adjust per platform):
 * - GET  /stream          — long-poll for inbound payloads
 * - POST /message/send    — plain text message
 * - POST /message/media   — media (e.g. image) message
 */
import type { HttpTransport } from './transport.js';

/** A media reference for outbound sends. */
export interface ChannelMedia {
  type: string;
  url: string;
}

export interface ChannelUpstream {
  /** Connect / prepare the upstream connection. */
  start(): Promise<void>;

  /** Close the upstream connection; must be idempotent. */
  stop(): Promise<void>;

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
  sendMedia(to: string, media: ChannelMedia): Promise<unknown>;
}

export interface HttpChannelUpstreamOptions {
  transport: HttpTransport;
  longPollTimeoutMs: number;
}

/** HTTP implementation over a self-hosted gateway. */
export class HttpChannelUpstream implements ChannelUpstream {
  constructor(private readonly options: HttpChannelUpstreamOptions) {}

  async start(): Promise<void> {
    // Reserved for connection setup (e.g. websocket open, session handshake).
  }

  async stop(): Promise<void> {
    // Reserved for connection teardown.
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

  sendMedia(to: string, media: ChannelMedia): Promise<unknown> {
    return this.options.transport.request('/message/media', {
      method: 'POST',
      body: { to, type: media.type, url: media.url },
    });
  }
}
