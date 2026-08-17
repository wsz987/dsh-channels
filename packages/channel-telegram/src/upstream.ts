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
import {
  ChannelAuthError,
  ChannelError,
  mimeHintFromFilename,
  normalizeMimeHint,
} from '@wsz987/channel-core';
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
  url?: string;
  /** Trusted bytes uploaded as multipart/form-data. */
  localData?: Uint8Array;
  mimeType?: string;
  name?: string;
  caption?: string;
}

export interface TelegramSendOptions {
  replyToMessageId?: string;
  messageThreadId?: string;
}

/** Parsed sendMessage result (only the fields the reply engine needs). */
export interface TelegramSentMessage {
  messageId: string;
  /** Full Bot API envelope, kept for diagnostics. */
  raw: unknown;
}

/** Parsed getFile result. */
export interface TelegramFileInfo {
  fileId: string;
  fileUniqueId: string;
  fileSize?: number;
  filePath?: string;
  mimeType?: string;
  fileName?: string;
}

/** Result of a binary file download through the Bot API file endpoint. */
export interface TelegramDownloadedFile {
  data: Uint8Array;
  mimeType?: string;
  name?: string;
}

/** Mutable acknowledgement cursor shared with the adapter across reconnects. */
export interface TelegramUpdateCursor {
  offset: number;
}

export interface TelegramUpstream {
  /** Auth check; resolves with the bot user or throws on 401/invalid token. */
  getMe(): Promise<TelegramBotUser>;

  /** Disable a previously configured webhook before switching to polling. */
  deleteWebhook(): Promise<void>;

  /**
   * Long-poll getUpdates until `signal` aborts. The shared cursor advances only
   * after `onUpdate` resolves, so failed dispatches remain unacknowledged and
   * reconnects resume from the last successfully handled update.
   */
  getUpdates(
    cursor: TelegramUpdateCursor,
    signal: AbortSignal,
    onUpdate: (update: unknown) => Promise<void>,
    onPoll?: () => void,
  ): Promise<void>;

  /** Send a text message; resolves with the raw Bot API envelope. */
  sendText(chatId: string, text: string, options?: TelegramSendOptions): Promise<unknown>;

  /** Send a text message; resolves with the parsed message id + raw envelope. */
  sendMessage(chatId: string, text: string, options?: TelegramSendOptions): Promise<TelegramSentMessage>;

  /** Edit an existing message by id (streaming preview). */
  editMessageText(chatId: string, messageId: string, text: string): Promise<unknown>;

  /** Resolve a Telegram file_id into its file metadata. */
  getFile(fileId: string): Promise<TelegramFileInfo>;

  /** Resolve a file_id and download its bytes from the Bot API file endpoint. */
  downloadFile(fileId: string, signal?: AbortSignal): Promise<TelegramDownloadedFile>;

  /** Send a media reference (image/file/audio/video). */
  sendMedia(chatId: string, media: TelegramMedia, options?: TelegramSendOptions): Promise<unknown>;
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

/** `sendMessage` result: the sent message id. */
const sentMessageSchema = z.object({
  message_id: z.number(),
}).passthrough();

/** `getFile` result: file metadata, including the download path. */
const fileSchema = z.object({
  file_id: z.string(),
  file_unique_id: z.string(),
  file_size: z.number().optional(),
  file_path: z.string().optional(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
}).passthrough();

/** HTTP implementation over the Telegram Bot API. */
export class HttpTelegramUpstream implements TelegramUpstream {
  constructor(private readonly options: HttpTelegramUpstreamOptions) {}

  private path(endpoint: string): string {
    return `/bot${this.options.token ?? ''}/${endpoint}`;
  }

  private filePath(filePath: string): string {
    return `/file/bot${this.options.token ?? ''}/${filePath.replace(/^\/+/, '')}`;
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

  async deleteWebhook(): Promise<void> {
    const raw = await this.post('deleteWebhook', { drop_pending_updates: false });
    const envelope = apiResponseSchema.safeParse(raw);
    if (!envelope.success || !envelope.data.ok || envelope.data.result !== true) {
      throw new ChannelError(
        'CHANNEL_ERROR',
        `telegram deleteWebhook failed: ${envelope.success ? envelope.data.description ?? 'unknown error' : 'invalid response'}`,
      );
    }
  }

  async getUpdates(
    cursor: TelegramUpdateCursor,
    signal: AbortSignal,
    onUpdate: (update: unknown) => Promise<void>,
    onPoll?: () => void,
  ): Promise<void> {
    while (!signal.aborted) {
      let raw: unknown;
      try {
        raw = await this.options.transport.request(
          this.path('getUpdates'),
          {
            method: 'POST',
            body: {
              offset: cursor.offset,
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
      if (!envelope.success) {
        throw new ChannelError('CHANNEL_ERROR', 'telegram getUpdates returned an invalid response');
      }
      if (!envelope.data.ok) {
        if (envelope.data.error_code === 401) {
          throw new ChannelAuthError('telegram getUpdates rejected: invalid bot token');
        }
        throw new ChannelError(
          'CHANNEL_ERROR',
          `telegram getUpdates failed: ${envelope.data.description ?? 'unknown error'}`,
        );
      }
      const result = getUpdatesResultSchema.safeParse(envelope.data.result ?? []);
      if (!result.success) {
        throw new ChannelError('CHANNEL_ERROR', 'telegram getUpdates returned an invalid response');
      }
      onPoll?.();
      for (const update of result.data) {
        if (signal.aborted) return;
        await onUpdate(update);
        const updateId = (update as { update_id?: number })?.update_id;
        if (typeof updateId === 'number') {
          // Commit only after dispatch succeeds. The shared cursor survives a
          // thrown handler and is reused by the adapter's reconnect attempt.
          cursor.offset = Math.max(cursor.offset, updateId + 1);
        }
      }
    }
  }

  sendText(chatId: string, text: string, options?: TelegramSendOptions): Promise<unknown> {
    return this.post('sendMessage', this.messageBody(chatId, { text }, options));
  }

  async sendMessage(chatId: string, text: string, options?: TelegramSendOptions): Promise<TelegramSentMessage> {
    const raw = await this.post('sendMessage', this.messageBody(chatId, { text }, options));
    const envelope = apiResponseSchema.safeParse(raw);
    if (!envelope.success || !envelope.data.ok) {
      throw new ChannelError('CHANNEL_ERROR', 'telegram sendMessage returned an invalid response');
    }
    const sent = sentMessageSchema.safeParse(envelope.data.result);
    if (!sent.success) {
      throw new ChannelError('CHANNEL_ERROR', 'telegram sendMessage returned no message_id');
    }
    return { messageId: String(sent.data.message_id), raw: envelope.data };
  }

  async editMessageText(chatId: string, messageId: string, text: string): Promise<unknown> {
    const raw = await this.post('editMessageText', {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
    });
    const envelope = apiResponseSchema.safeParse(raw);
    if (!envelope.success) {
      throw new ChannelError('CHANNEL_ERROR', 'telegram editMessageText returned an invalid response');
    }
    if (!envelope.data.ok) {
      throw new ChannelError(
        'CHANNEL_ERROR',
        `telegram editMessageText failed: ${envelope.data.description ?? 'unknown error'}`,
      );
    }
    return envelope.data.result;
  }

  async getFile(fileId: string): Promise<TelegramFileInfo> {
    const raw = await this.post('getFile', { file_id: fileId });
    const envelope = apiResponseSchema.safeParse(raw);
    if (!envelope.success) {
      throw new ChannelError('CHANNEL_ERROR', 'telegram getFile returned an invalid response');
    }
    if (!envelope.data.ok) {
      throw new ChannelError(
        'CHANNEL_ERROR',
        `telegram getFile failed: ${envelope.data.description ?? 'unknown error'}`,
      );
    }
    const file = fileSchema.safeParse(envelope.data.result);
    if (!file.success) {
      throw new ChannelError('CHANNEL_ERROR', 'telegram getFile returned no file metadata');
    }
    return {
      fileId: file.data.file_id,
      fileUniqueId: file.data.file_unique_id,
      fileSize: file.data.file_size,
      filePath: file.data.file_path,
      mimeType: file.data.mime_type,
      fileName: file.data.file_name,
    };
  }

  async downloadFile(fileId: string, signal?: AbortSignal): Promise<TelegramDownloadedFile> {
    const file = await this.getFile(fileId);
    if (!file.filePath) {
      throw new ChannelError('CHANNEL_ERROR', 'telegram getFile returned no file_path');
    }
    if (!this.options.transport.requestBinary) {
      throw new ChannelError('CHANNEL_UNSUPPORTED', 'telegram transport does not support binary downloads');
    }
    // Keep the transport receiver intact. FetchTransport.requestBinary uses
    // `this.requestResponse`; extracting the method would lose that binding.
    const response = await this.options.transport.requestBinary(this.filePath(file.filePath), {}, signal);
    const pathName = file.filePath.split('/').pop();
    const name = file.fileName ?? filenameFromDisposition(response.contentDisposition) ?? pathName;
    const mimeType = normalizeMimeHint(file.mimeType)
      ?? normalizeMimeHint(response.contentType)
      ?? mimeHintFromFilename(name);
    return { data: response.data, mimeType, name };
  }

  sendMedia(chatId: string, media: TelegramMedia, options?: TelegramSendOptions): Promise<unknown> {
    const endpointAndField = {
      image: ['sendPhoto', 'photo'],
      file: ['sendDocument', 'document'],
      audio: ['sendAudio', 'audio'],
      video: ['sendVideo', 'video'],
    } as const;
    const [endpoint, field] = endpointAndField[media.type];
    if (media.localData) {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append(
        field,
        new Blob([media.localData], { type: media.mimeType ?? 'application/octet-stream' }),
        media.name ?? defaultMediaName(media.type),
      );
      if (media.caption !== undefined) form.append('caption', media.caption);
      this.appendSendOptions(form, options);
      return this.post(endpoint, form);
    }
    if (!media.url) {
      throw new ChannelError('CHANNEL_UNSUPPORTED', 'telegram media requires localData, url, or resourceRef');
    }
    const mediaWithUrl = { ...media, url: media.url };
    switch (media.type) {
      case 'image':
        return this.post('sendPhoto', this.mediaBody(chatId, mediaWithUrl, 'photo', options));
      case 'file':
        return this.post('sendDocument', this.mediaBody(chatId, mediaWithUrl, 'document', options));
      case 'audio':
        return this.post('sendAudio', this.mediaBody(chatId, mediaWithUrl, 'audio', options));
      case 'video':
        return this.post('sendVideo', this.mediaBody(chatId, mediaWithUrl, 'video', options));
      default:
        // Exhaustive over TelegramMedia['type']; kept for safety.
        throw new ChannelError(
          'CHANNEL_UNSUPPORTED',
          `telegram media type '${String(media.type)}' unsupported`,
        );
    }
  }

  private mediaBody(
    chatId: string,
    media: TelegramMedia & { url: string },
    field: string,
    options?: TelegramSendOptions,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = { chat_id: chatId, [field]: media.url };
    if (media.caption !== undefined) body.caption = media.caption;
    return this.messageBody(chatId, body, options);
  }

  private messageBody(
    chatId: string,
    body: Record<string, unknown>,
    options?: TelegramSendOptions,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { chat_id: chatId, ...body };
    if (options?.replyToMessageId) {
      result.reply_parameters = { message_id: Number(options.replyToMessageId) };
    }
    if (options?.messageThreadId) result.message_thread_id = Number(options.messageThreadId);
    return result;
  }

  private appendSendOptions(form: FormData, options?: TelegramSendOptions): void {
    if (options?.replyToMessageId) {
      form.append('reply_parameters', JSON.stringify({ message_id: Number(options.replyToMessageId) }));
    }
    if (options?.messageThreadId) form.append('message_thread_id', options.messageThreadId);
  }

  private post(endpoint: string, body: unknown): Promise<unknown> {
    return this.options.transport.request(this.path(endpoint), { method: 'POST', body });
  }
}

function filenameFromDisposition(value?: string): string | undefined {
  if (!value) return undefined;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return /filename="?([^";]+)"?/i.exec(value)?.[1]?.trim();
}

function defaultMediaName(type: TelegramMedia['type']): string {
  return type === 'image' ? 'image' : type === 'file' ? 'file' : type === 'audio' ? 'audio' : 'video';
}
