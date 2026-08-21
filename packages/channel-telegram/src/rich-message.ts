/**
 * Telegram Rich Message + interactive markup payload shapes (Bot API 10.2).
 *
 * This module owns ONLY the Telegram wire contract for rich output and inline
 * buttons. It is a pure-type + constants module (no I/O, no HTTP) so that both
 * the upstream driver and the mapper/outbound layers can share the shapes
 * without duplicating protocol knowledge or pulling the renderer into the
 * transport layer.
 *
 * Wire types come from `@grammyjs/types@4.0.0`, which tracks Bot API 10.2.
 * The local aliases keep protocol details out of the adapter and renderer.
 */
import type { InputRichMessage as OfficialInputRichMessage, InlineKeyboardMarkup, Opts } from '@grammyjs/types';
import type { TelegramErrorParameters } from './api-error.js';

/** Rich Message content limits (plan §7.2, official 10.2). */
export const RICH_MESSAGE_MAX_UTF8 = 32768;
export const RICH_MESSAGE_MAX_BLOCKS = 500;
export const RICH_MESSAGE_MAX_NESTING = 16;
export const RICH_MESSAGE_MAX_MEDIA = 50;
export const RICH_MESSAGE_MAX_TABLE_COLUMNS = 20;

/** Regular text message limit after entity parsing (plan §7.1). */
export const REGULAR_MESSAGE_MAX = 4096;
/** Media caption limit after entity parsing (plan §7.1). */
export const CAPTION_MAX = 1024;

/** The official rich body for send, draft, and edit methods. */
export type InputRichMessage = OfficialInputRichMessage<never>;
export type TelegramInputRichMessage = InputRichMessage;
export type SendRichMessageParams = Opts<never>['sendRichMessage'];
export type SendRichMessageDraftParams = Opts<never>['sendRichMessageDraft'];
export type EditMessageTextParams = Opts<never>['editMessageText'];

/** Result of `sendRichMessage` / `sendRichMessageDraft`. */
export interface RichMessageSent {
  messageId: string;
  /** Full Bot API envelope, kept for diagnostics. */
  raw: unknown;
}

/**
 * Telegram inline keyboard button. `style` is optional and only meaningful on
 * Bot API 10.2+; every field is validated at the trust boundary in the mapper
 * (untrusted callback_data is never trusted by the adapter).
 */
export type TelegramInlineKeyboardButton = InlineKeyboardMarkup['inline_keyboard'][number][number];

/** Inline keyboard row. */
export type TelegramInlineKeyboardRow = TelegramInlineKeyboardButton[];

/** Inline keyboard markup (`reply_markup.inline_keyboard`). */
export type TelegramInlineKeyboardMarkup = InlineKeyboardMarkup;

/**
 * The reply_markup value accepted by `sendMessage` / `sendMedia` /
 * `editMessageText` / `answerCallbackQuery`-adjacent sends.
 */
export type TelegramReplyMarkup =
  | TelegramInlineKeyboardMarkup
  | { force_reply: boolean; input_field_placeholder?: string };

/**
 * `answerCallbackQuery` request body. `text`/`show_alert`/`url` are optional;
 * the ACK only needs `callback_query_id` — used as a best-effort, non-blocking
 * acknowledgement (plan §12.2).
 */
export interface AnswerCallbackQueryParams {
  callback_query_id: string;
  text?: string;
  show_alert?: boolean;
  url?: string;
  /** Seconds to cache the answer (0–32). */
  cache_time?: number;
}

/** Response shape shared by methods that return `true` or an error envelope. */
export interface TelegramErrorEnvelope {
  ok: boolean;
  error_code?: number;
  description?: string;
  parameters?: TelegramErrorParameters;
}
