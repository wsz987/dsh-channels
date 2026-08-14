/**
 * Outbound sending: channel message → dingtalk text payload → upstream.
 *
 * Streaming replies go through `DingTalkCardReply`; this sender is the
 * buffered fallback path (`adapter.send`) used when no card was created.
 */
import type {
  ChannelLogger,
  ChannelTarget,
  OutboundMessage,
  SendResult,
} from '@wsz987/channel-core';
import { ChannelSendError } from '@wsz987/channel-core';
import { toTextPayload } from './mapper.js';
import type { DingTalkUpstream } from './upstream.js';

export class OutboundSender {
  constructor(
    private readonly upstream: DingTalkUpstream,
    private readonly logger: ChannelLogger,
  ) {}

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    try {
      const payload = toTextPayload(target, message);
      const response = await this.upstream.sendText(payload.to, payload.content);
      return { delivered: true, raw: response };
    } catch (error) {
      this.logger.error(
        `[channel-dingtalk] send failed to '${target.conversationId}'`,
        error instanceof Error ? error.message : error,
      );
      throw new ChannelSendError(
        `dingtalk send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
