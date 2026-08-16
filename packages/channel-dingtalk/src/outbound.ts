/***
 * Outbound sending: channel message -> dingtalk payload -> upstream.
 *
 * Two explicit send paths (plan §69):
 *   - REPLY: the target carries an inbound `sessionWebhook` (or the upstream is
 *     the legacy gateway, which has no proactive path). sessionWebhook belongs
 *     ONLY to the current inbound reply (plan §35) — never a durable outbox route.
 *   - PROACTIVE: a target with no reply context / an arbitrary conversation id
 *     is sent through the official proactive OpenAPI port (`sendProactiveText`,
 *     and proactive media via `uploadMedia` + `sendMedia`) — never via a stale
 *     sessionWebhook (plan §35 / §69).
 *
 * Capability flags (`outboxCapabilities`, plan §71) fail CLOSED: they only read
 * `true` when the matching official path is actually wired. Streaming replies go
 * through `DingTalkCardReply`; this sender is the buffered fallback path
 * (`adapter.send`) used when no card was created.
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
import type {
  DingTalkOpenApiPort,
  OutboxCapabilities,
} from './openapi-port.js';

/** Structural subset of `target.raw` the reply/proactive split reads. */
interface TargetRawProbe {
  sessionWebhook?: string;
  robotCode?: string;
}

export interface OutboundSenderOptions {
  /**
   * Reply-path upstream (sessionWebhook for official mode, legacy /message/send
   * for gateway mode). Used for replies and for the no-proactive fallback.
   */
  reply: DingTalkUpstream;
  logger: ChannelLogger;
  /**
   * Proactive OpenAPI port (official proactive path). Absent in gateway mode ->
   * proactive capabilities are false (fail closed).
   */
  proactive?: DingTalkOpenApiPort;
  /**
   * Resolved proactive capability flags (plan §71). Provided by the adapter;
   * defaults to all-false (fail closed) when not supplied.
   */
  capabilities?: OutboxCapabilities;
}

export class OutboundSender {
  private readonly reply: DingTalkUpstream;
  private readonly logger: ChannelLogger;
  private readonly proactive?: DingTalkOpenApiPort;
  private readonly capabilities: OutboxCapabilities;

  constructor(options: OutboundSenderOptions) {
    this.reply = options.reply;
    this.logger = options.logger;
    this.proactive = options.proactive;
    this.capabilities = options.capabilities ?? { proactiveText: false, proactiveMedia: false };
  }

  /** Proactive capability flags the harness outbox reads (plan §71). */
  get outboxCapabilities(): OutboxCapabilities {
    return { ...this.capabilities };
  }

  /**
   * Send one channel message. REPLIES (sessionWebhook present) go through the
   * reply upstream; PROACTIVE targets use the official proactive API; gateway
   * mode (no proactive port) falls back to the reply upstream /message/send.
   * Media-carrying proactive messages go through upload + sendMedia.
   */
  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    const probe = (target.raw ?? {}) as TargetRawProbe;
    const isReply = typeof probe.sessionWebhook === 'string' && probe.sessionWebhook !== '';
    try {
      if (isReply || !this.proactive) {
        // REPLY path (sessionWebhook) — or gateway fallback (no proactive port).
        const payload = toTextPayload(target, message);
        const response = await this.reply.sendText(target, payload.content);
        return { delivered: true, raw: response };
      }

      // PROACTIVE path: official proactive API (plan §35 / §69).
      const robotCode = (probe.robotCode ?? '').trim() || undefined;
      const conversationType = target.conversationType;
      const media = this.proactiveMediaPart(message);
      if (media) {
        if (!this.capabilities.proactiveMedia) {
          throw new ChannelSendError(
            'dingtalk proactive media is not enabled; message carries binary content with no reply context',
          );
        }
        const agentId = robotCode;
        if (!agentId) {
          throw new ChannelSendError('dingtalk proactive send requires a robotCode in target.raw');
        }
        const uploaded = await this.proactive.uploadMedia({
          robotCode: agentId,
          fileName: media.fileName,
          mimeType: media.mimeType,
          data: media.localData,
          mediaType: media.msgtype,
          target,
        });
        const result = await this.proactive.sendMedia({
          conversationId: String(target.conversationId),
          robotCode: agentId,
          mediaId: uploaded.mediaId,
          msgtype: media.msgtype,
          name: media.fileName,
          conversationType,
        });
        return { delivered: true, raw: result.raw };
      }

      if (!this.capabilities.proactiveText) {
        throw new ChannelSendError('dingtalk proactive text is not enabled');
      }
      if (!robotCode) {
        throw new ChannelSendError('dingtalk proactive send requires a robotCode in target.raw');
      }
      const text = toTextPayload(target, message).content;
      const result = await this.proactive.sendProactiveText({
        conversationId: String(target.conversationId),
        robotCode,
        text,
        conversationType,
      });
      return { delivered: true, raw: result.raw };
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

  /**
   * Inspect an outbound message for a single sendable binary (file/image/image-like)
   * part already carrying trusted bytes (`localData`). Returns undefined for pure
   * text messages.
   */
  private proactiveMediaPart(message: OutboundMessage): {
    msgtype: 'image' | 'file';
    localData: Uint8Array;
    mimeType?: string;
    fileName: string;
  } | undefined {
    if (!message.parts || message.parts.length !== 1) return undefined;
    const part = message.parts[0];
    if (!part || (part.type !== 'file' && part.type !== 'image')) return undefined;
    if (!part.localData) return undefined;
    return {
      msgtype: part.type === 'image' ? 'image' : 'file',
      localData: part.localData,
      mimeType: part.mimeType,
      fileName: part.name ?? (part.type === 'file' ? 'file' : 'image'),
    };
  }
}
