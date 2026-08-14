/**
 * OutboundSender — builds the real iLink sendmessage payload and calls the
 * client. The ReplyRouter never generates Weixin protocol fields; they live
 * here.
 */
import { randomUUID } from 'node:crypto';
import type { ChannelTarget, OutboundMessage, SendResult } from '@dsh/channel-core';
import { collectText } from '@dsh/channel-core';
import { ChannelError } from '@dsh/channel-core';
import type { ILinkClient } from '../ilink/client.js';
import type { ContextTokenStore } from '../storage/context-token.js';
import {
  MESSAGE_ITEM_TYPE_TEXT,
  MESSAGE_STATE_FINISH,
  MESSAGE_TYPE_BOT,
} from '../ilink/types.js';
import { redactMessage } from '../ilink/errors.js';

export interface OutboundSenderOptions {
  client: ILinkClient;
  contextTokens: ContextTokenStore;
  /** Optional default run id scope; defaults to a fresh UUID per send. */
  runId?: string;
}

export interface SendTextParams {
  to: string;
  text: string;
  contextToken?: string;
  /** Per-send correlation; defaults to a fresh UUID. */
  runId?: string;
}

/**
 * Build one iLink sendmessage payload for a text message.
 */
export function buildSendTextPayload(params: SendTextParams): Record<string, unknown> {
  return {
    msg: {
      from_user_id: '',
      to_user_id: params.to,
      client_id: randomUUID(),
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      item_list: params.text
        ? [{ type: MESSAGE_ITEM_TYPE_TEXT, text_item: { text: params.text } }]
        : [],
      context_token: params.contextToken ?? undefined,
      run_id: params.runId ?? undefined,
    },
  };
}

export class OutboundSender {
  private readonly client: ILinkClient;
  private readonly contextTokens: ContextTokenStore;
  private readonly defaultRunId: string | undefined;

  constructor(options: OutboundSenderOptions) {
    this.client = options.client;
    this.contextTokens = options.contextTokens;
    this.defaultRunId = options.runId;
  }

  /**
   * Send an outbound Channel message to a target. Reads the context token for
   * the target peer from the {@link ContextTokenStore}, builds the payload and
   * dispatches via the client. Failures become ChannelError (token redacted).
   */
  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    const to = target.conversationId;
    const text = message.text ?? collectText(message.parts ?? []);
    const contextToken = await this.contextTokens.get(to);
    const runId = this.defaultRunId ?? randomUUID();

    const payload = buildSendTextPayload({ to, text, contextToken, runId });
    try {
      await this.client.sendMessage(payload);
      return { delivered: true, messageId: (payload.msg as { client_id: string }).client_id };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      throw new ChannelError('CHANNEL_SEND_FAILED', redactMessage(messageText), { cause: error });
    }
  }
}
