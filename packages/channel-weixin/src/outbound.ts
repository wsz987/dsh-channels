/**
 * Outbound sending: channel message → weixin text payload → upstream.
 */
import type {
  ChannelLogger,
  ChannelTarget,
  OutboundMessage,
  SendResult,
} from '@dsh/channel-core';
import { ChannelSendError } from '@dsh/channel-core';
import { toTextPayload } from './mapper.js';
import type { WeixinUpstream } from './upstream.js';

export class OutboundSender {
  constructor(
    private readonly upstream: WeixinUpstream,
    private readonly logger: ChannelLogger,
  ) {}

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    try {
      const payload = toTextPayload(target, message);
      const response = await this.upstream.sendText(payload.to, payload.content);
      return { delivered: true, raw: response };
    } catch (error) {
      this.logger.error(
        `[channel-weixin] send failed to '${target.conversationId}'`,
        error instanceof Error ? error.message : error,
      );
      throw new ChannelSendError(
        `weixin send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
