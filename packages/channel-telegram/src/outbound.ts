/**
 * Outbound sending: channel message → Telegram Bot API payload → upstream.
 *
 * Text messages go through `sendText`; messages carrying a media part with a
 * resolvable url (image/file/audio/video) go through `sendMedia` with the
 * message text as the caption. Anything without a resolvable media part
 * degrades to the text payload (buffered strategy).
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
        });
        return { delivered: true, raw: response };
      }
      const response = await this.upstream.sendText(target.conversationId, message.text ?? '');
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
}

/**
 * First media part with a sendable reference, if any. Telegram accepts both a
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
        const ref = part.url ?? part.resourceRef;
        if (ref) return { type: part.type, url: ref };
        break;
      }
    }
  }
  return undefined;
}
