/**
 * Outbound sending: channel message → Telegram Bot API payload → upstream.
 *
 * Text messages go through `sendMessage` (validated Bot API envelope);
 * messages carrying sendable media bytes or references go through `sendMedia`
 * with the message text as the caption. A binary part with no supported carrier
 * fails closed so an attachment is never silently discarded as plain text.
 */
import type {
  ChannelLogger,
  ChannelTarget,
  MessagePart,
  OutboundMessage,
  SendResult,
} from '@wsz987/channel-core';
import { ChannelSendError } from '@wsz987/channel-core';
import type { TelegramMedia, TelegramUpstream } from './upstream.js';

export class OutboundSender {
  constructor(
    private readonly upstream: TelegramUpstream,
    private readonly logger: ChannelLogger,
  ) {}

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    try {
      const media = firstMedia(message.parts);
      if (media) {
        const response = await this.upstream.sendMedia(target.conversationId, {
          ...media,
          caption: message.text,
        }, sendOptions(target, message));
        return { delivered: true, raw: response };
      }
      if (message.parts?.some(isBinaryPart)) {
        throw new ChannelSendError('telegram media has no supported localData, url, or resourceRef carrier');
      }
      const text = message.text ?? '';
      if (!text) {
        throw new ChannelSendError('telegram message has no sendable text or media');
      }
      const sent = await this.upstream.sendMessage(target.conversationId, text, sendOptions(target, message));
      return { delivered: true, raw: sent.raw };
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

function sendOptions(target: ChannelTarget, message: OutboundMessage) {
  return {
    replyToMessageId: message.replyTo ?? target.replyToMessageId,
    messageThreadId: target.threadId,
  };
}
