/**
 * Outbound sending: channel message → Telegram Bot API payload → upstream.
 *
 * Text messages go through the configured formatting renderer (Rich Markdown /
 * HTML / MarkdownV2 / plain) and `sendMessage`; messages carrying sendable media
 * bytes or references go through `sendMedia` with the message text rendered as a
 * 1024-caption. Interactive `OutboundMessage.actions` map to a Telegram
 * `InlineKeyboardMarkup` (plan §14). A binary part with no supported carrier
 * fails closed so an attachment is never silently discarded as plain text.
 *
 * Formatting fallback is exact-once: only a `format`-kind error downgrades to
 * plain; 401/403 / 429 / network / 5xx propagate (plan §20.9).
 */
import type {
  ChannelLogger,
  ChannelTarget,
  MessagePart,
  OutboundActionRow,
  OutboundMessage,
  SendResult,
} from '@wsz987/channel-core';
import { ChannelSendError } from '@wsz987/channel-core';
import type { TelegramFormattingConfig } from './config.js';
import type { TelegramMedia, TelegramSendOptions, TelegramUpstream } from './upstream.js';
import type { TelegramInlineKeyboardButton, TelegramInlineKeyboardMarkup, TelegramInlineKeyboardRow } from './rich-message.js';
import { sendWithFallback, type RenderPlan } from './render/index.js';

/** Maximum Telegram `callback_data` size (1–64 bytes, plan §11). */
const CALLBACK_DATA_MAX_BYTES = 64;

export interface TelegramOutboundOptions {
  /** Formatting policy controlling how text/captions are rendered. */
  formatting?: Partial<TelegramFormattingConfig>;
}

export class OutboundSender {
  private readonly formatting: TelegramFormattingConfig;

  constructor(
    private readonly upstream: TelegramUpstream,
    private readonly logger: ChannelLogger,
    options: TelegramOutboundOptions = {},
  ) {
    this.formatting = { mode: 'auto', fallback: 'plain', ...options.formatting };
  }

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    try {
      const replyMarkup = actionsToReplyMarkup(message.actions);
      const media = firstMedia(message.parts);
      if (media) {
        const response = await this.sendMediaWithFormatting(target, media, message, replyMarkup);
        return { delivered: true, raw: response };
      }
      if (message.parts?.some(isBinaryPart)) {
        throw new ChannelSendError('telegram media has no supported localData, url, or resourceRef carrier');
      }
      const text = message.text ?? '';
      if (!text) {
        throw new ChannelSendError('telegram message has no sendable text or media');
      }
      const response = await this.sendTextWithFormatting(target, text, sendOptions(target, message), replyMarkup);
      return { delivered: true, raw: response };
    } catch (error) {
      this.logger.error(
        `[channel-telegram] send failed to '${target.conversationId}'`,
        error instanceof Error ? error.message : error,
      );
      throw new ChannelSendError(
        `telegram send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Send text through the configured renderer with exact-once fallback. */
  private async sendTextWithFormatting(
    target: ChannelTarget,
    source: string,
    options: TelegramSendOptionsExport,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<unknown> {
    const send = async (plan: RenderPlan): Promise<unknown> => {
      if (plan.kind === 'rich') {
        let last: unknown;
        for (const text of plan.texts) {
          last = await this.upstream.sendRichMessage(
            target.conversationId,
            { markdown: text },
            options,
            { ...(replyMarkup ? { replyMarkup } : {}) },
          );
        }
        return last;
      }
      let last: unknown;
      for (const chunk of plan.chunks) {
        last = await this.upstream.sendMessage(
          target.conversationId,
          chunk,
          options,
          {
            ...(plan.parseMode ? { parseMode: plan.parseMode } : {}),
            ...(replyMarkup ? { replyMarkup } : {}),
          },
        );
      }
      return last;
    };
    return sendWithFallback(source, { mode: this.formatting.mode }, send);
  }

  /** Send media with the text rendered as a ≤1024 caption (plain fallback). */
  private async sendMediaWithFormatting(
    target: ChannelTarget,
    media: TelegramMedia,
    message: OutboundMessage,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<unknown> {
    const sendOptions = {
      replyToMessageId: message.replyTo ?? target.replyToMessageId,
      messageThreadId: target.threadId,
    };
    const sendWithoutCaption = async (): Promise<unknown> => {
      return this.upstream.sendMedia(
        target.conversationId,
        media,
        sendOptions,
        { ...(replyMarkup ? { replyMarkup } : {}) },
      );
    };
    const caption = message.text ?? '';
    if (!caption) return sendWithoutCaption();

    const plainCaption = markdownToPlainCaption(caption);
    // Captions are rendered as plain text (rich/HTML media captions are out of
    // scope); any format error falls back to the stripped caption once.
    try {
      return await this.upstream.sendMedia(
        target.conversationId,
        { ...media, caption: truncateCaption(plainCaption) },
        sendOptions,
        { ...(replyMarkup ? { replyMarkup } : {}) },
      );
    } catch (error) {
      if (isFormattingFailure(error)) {
        return this.upstream.sendMedia(
          target.conversationId,
          { ...media, caption: truncateCaption(markdownToPlainCaption(caption)) },
          sendOptions,
          { ...(replyMarkup ? { replyMarkup } : {}) },
        );
      }
      throw error;
    }
  }
}

/** Whether an error is a formatting failure eligible for plain fallback. */
function isFormattingFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { kind?: unknown }).kind === 'format'
  );
}

/** Plain caption text (stripped of markdown) for the fallback path. */
function markdownToPlainCaption(source: string): string {
  return source
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

/** Caption cap: 1024 grapheme clusters (plan §7.1). */
const CAPTION_MAX_GRAPHEMES = 1024;

/** Truncate a caption to at most 1024 grapheme clusters, never mid-cluster. */
function truncateCaption(text: string): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const graphemes = [...segmenter.segment(text)].map((s) => s.segment);
  if (graphemes.length <= CAPTION_MAX_GRAPHEMES) return text;
  return graphemes.slice(0, CAPTION_MAX_GRAPHEMES).join('');
}

/**
 * Map `OutboundMessage.actions` to a Telegram `InlineKeyboardMarkup`.
 *
 * Each row becomes one inline-keyboard row; each action becomes a button with
 * `text = label`, `callback_data = id` and the mapped style. An action id that
 * exceeds Telegram's 64-byte `callback_data` cap fails closed (we cannot
 * round-trip a truncated id), rather than silently dropping the button.
 */
export function actionsToReplyMarkup(actions: OutboundActionRow[] | undefined): TelegramInlineKeyboardMarkup | undefined {
  if (!actions || actions.length === 0) return undefined;
  const rows: TelegramInlineKeyboardRow[] = [];
  for (const row of actions) {
    const buttons: TelegramInlineKeyboardButton[] = [];
    for (const action of row.actions) {
      const idBytes = new TextEncoder().encode(action.id).byteLength;
      if (idBytes > CALLBACK_DATA_MAX_BYTES) {
        throw new ChannelSendError(
          `telegram action id exceeds ${CALLBACK_DATA_MAX_BYTES}-byte callback_data limit`,
        );
      }
      buttons.push({
        text: action.label,
        callback_data: action.id,
        ...(action.style && action.style !== 'default' ? { style: action.style } : {}),
      });
    }
    if (buttons.length > 0) rows.push(buttons);
  }
  if (rows.length === 0) return undefined;
  return { inline_keyboard: rows };
}

/**
 * First media part with a sendable carrier, if any. Telegram accepts both a
 * public http(s) `url` and a platform `file_id` (`resourceRef`) in the same
 * field, so either carrier resolves to a `TelegramMedia.url` reference.
 */
function firstMedia(parts: MessagePart[] | undefined): TelegramMedia | undefined {
  for (const part of parts ?? []) {
    switch (part.type) {
      case 'image':
      case 'file':
      case 'audio':
      case 'video': {
        if (part.localData) {
          return {
            type: part.type,
            localData: part.localData,
            mimeType: part.mimeType,
            name: part.name,
          };
        }
        const ref = part.url ?? part.resourceRef;
        if (ref) return { type: part.type, url: ref, mimeType: part.mimeType, name: part.name };
        break;
      }
    }
  }
  return undefined;
}

function isBinaryPart(part: MessagePart): boolean {
  return part.type === 'image' || part.type === 'file' || part.type === 'audio' || part.type === 'video';
}

type TelegramSendOptionsExport = TelegramSendOptions;

function sendOptions(target: ChannelTarget, message: OutboundMessage): TelegramSendOptionsExport {
  return {
    replyToMessageId: message.replyTo ?? target.replyToMessageId,
    messageThreadId: target.threadId,
  };
}
