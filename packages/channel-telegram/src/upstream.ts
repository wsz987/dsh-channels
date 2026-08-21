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
 *
 * ## Structured errors (plan §3.1 / §5.4)
 *
 * Every non-ok / invalid envelope is converted at this boundary into a
 * `TelegramApiError` (see `api-error.ts`) that preserves Telegram's
 * `error_code` / `description` / `parameters` and carries a stable kind. This
 * lets the renderer and reply engine distinguish a formatting parse failure
 * (→ one-shot plain fallback) from 401/403 / 429 / network / 5xx without
 * re-classifying raw numbers.
 */
import {
  ChannelError,
  mimeHintFromFilename,
  normalizeMimeHint,
} from '@wsz987/channel-core';
import { z } from 'zod';
import type { HttpTransport } from './transport.js';
import { classifyTelegramError, TelegramApiError, type TelegramErrorParameters } from './api-error.js';
import type { TelegramInputRichMessage, TelegramReplyMarkup } from './rich-message.js';

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
  /** Caption rendered on the media; honors caption formatting options. */
  caption?: string;
}

/**
 * Formatting options shared by text messages and media captions.
 *
 * `parseMode` and `entities` are mutually exclusive in the Bot API; callers
 * should provide one. `replyMarkup` is the interactive keyboard / ForceReply.
 */
export interface TelegramFormatOptions {
  /** Telegram parse mode for a formatted body (HTML / MarkdownV2). */
  parseMode?: 'HTML' | 'MarkdownV2';
  /** Pre-calculated entities list (alternative to parse_mode). */
  entities?: unknown[];
  /** Entities for a media caption (alternative to caption_parse_mode). */
  captionEntities?: unknown[];
  /** Interactive keyboard markup (inline buttons / ForceReply). */
  replyMarkup?: TelegramReplyMarkup;
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
   * reconnects resume from the last successfully handled update. Subscribes to
   * `message` and `callback_query` updates.
   */
  getUpdates(
    cursor: TelegramUpdateCursor,
    signal: AbortSignal,
    onUpdate: (update: unknown) => Promise<void>,
    onPoll?: () => void,
  ): Promise<void>;

  /** Send a text message; resolves with the raw Bot API envelope. */
  sendText(chatId: string, text: string, options?: TelegramSendOptions): Promise<unknown>;

  /** Send a formatted text message; resolves with the parsed message id. */
  sendMessage(
    chatId: string,
    text: string,
    options?: TelegramSendOptions,
    format?: TelegramFormatOptions,
  ): Promise<TelegramSentMessage>;

  /** Edit an existing message by id, optionally with formatting options. */
  editMessageText(
    chatId: string,
    messageId: string,
    text: string,
    format?: TelegramFormatOptions,
  ): Promise<unknown>;

  /** Edit only the reply markup of an existing message (interactive updates). */
  editMessageReplyMarkup(chatId: string, messageId: string, replyMarkup?: TelegramReplyMarkup): Promise<unknown>;

  /**
   * Send a Bot API 10.1 Rich Message. `message` is the `InputRichMessage`
   * (Markdown source rendered by the server). Only used when rich output is
   * active and supported; falls back to plain text via the renderer otherwise.
   */
  sendRichMessage(
    chatId: string,
    message: TelegramInputRichMessage,
    options?: TelegramSendOptions,
    format?: TelegramFormatOptions,
  ): Promise<unknown>;

  /**
   * Stream a partial Rich Message over a 30s temporary draft (`draftId`).
   * Same draft id updates the preview in place; a final `sendRichMessage`
   * persists the result.
   */
  sendRichMessageDraft(
    chatId: string,
    draftId: number,
    message: TelegramInputRichMessage,
    options?: TelegramSendOptions,
  ): Promise<unknown>;

  /** Edit an existing message in place, replacing it with a Rich Message. */
  editMessageRich(
    chatId: string,
    messageId: string,
    message: TelegramInputRichMessage,
    replyMarkup?: TelegramReplyMarkup,
  ): Promise<unknown>;

  /** Best-effort `answerCallbackQuery` acknowledgement (never blocks on agent). */
  answerCallbackQuery(params: { callback_query_id: string }): Promise<void>;

  /** Resolve a Telegram file_id into its file metadata. */
  getFile(fileId: string): Promise<TelegramFileInfo>;

  /** Resolve a file_id and download its bytes from the Bot API file endpoint. */
  downloadFile(fileId: string, signal?: AbortSignal): Promise<TelegramDownloadedFile>;

  /** Send a media reference (image/file/audio/video) with formatting options. */
  sendMedia(
    chatId: string,
    media: TelegramMedia,
    options?: TelegramSendOptions,
    format?: TelegramFormatOptions,
  ): Promise<unknown>;
}

export interface HttpTelegramUpstreamOptions {
  transport: HttpTransport;
  /** Bot API token; only ever placed in request paths. */
  token?: string;
  longPollTimeoutMs: number;
}

/**
 * Bot API envelope shared by every method: `{ ok, result?, error_code?,
 * description?, parameters? }`. Validated with zod (not hand-rolled casts) at
 * the upstream boundary, matching the official adapters' response-validation
 * pattern.
 */
const apiResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error_code: z.number().optional(),
  description: z.string().optional(),
  parameters: z.object({
    retry_after: z.number().optional(),
    migrate_to_chat_id: z.number().optional(),
  }).optional(),
}).passthrough();

/** `getMe` result: the bot user. */
const botUserSchema = z.object({
  id: z.number(),
  is_bot: z.boolean(),
  first_name: z.string().optional(),
  username: z.string().optional(),
}).passthrough();

/** `getUpdates` result: a list of raw updates (shape owned by the mapper). */
const getUpdatesResultSchema = z.array(z.object({
  update_id: z.number(),
}).passthrough());

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
    const envelope = await this.requestOk('getMe');
    const user = botUserSchema.safeParse(envelope.data.result);
    if (!user.success) {
      throw new ChannelError('CHANNEL_ERROR', 'telegram getMe returned no bot user');
    }
    return user.data;
  }

  async deleteWebhook(): Promise<void> {
    const raw = await this.post('deleteWebhook', { drop_pending_updates: false });
    const envelope = this.parseEnvelope('deleteWebhook', raw);
    if (!envelope.data.ok || envelope.data.result !== true) {
      throw this.apiError('deleteWebhook', envelope.data);
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
              // Plan §3.4 / §5: subscribe to interactive callback_query updates
              // in addition to plain messages.
              allowed_updates: ['message', 'callback_query'],
            },
            timeoutMs: this.options.longPollTimeoutMs + 5000,
          },
          signal,
        );
      } catch (error) {
        // Abort-driven teardown exits gracefully; other failures propagate to
        // the adapter, which owns reconnect/backoff.
        if (signal.aborted) return;
        throw this.networkError('getUpdates', error);
      }
      const envelope = this.parseEnvelope('getUpdates', raw);
      if (!envelope.data.ok) {
        throw this.apiError('getUpdates', envelope.data);
      }
      const result = getUpdatesResultSchema.safeParse(envelope.data.result ?? []);
      if (!result.success) {
        throw new ChannelError('CHANNEL_ERROR', 'telegram getUpdates returned an invalid response');
      }
      onPoll?.();
      for (const update of result.data) {
        if (signal.aborted) return;
        await onUpdate(update);
        // Commit only after dispatch succeeds. The shared cursor survives a
        // thrown handler and is reused by the adapter's reconnect attempt.
        cursor.offset = Math.max(cursor.offset, update.update_id + 1);
      }
    }
  }

  async sendText(chatId: string, text: string, options?: TelegramSendOptions): Promise<unknown> {
    return (await this.sendMessageRaw(chatId, text, options)).data;
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: TelegramSendOptions,
    format?: TelegramFormatOptions,
  ): Promise<TelegramSentMessage> {
    const envelope = await this.sendMessageRaw(chatId, text, options, format);
    const sent = sentMessageSchema.safeParse(envelope.data.result);
    if (!sent.success) {
      throw new ChannelError('CHANNEL_ERROR', 'telegram sendMessage returned no message_id');
    }
    return { messageId: String(sent.data.message_id), raw: envelope.data };
  }

  /** Send a formatted text message; returns the parsed, ok-checked envelope. */
  private async sendMessageRaw(
    chatId: string,
    text: string,
    options?: TelegramSendOptions,
    format?: TelegramFormatOptions,
  ): Promise<{ data: EnvelopeData }> {
    const raw = await this.post('sendMessage', this.messageBody(chatId, { text }, options, format));
    const envelope = this.parseEnvelope('sendMessage', raw);
    if (!envelope.data.ok) {
      throw this.apiError('sendMessage', envelope.data);
    }
    return envelope;
  }

  async editMessageText(
    chatId: string,
    messageId: string,
    text: string,
    format?: TelegramFormatOptions,
  ): Promise<unknown> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
    };
    this.applyFormatToBody(body, format, false);
    const raw = await this.post('editMessageText', body);
    const envelope = this.parseEnvelope('editMessageText', raw);
    if (!envelope.data.ok) {
      throw this.apiError('editMessageText', envelope.data);
    }
    return envelope.data.result;
  }

  async editMessageReplyMarkup(chatId: string, messageId: string, replyMarkup?: TelegramReplyMarkup): Promise<unknown> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: Number(messageId),
    };
    if (replyMarkup !== undefined) body.reply_markup = replyMarkup;
    const raw = await this.post('editMessageReplyMarkup', body);
    const envelope = this.parseEnvelope('editMessageReplyMarkup', raw);
    if (!envelope.data.ok) {
      throw this.apiError('editMessageReplyMarkup', envelope.data);
    }
    return envelope.data.result;
  }

  async sendRichMessage(
    chatId: string,
    message: TelegramInputRichMessage,
    options?: TelegramSendOptions,
    format?: TelegramFormatOptions,
  ): Promise<unknown> {
    const raw = await this.post(
      'sendRichMessage',
      this.messageBody(
        chatId,
        { rich_message: message },
        options,
        format?.replyMarkup ? { replyMarkup: format.replyMarkup } : undefined,
      ),
    );
    const envelope = this.parseEnvelope('sendRichMessage', raw);
    if (!envelope.data.ok) {
      throw this.apiError('sendRichMessage', envelope.data);
    }
    return envelope.data.result;
  }

  async sendRichMessageDraft(
    chatId: string,
    draftId: number,
    message: TelegramInputRichMessage,
    options?: TelegramSendOptions,
  ): Promise<unknown> {
    const numericChatId = Number(chatId);
    if (!Number.isSafeInteger(numericChatId)) {
      throw new ChannelError('CHANNEL_ERROR', 'telegram rich drafts require a numeric private chat id');
    }
    const raw = await this.post(
      'sendRichMessageDraft',
      {
        chat_id: numericChatId,
        draft_id: draftId,
        rich_message: message,
        ...(options?.messageThreadId ? { message_thread_id: Number(options.messageThreadId) } : {}),
      },
    );
    const envelope = this.parseEnvelope('sendRichMessageDraft', raw);
    if (!envelope.data.ok) {
      throw this.apiError('sendRichMessageDraft', envelope.data);
    }
    return envelope.data.result;
  }

  async editMessageRich(
    chatId: string,
    messageId: string,
    message: TelegramInputRichMessage,
    replyMarkup?: TelegramReplyMarkup,
  ): Promise<unknown> {
    const raw = await this.post('editMessageText', {
      chat_id: chatId,
      message_id: Number(messageId),
      rich_message: message,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    const envelope = this.parseEnvelope('editMessageText', raw);
    if (!envelope.data.ok) {
      throw this.apiError('editMessageText', envelope.data);
    }
    return envelope.data.result;
  }

  async answerCallbackQuery(params: { callback_query_id: string }): Promise<void> {
    const raw = await this.post('answerCallbackQuery', { callback_query_id: params.callback_query_id });
    const envelope = this.parseEnvelope('answerCallbackQuery', raw);
    if (!envelope.data.ok) {
      throw this.apiError('answerCallbackQuery', envelope.data);
    }
  }

  async getFile(fileId: string): Promise<TelegramFileInfo> {
    const raw = await this.post('getFile', { file_id: fileId });
    const envelope = this.parseEnvelope('getFile', raw);
    if (!envelope.data.ok) {
      throw this.apiError('getFile', envelope.data);
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

  sendMedia(
    chatId: string,
    media: TelegramMedia,
    options?: TelegramSendOptions,
    format?: TelegramFormatOptions,
  ): Promise<unknown> {
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
      if (format?.parseMode !== undefined) form.append('caption_parse_mode', format.parseMode);
      if (format?.captionEntities !== undefined) form.append('caption_entities', JSON.stringify(format.captionEntities));
      if (format?.replyMarkup !== undefined) form.append('reply_markup', JSON.stringify(format.replyMarkup));
      this.appendSendOptions(form, options);
      return this.post(endpoint, form);
    }
    if (!media.url) {
      throw new ChannelError('CHANNEL_UNSUPPORTED', 'telegram media requires localData, url, or resourceRef');
    }
    const mediaWithUrl = { ...media, url: media.url };
    switch (media.type) {
      case 'image':
        return this.post('sendPhoto', this.mediaBody(chatId, mediaWithUrl, 'photo', options, format));
      case 'file':
        return this.post('sendDocument', this.mediaBody(chatId, mediaWithUrl, 'document', options, format));
      case 'audio':
        return this.post('sendAudio', this.mediaBody(chatId, mediaWithUrl, 'audio', options, format));
      case 'video':
        return this.post('sendVideo', this.mediaBody(chatId, mediaWithUrl, 'video', options, format));
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
    format?: TelegramFormatOptions,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = { chat_id: chatId, [field]: media.url };
    if (media.caption !== undefined) body.caption = media.caption;
    this.applyFormatToBody(body, format, true);
    return this.messageBody(chatId, body, options);
  }

  /** Apply formatting fields to a JSON body (caption vs text variants). */
  private applyFormatToBody(
    body: Record<string, unknown>,
    format: TelegramFormatOptions | undefined,
    caption: boolean,
  ): void {
    if (!format) return;
    if (caption) {
      if (format.parseMode !== undefined) body.caption_parse_mode = format.parseMode;
      if (format.captionEntities !== undefined) body.caption_entities = format.captionEntities;
    } else {
      if (format.parseMode !== undefined) body.parse_mode = format.parseMode;
      if (format.entities !== undefined) body.entities = format.entities;
    }
    if (format.replyMarkup !== undefined) body.reply_markup = format.replyMarkup;
  }

  private messageBody(
    chatId: string,
    body: Record<string, unknown>,
    options?: TelegramSendOptions,
    format?: TelegramFormatOptions,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { chat_id: chatId, ...body };
    if (options?.replyToMessageId) {
      result.reply_parameters = { message_id: Number(options.replyToMessageId) };
    }
    if (options?.messageThreadId) result.message_thread_id = Number(options.messageThreadId);
    if (format) this.applyFormatToBody(result, format, false);
    return result;
  }

  private appendSendOptions(form: FormData, options?: TelegramSendOptions): void {
    if (options?.replyToMessageId) {
      form.append('reply_parameters', JSON.stringify({ message_id: Number(options.replyToMessageId) }));
    }
    if (options?.messageThreadId) form.append('message_thread_id', options.messageThreadId);
  }

  private async post(endpoint: string, body: unknown): Promise<unknown> {
    try {
      return await this.options.transport.request(this.path(endpoint), { method: 'POST', body });
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      throw this.networkError(endpoint, error);
    }
  }

  /**
   * Issue a request and return a parsed, ok-checked envelope — or throw a
   * structured `TelegramApiError`. This is the single envelope boundary: the
   * sendMessage "invalid response" catch-all is replaced here.
   */
  private async requestOk(endpoint: string, body?: unknown): Promise<{ data: EnvelopeData }> {
    const raw = await this.post(endpoint, body ?? {});
    const envelope = this.parseEnvelope(endpoint, raw);
    if (!envelope.data.ok) {
      throw this.apiError(endpoint, envelope.data);
    }
    return envelope;
  }

  /**
   * Parse a raw response into the envelope shape; a body that is not a valid
   * Bot API envelope is a network/protocol-level failure, not a format issue.
   */
  private parseEnvelope(endpoint: string, raw: unknown): { data: EnvelopeData } {
    const envelope = apiResponseSchema.safeParse(raw);
    if (!envelope.success) {
      throw new TelegramApiError({
        method: endpoint,
        kind: 'network',
        description: 'invalid Bot API response envelope',
      });
    }
    return envelope;
  }

  /** Build a structured `TelegramApiError` from an ok=false envelope. */
  private apiError(endpoint: string, envelope: EnvelopeData): TelegramApiError {
    const params: TelegramErrorParameters | undefined = envelope.parameters
      ? { retryAfter: envelope.parameters.retry_after, migrateToChatId: envelope.parameters.migrate_to_chat_id }
      : undefined;
    const kind = classifyTelegramError(envelope.error_code, envelope.description, params);
    return new TelegramApiError({
      method: endpoint,
      errorCode: envelope.error_code,
      description: envelope.description,
      parameters: params,
      kind,
    });
  }

  /** Wrap a transport/network failure into a structured network-kind error. */
  private networkError(endpoint: string, error: unknown): TelegramApiError {
    const message = error instanceof Error ? error.message : String(error);
    return new TelegramApiError({
      method: endpoint,
      kind: 'network',
      description: message,
      cause: error,
    });
  }
}

/** Envelope shape used internally after zod parsing (result is unknown). */
type EnvelopeData = z.infer<typeof apiResponseSchema>;

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
