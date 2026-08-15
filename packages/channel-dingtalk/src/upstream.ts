/**
 * DingTalk HTTP upstream driver — the only module that knows the HTTP
 * endpoints (self-hosted gateway protocol).
 *
 * Two drivers implement the shared `DingTalkUpstream` interface:
 * - `HttpDingTalkUpstream` (this file) — long-poll inbound + HTTP outbound
 *   against the self-hosted gateway. The gateway owns platform credentials;
 *   the adapter never sees or logs them (architecture §21 / red line 3).
 * - `DingTalkStreamUpstream` (stream-upstream.ts) — inbound via the official
 *   `dingtalk-stream` SDK; outbound delegates to a separately injected driver.
 * - `DingTalkOfficialUpstream` (official-upstream.ts) — SDK-mode outbound via
 *   the message-scoped webhook and DingTalk AI Card OpenAPI.
 *
 * Endpoints (protocol-level, self-hosted gateway):
 * - GET  /stream        — long-poll for inbound payloads
 * - POST /message/send  — plain text message (non-streaming fallback)
 * - POST /card/create   — create an AI Card with initial content
 * - POST /card/update   — update the card body (status 'update')
 * - POST /card/finish   — finalize the card (status 'finished')
 * - POST /card/fail     — mark the card failed (status 'failed')
 */
import type { ChannelTarget } from '@wsz987/channel-core';
import type { HttpTransport } from './transport.js';

/** Card create response: the gateway-issued card id. */
export interface CardCreateResult {
  cardId: string;
}

export interface DingTalkUpstream {
  /**
   * Long-poll for inbound messages until `signal` aborts. Each raw message is
   * passed to `onMessage` as received (unstructured — the mapper owns shape).
   */
  receive(
    signal: AbortSignal,
    onMessage: (raw: unknown) => void,
  ): Promise<void>;

  /** Send a plain text message (buffered fallback). */
  sendText(target: ChannelTarget, text: string): Promise<unknown>;

  /** Create an AI Card in the given conversation with initial content. */
  createCard(target: ChannelTarget, text: string): Promise<CardCreateResult>;

  /** Update an AI Card's body text. */
  updateCard(cardId: string, text: string): Promise<unknown>;

  /** Finalize an AI Card. */
  finishCard(cardId: string, text?: string): Promise<unknown>;

  /** Mark an AI Card as failed, optionally with a reason. */
  failCard(cardId: string, reason?: string): Promise<unknown>;
}

export interface HttpDingTalkUpstreamOptions {
  transport: HttpTransport;
  longPollTimeoutMs: number;
}

/** HTTP implementation over a self-hosted dingtalk gateway. */
export class HttpDingTalkUpstream implements DingTalkUpstream {
  constructor(private readonly options: HttpDingTalkUpstreamOptions) {}

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

  sendText(target: ChannelTarget, text: string): Promise<unknown> {
    return this.options.transport.request('/message/send', {
      method: 'POST',
      body: { to: target.conversationId, type: 'text', content: text },
    });
  }

  createCard(target: ChannelTarget, text: string): Promise<CardCreateResult> {
    return this.options.transport
      .request('/card/create', {
        method: 'POST',
        body: { conversationId: target.conversationId, text },
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
