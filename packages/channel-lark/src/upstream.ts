/**
 * Lark upstream driver — the only module that knows the HTTP endpoints.
 *
 * The upstream is SDK-agnostic: the official Lark SDK can slot in later behind
 * this same interface. The gateway owns platform credentials; the adapter
 * never sees or logs them (architecture §21 / red line 3).
 *
 * Endpoints (protocol-level, self-hosted gateway):
 * - GET  /stream        — long-poll for inbound payloads
 * - POST /message/send  — plain text / media message (non-streaming fallback)
 * - POST /card/create   — create an editable card with initial content
 * - POST /card/update   — update the card body (status 'update')
 * - POST /card/finish   — finalize the card (status 'finished')
 * - POST /card/fail     — mark the card failed (status 'failed')
 */
import type { HttpTransport } from './transport.js';

/** Card create response: the gateway-issued card id. */
export interface CardCreateResult {
  cardId: string;
}

/** Minimal media reference for the basic outbound image send. */
export interface LarkMediaRef {
  type: 'image';
  url?: string;
  dataUri?: string;
  name?: string;
  /** Human-readable description; used as the send name when `name` is absent. */
  alt?: string;
}

/**
 * Outbound-only surface: message send + editable card operations. Both the
 * legacy HTTP gateway driver (`HttpLarkUpstream`) and the official OpenAPI
 * driver (`LarkOpenApiOutbound`) implement this. The inbound leg is kept
 * separate so SDK mode can pair the official WS inbound with the official
 * OpenAPI outbound — no localhost gateway (release plan R7B).
 */
export interface LarkOutbound {
  /** Send a plain text message (buffered fallback). */
  sendText(to: string, text: string): Promise<unknown>;

  /** Send a basic media message (e.g. a plain image). */
  sendMedia(to: string, media: LarkMediaRef): Promise<unknown>;

  /** Create an editable card in the given conversation with initial content. */
  createCard(conversationId: string, text: string): Promise<CardCreateResult>;

  /** Update an editable card's body text. */
  updateCard(cardId: string, text: string): Promise<unknown>;

  /** Finalize an editable card. */
  finishCard(cardId: string): Promise<unknown>;

  /** Mark an editable card as failed, optionally with a reason. */
  failCard(cardId: string, reason?: string): Promise<unknown>;
}

/** Full upstream driver: inbound receive + outbound (extends {@link LarkOutbound}). */
export interface LarkUpstream extends LarkOutbound {
  /**
   * Long-poll for inbound payloads until `signal` aborts. Each raw payload is
   * passed to `onMessage` as received (unstructured — the mapper owns shape).
   */
  receive(
    signal: AbortSignal,
    onMessage: (raw: unknown) => void,
  ): Promise<void>;
}

export interface HttpLarkUpstreamOptions {
  transport: HttpTransport;
  longPollTimeoutMs: number;
}

/** HTTP implementation over a self-hosted lark gateway. */
export class HttpLarkUpstream implements LarkUpstream {
  constructor(private readonly options: HttpLarkUpstreamOptions) {}

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

  sendMedia(to: string, media: LarkMediaRef): Promise<unknown> {
    return this.options.transport.request('/message/send', {
      method: 'POST',
      body: {
        to,
        type: 'image',
        url: media.url ?? media.dataUri,
        name: media.name ?? media.alt,
      },
    });
  }

  createCard(conversationId: string, text: string): Promise<CardCreateResult> {
    return this.options.transport
      .request('/card/create', {
        method: 'POST',
        body: { conversationId, text },
      })
      .then((raw) => {
        const payload = raw as Partial<CardCreateResult>;
        return { cardId: payload.cardId ?? '' };
      });
  }

  updateCard(cardId: string, text: string): Promise<unknown> {
    return this.options.transport.request('/card/update', {
      method: 'POST',
      body: { cardId, text },
    });
  }

  finishCard(cardId: string): Promise<unknown> {
    return this.options.transport.request('/card/finish', {
      method: 'POST',
      body: { cardId },
    });
  }

  failCard(cardId: string, reason?: string): Promise<unknown> {
    return this.options.transport.request('/card/fail', {
      method: 'POST',
      body: { cardId, reason },
    });
  }
}
