/**
 * Telegram upstream driver — the only module that knows the Bot API.
 *
 * The upstream is SDK-agnostic: it speaks the Telegram Bot API HTTP protocol
 * directly (`/bot<token>/...`), so no SDK dependency is required (manifest
 * strategy 'source'). The token only ever appears in the request path built
 * here; it is never logged and never cached beyond the config value.
 *
 * Long-poll semantics: every getUpdates call carries the acknowledged offset,
 * so Telegram stops redelivering confirmed updates (the offset IS the
 * protocol-level dedup mechanism). The InboundProcessor dedup window is the
 * adapter-level second layer for webhook-style redelivery inside one cycle.
 */
import { ChannelAuthError, ChannelError } from '@wsz987/channel-core';
import { z } from 'zod';
import type { HttpTransport } from './transport.js';

/** Bot user returned by getMe. */
export interface TelegramBotUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

/** A media reference for outbound sends. */
export interface TelegramMedia {
  type: 'image' | 'file' | 'audio' | 'video';
  /** Public URL or a Telegram file_id. */
  url: string;
  caption?: string;
}

export interface TelegramUpstream {
  /** Auth check; resolves with the bot user or throws on 401/invalid token. */
  getMe(): Promise<TelegramBotUser>;

  /**
   * Long-poll getUpdates until `signal` aborts. Each update is passed to
   * `onUpdate` as received (unstructured — the mapper owns shape); the
   * acknowledged offset advances past every forwarded update so the next poll
   * never redelivers confirmed updates.
   */
  getUpdates(
    offset: number,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
  ): Promise<void>;

  /** Send a text message; resolves with the Bot API response. */
  sendText(chatId: string, text: string): Promise<unknown>;

  /** Send a media reference (image/file/audio/video). */
  sendMedia(chatId: string, media: TelegramMedia): Promise<unknown>;
}

export interface HttpTelegramUpstreamOptions {
  transport: HttpTransport;
  /** Bot API token; only ever placed in request paths. */
  token?: string;
  longPollTimeoutMs: number;
}

/**
 * Bot API envelope shared by every method: `{ ok, result?, error_code?,
 * description? }`. Validated with zod (not hand-rolled casts) at the upstream
 * boundary, matching the official adapters' response-validation pattern.
 */
const apiResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().optional(),
  description: z.string().optional(),
}).passthrough();

/** `getMe` result: the bot user. */
const botUserSchema = z.object({
  id: z.number(),
  is_bot: z.boolean(),
  first_name: z.string().optional(),
  username: z.string().optional(),
}).passthrough();

/** `getUpdates` result: a list of raw updates (shape owned by the mapper). */
const getUpdatesResultSchema = z.array(z.unknown());

/** HTTP implementation over the Telegram Bot API. */
export class HttpTelegramUpstream implements TelegramUpstream {
  constructor(private readonly options: HttpTelegramUpstreamOptions) {}

  private path(endpoint: string): string {
    return `/bot${this.options.token ?? ''}/${endpoint}`;
  }

  async getMe(): Promise<TelegramBotUser> {
    const envelope = apiResponseSchema.safeParse(await this.options.transport.request(this.path('getMe')));
    if (!envelope.success) {
      throw new ChannelError('CHANNEL_ERROR', 'telegram getMe returned an invalid response');
    }
    if (!envelope.data.ok) {
      if (envelope.data.error_code === 401) {
        throw new ChannelAuthError('telegram getMe rejected: invalid bot token');
      }
      throw new ChannelError('CHANNEL_ERROR', `telegram getMe failed: ${envelope.data.description ?? 'unknown error'}`);
    }
    const user = botUserSchema.safeParse(envelope.data.result);
    if (!user.success) {
      throw new ChannelError('CHANNEL_ERROR', 'telegram getMe returned no bot user');
    }
    return user.data;
  }

  async getUpdates(
    offset: number,
    signal: AbortSignal,
    onUpdate: (update: unknown) => void,
  ): Promise<void> {
    while (!signal.aborted) {
      let raw: unknown;
      try {
        raw = await this.options.transport.request(
          this.path('getUpdates'),
          {
            method: 'POST',
            body: {
              offset,
              // Telegram's long-poll timeout parameter is in seconds; the
              // HTTP request timeout must exceed it so the fetch outlives
              // the poll window.
              timeout: Math.max(1, Math.floor(this.options.longPollTimeoutMs / 1000)),
              allowed_updates: ['message'],
            },
            timeoutMs: this.options.longPollTimeoutMs + 5000,
          },
          signal,
        );
      } catch (error) {
        // Abort-driven teardown exits gracefully; other failures propagate to
        // the adapter, which owns reconnect/backoff.
        if (signal.aborted) return;
        throw error;
      }
      const envelope = apiResponseSchema.safeParse(raw);
      const result = envelope.success && envelope.data.ok
        ? getUpdatesResultSchema.safeParse(envelope.data.result ?? [])
        : null;
      if (!result?.success) {
        throw new ChannelError('CHANNEL_ERROR', 'telegram getUpdates returned an invalid response');
      }
      for (const update of result.data) {
        if (signal.aborted) return;
        onUpdate(update);
        const updateId = (update as { update_id?: number })?.update_id;
        if (typeof updateId === 'number') {
          // Acknowledge: the next poll starts after the highest seen update.
          offset = Math.max(offset, updateId + 1);
        }
      }
    }
  }

  sendText(chatId: string, text: string): Promise<unknown> {
    return this.post('sendMessage', { chat_id: chatId, text });
  }

  sendMedia(chatId: string, media: TelegramMedia): Promise<unknown> {
    switch (media.type) {
      case 'image':
        return this.post('sendPhoto', this.mediaBody(chatId, media, 'photo'));
      case 'file':
        return this.post('sendDocument', this.mediaBody(chatId, media, 'document'));
      case 'audio':
        return this.post('sendAudio', this.mediaBody(chatId, media, 'audio'));
      case 'video':
        return this.post('sendVideo', this.mediaBody(chatId, media, 'video'));
      default:
        // Exhaustive over TelegramMedia['type']; kept for safety.
        throw new ChannelError(
          'CHANNEL_UNSUPPORTED',
          `telegram media type '${String(media.type)}' unsupported`,
        );
    }
  }

  private mediaBody(chatId: string, media: TelegramMedia, field: string): Record<string, unknown> {
    const body: Record<string, unknown> = { chat_id: chatId, [field]: media.url };
    if (media.caption !== undefined) body.caption = media.caption;
    return body;
  }

  private post(endpoint: string, body: unknown): Promise<unknown> {
    return this.options.transport.request(this.path(endpoint), { method: 'POST', body });
  }
}
