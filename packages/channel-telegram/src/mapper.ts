/**
 * Pure payload mapping (no I/O): Telegram Bot API updates → Channel Contract.
 *
 * Raw updates only ever ride along in `event.raw` for debugging — core and
 * the harness bridge never depend on their shape (red line 6).
 *
 * Telegram update shape (Bot API 7.x):
 * ```json
 * { "update_id": 123,
 *   "message": { "message_id": 456, "date": 1700000000,
 *     "chat": { "id": 789, "type": "private" },
 *     "from": { "id": 111, "first_name": "Alice" },
 *     "text": "hello" } }
 * ```
 *
 * `chat.type` 'private' → dm conversation; 'group'/'supergroup' → group
 * conversation keyed by the chat id. All ids are numeric on the wire and are
 * stringified into the branded contract identities. The bot token is never
 * part of any mapped event.
 */
import type {
  AccountId,
  ChannelId,
  ConversationId,
  MessageId,
  MessagePart,
  MessageReceived,
  SenderId,
} from '@wsz987/channel-core';
import type { InteractionReceived } from '@wsz987/channel-core';
import { textParts } from '@wsz987/channel-core';
import { z } from 'zod';

export interface TelegramInboundMeta {
  channel: ChannelId;
  accountId: AccountId;
}

interface TelegramChat {
  id?: number;
  type?: string;
  first_name?: string;
  username?: string;
  title?: string;
}

interface TelegramUser {
  id?: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

interface TelegramPhotoSize {
  file_id?: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}

interface TelegramDocument {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramAudio {
  file_id?: string;
  duration?: number;
  mime_type?: string;
  file_name?: string;
}

interface TelegramVoice {
  file_id?: string;
  duration?: number;
  mime_type?: string;
}

interface TelegramVideo {
  file_id?: string;
  duration?: number;
  mime_type?: string;
  file_name?: string;
}

interface TelegramMessage {
  message_id?: number;
  date?: number;
  chat?: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  reply_to_message?: { message_id?: number };
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  video?: TelegramVideo;
  [key: string]: unknown;
}

interface TelegramRawUpdate {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: { id?: string };
  [key: string]: unknown;
}

/** Message fields that carry metadata rather than content kind. */
const TELEGRAM_META_KEYS = new Set([
  'message_id', 'date', 'chat', 'from', 'reply_to_message',
  'edit_date', 'media_group_id', 'entities', 'caption',
  'caption_entities', 'author_signature', 'is_automatic_forward',
]);

/** Stable hash for ids when the platform omits them. */
export function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** Map one raw Telegram update into the stable channel event shape. */
export function mapInbound(raw: unknown, meta: TelegramInboundMeta): MessageReceived {
  const update = raw as TelegramRawUpdate;
  const message = update.message ?? {};
  const chat = message.chat ?? {};
  const from = message.from ?? {};

  const sender: SenderId = String(from.id ?? 'unknown') as SenderId;
  // The chat id is the conversation id for both dm and group messages.
  const conversationId: ConversationId = String(chat.id ?? sender) as ConversationId;
  const messageId: MessageId = message.message_id !== undefined
    ? String(message.message_id) as MessageId
    : `telegram-${simpleHash(JSON.stringify(update))}` as MessageId;

  return {
    type: 'message.received',
    channel: meta.channel,
    accountId: meta.accountId,
    conversation: {
      id: conversationId,
      // 'private' → dm; 'group'/'supergroup' → group keyed by the chat id.
      // Other chat types (e.g. 'channel') fall back to dm in V1.
      type: chat.type === 'group' || chat.type === 'supergroup' ? 'group' : 'dm',
      ...(message.message_thread_id !== undefined
        ? { threadId: String(message.message_thread_id) as never }
        : {}),
    },
    sender: { id: sender, name: from.first_name },
    message: {
      id: messageId,
      content: partsFor(message),
      ...(message.reply_to_message?.message_id !== undefined
        ? { replyTo: String(message.reply_to_message.message_id) as MessageId }
        : {}),
      // Telegram timestamps are Unix seconds; the contract uses ms.
      createdAt: message.date !== undefined ? message.date * 1000 : Date.now(),
    },
    raw,
  };
}

function partsFor(message: TelegramMessage): MessagePart[] {
  if (typeof message.text === 'string') {
    return textParts(message.text);
  }
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    // Telegram sends several sizes; the last entry is the largest. file_id is
    // a platform-opaque handle, so it maps to `resourceRef` — never `url`,
    // which is reserved for real http(s) URLs. The inbound processor resolves
    // this reference through getFile before emitting the channel event.
    const last = message.photo[message.photo.length - 1];
    const resourceRef = last?.file_id;
    return withCaption(message.caption, [{ type: 'image', resourceRef }]);
  }
  if (message.document) {
    return withCaption(message.caption, [{
      type: 'file',
      resourceRef: message.document.file_id,
      name: message.document.file_name,
      mimeType: message.document.mime_type,
    }]);
  }
  if (message.audio) {
    return withCaption(message.caption, [{
      type: 'audio',
      resourceRef: message.audio.file_id,
      durationMs: message.audio.duration !== undefined ? message.audio.duration * 1000 : undefined,
      mimeType: message.audio.mime_type,
    }]);
  }
  if (message.voice) {
    return [{
      type: 'audio',
      resourceRef: message.voice.file_id,
      durationMs: message.voice.duration !== undefined ? message.voice.duration * 1000 : undefined,
      mimeType: message.voice.mime_type,
    }];
  }
  if (message.video) {
    return withCaption(message.caption, [{
      type: 'video',
      resourceRef: message.video.file_id,
      durationMs: message.video.duration !== undefined ? message.video.duration * 1000 : undefined,
      mimeType: message.video.mime_type,
    }]);
  }
  return [{ type: 'unsupported', reason: `unsupported telegram message type '${messageKind(message)}'` }];
}

function withCaption(caption: string | undefined, parts: MessagePart[]): MessagePart[] {
  return typeof caption === 'string' && caption.length > 0
    ? [...textParts(caption), ...parts]
    : parts;
}

/** Best-effort content-kind name for the unsupported-part reason. */
function messageKind(message: TelegramMessage): string {
  for (const key of Object.keys(message)) {
    if (!TELEGRAM_META_KEYS.has(key)) return key;
  }
  return 'unknown';
}

/** Dedup identity for raw updates (update_id, then message_id). */
export function dedupKey(raw: unknown): string {
  const update = raw as TelegramRawUpdate;
  if (typeof update.update_id === 'number') return `update-${update.update_id}`;
  if (typeof update.message?.message_id === 'number') return `message-${update.message.message_id}`;
  if (typeof update.callback_query?.id === 'string') return `callback-${update.callback_query.id}`;
  return `telegram-${simpleHash(JSON.stringify(raw))}`;
}

/**
 * Zod schema for a `callback_query` update. `callback_query.data` is UNTRUSTED
 * client payload: it is validated as a plain string here and only ever echoed
 * back as `InteractionReceived.action` (plan §5 / red line 5). The adapter never
 * parses it into Harness question semantics — that interpretation belongs to
 * `channel-harness`.
 */
const callbackQueryUpdateSchema = z.object({
  update_id: z.number().optional(),
  callback_query: z.object({
    id: z.string(),
    from: z.object({
      id: z.number(),
      first_name: z.string().optional(),
      username: z.string().optional(),
    }).partial(),
    message: z.object({
      message_id: z.number(),
      chat: z.object({
        id: z.number(),
        type: z.string().optional(),
      }).partial(),
    }).partial(),
    data: z.string().optional(),
    chat_instance: z.string().optional(),
  }).passthrough(),
}).loose();

/** Whether a raw update carries a `callback_query` (message-bearing). */
export function isCallbackQueryUpdate(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as { callback_query?: unknown }).callback_query === 'object' &&
    callbackQueryUpdateSchema.safeParse(raw).success
  );
}

/**
 * Map a validated `callback_query` update to `InteractionReceived`. Always run
 * `isCallbackQueryUpdate` first; this function re-parses defensively and throws
 * a clear error for a malformed tolerance so the adapter fails closed rather
 * than emitting a fabricated interaction.
 */
export function mapCallbackQuery(raw: unknown, meta: TelegramInboundMeta): InteractionReceived {
  const parsed = callbackQueryUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('telegram mapCallbackQuery: invalid callback_query payload');
  }
  const cq = parsed.data.callback_query;
  const chat = cq.message?.chat;
  const from = cq.from;
  const sender: SenderId = String(from?.id ?? 'unknown') as SenderId;
  const conversationId: ConversationId = String(chat?.id ?? sender) as ConversationId;

  return {
    type: 'interaction.received',
    channel: meta.channel,
    accountId: meta.accountId,
    conversation: {
      id: conversationId,
      // 'private' → dm; 'group'/'supergroup' → group keyed by the chat id.
      type: chat?.type === 'group' || chat?.type === 'supergroup' ? 'group' : 'dm',
    },
    sender: { id: sender, name: from?.first_name },
    interactionId: cq.id,
    // The untrusted callback data is surfaced verbatim as the action; the
    // adapter never interprets it (red line 5).
    action: typeof cq.data === 'string' ? cq.data : '',
    raw,
  };
}
