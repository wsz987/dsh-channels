/**
 * Outbound sending: channel message → QQReplyTarget → QQSdkClient.
 *
 * Text-only messages go through `sendText`; messages carrying a media part
 * with a resolvable source go through `sendMedia` (fileType mapped from the
 * part type). Failures are wrapped in `ChannelSendError`.
 */
import type {
  ChannelLogger,
  ChannelTarget,
  OutboundMessage,
  SendResult,
} from '@dsh/channel-core';
import { ChannelSendError } from '@dsh/channel-core';
import type { QQReplyTarget, QQSdkClient } from './sdk-client.js';

export class OutboundSender {
  constructor(
    private readonly client: QQSdkClient,
    private readonly logger: ChannelLogger,
  ) {}

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    try {
      const replyTarget = toReplyTarget(target);
      if (hasMedia(message)) {
        const response = await this.client.sendMedia(replyTarget, message);
        return { delivered: true, raw: response };
      }
      const text = message.text ?? '';
      const response = await this.client.sendText(replyTarget, text);
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

/** Build a port `QQReplyTarget` from a DSH `ChannelTarget`. */
export function toReplyTarget(target: ChannelTarget): QQReplyTarget {
  return {
    scope: target.conversationType === 'group' ? 'group' : 'c2c',
    targetId: target.conversationId,
    msgId: target.replyToMessageId,
  };
}

/** Whether the message carries a media part with a resolvable source. */
function hasMedia(message: OutboundMessage): boolean {
  for (const part of message.parts ?? []) {
    switch (part.type) {
      case 'image':
      case 'audio':
      case 'video':
        if (part.url || part.dataUri) return true;
        break;
      case 'file':
        if (part.url || part.dataUri) return true;
        break;
      default:
        break;
    }
  }
  return false;
}
