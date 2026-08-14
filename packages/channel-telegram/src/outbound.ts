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
} from '@dsh/channel-core';
import { ChannelSendError } from '@dsh/channel-core';
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

/** First media part with a resolvable url, if any. */
function firstMedia(parts: MessagePart[] | undefined): TelegramMedia | undefined {
  if (!parts) return undefined;
  for (const part of parts) {
    if (part.type === 'image' && part.url) return { type: 'image', url: part.url };
    if (part.type === 'file' && part.url) return { type: 'file', url: part.url };
    if (part.type === 'audio' && part.url) return { type: 'audio', url: part.url };
    if (part.type === 'video' && part.url) return { type: 'video', url: part.url };
  }
  return undefined;
}
