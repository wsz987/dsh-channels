/**
 * Outbound sending: channel message → qq payload → upstream.
 *
 * Text messages go through `sendText`; messages carrying media parts (e.g. an
 * image with a resolvable url) go through `sendMedia`. Everything else falls
 * back to the single-text `toTextPayload` (buffered strategy).
 */
import type {
  ChannelLogger,
  ChannelTarget,
  MessagePart,
  OutboundMessage,
  SendResult,
} from '@dsh/channel-core';
import { ChannelSendError } from '@dsh/channel-core';
import { toTextPayload } from './mapper.js';
import type { QQMedia, QQUpstream } from './upstream.js';

export class OutboundSender {
  constructor(
    private readonly upstream: QQUpstream,
    private readonly logger: ChannelLogger,
  ) {}

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    try {
      const media = firstMedia(message.parts);
      if (media) {
        const response = await this.upstream.sendMedia(target.conversationId, media);
        return { delivered: true, raw: response };
      }
      const payload = toTextPayload(target, message);
      const response = await this.upstream.sendText(payload.to, payload.content);
      return { delivered: true, raw: response };
    } catch (error) {
      this.logger.error(
        `[channel-qq] send failed to '${target.conversationId}'`,
        error instanceof Error ? error.message : error,
      );
      throw new ChannelSendError(
        `qq send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** First media part with a resolvable url, if any. */
function firstMedia(parts: MessagePart[] | undefined): QQMedia | undefined {
  if (!parts) return undefined;
  for (const part of parts) {
    if (part.type === 'image' && part.url) return { type: 'image', url: part.url };
    if (part.type === 'audio' && part.url) return { type: 'audio', url: part.url };
    if (part.type === 'file' && part.url) return { type: 'file', url: part.url };
  }
  return undefined;
}
