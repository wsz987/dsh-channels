/**
 * Outbound sending: channel message → lark text/media payload → upstream.
 *
 * Streaming replies go through `LarkCardReply`; this sender is the buffered
 * fallback path (`adapter.send`) used when no card was created. Text messages
 * use `sendText`; a pure-image message (no text) uses the basic `sendMedia`
 * path so image capability is real rather than a placeholder.
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
import type { LarkUpstream } from './upstream.js';

export class OutboundSender {
  constructor(
    private readonly upstream: LarkUpstream,
    private readonly logger: ChannelLogger,
  ) {}

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    try {
      const image = firstImage(message.parts);
      if (image && !message.text) {
        const response = await this.upstream.sendMedia(target.conversationId, image);
        return { delivered: true, raw: response };
      }
      const payload = toTextPayload(target, message);
      const response = await this.upstream.sendText(payload.to, payload.content);
      return { delivered: true, raw: response };
    } catch (error) {
      this.logger.error(
        `[channel-lark] send failed to '${target.conversationId}'`,
        error instanceof Error ? error.message : error,
      );
      throw new ChannelSendError(
        `lark send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function firstImage(parts: MessagePart[] | undefined): Extract<MessagePart, { type: 'image' }> | undefined {
  if (!parts) return undefined;
  return parts.find((part): part is Extract<MessagePart, { type: 'image' }> => part.type === 'image');
}
