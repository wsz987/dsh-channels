/**
 * ChannelOutboxService — the durable outbox (plan §60 / §63 / §65 / §69 /
 * §71).
 *
 * One `send` call walks the full outbound path:
 *
 * ```
 * sessionId
 *   → resolveBindingForSession (durable authority, plan §58)
 *   → targetFromBinding (plan §61)
 *   → build OutboundMessage (text / attachment bytes, plan §63)
 *   → proactive capability gate (fail closed, plan §69/§71)
 *   → adapter.send(target, message)
 * ```
 *
 * The binding authority is the DURABLE store — never an in-memory agent cache.
 * Send errors are NEVER swallowed: they propagate to the tool caller after a
 * diagnostic log.
 */
import type { ChannelAdapter, ChannelLogger, ChannelTarget, OutboundMessage, SendResult } from '@wsz987/channel-core';
import type { SessionBindingStore } from '../binding-store.js';
import type { ResolvedChannelAttachment } from '../file-provider.js';
import type { ChannelOutboundRequest } from './types.js';
import { resolveBindingForSession } from './binding-resolver.js';
import { targetFromBinding } from './target.js';
import { resolveOutboxCapabilities, type OutboxCapabilities } from './capabilities.js';
import { OutboxError } from './types.js';

export interface ChannelOutboxServiceOptions {
  bindingStore: SessionBindingStore;
  getAdapter(channelId: string): ChannelAdapter | undefined;
  /** Optional extension resolver; attachment sends are disabled without it. */
  attachmentResolver?: ChannelAttachmentResolver;
  logger: ChannelLogger;
}

export interface ChannelOutboxSendOptions {
  signal?: AbortSignal;
}

export type ChannelAttachmentResolver = (
  attachmentId: string,
  sessionId: string,
) => Promise<ResolvedChannelAttachment>;

export class ChannelOutboxService {
  private readonly bindingStore: SessionBindingStore;
  private readonly getAdapter: (channelId: string) => ChannelAdapter | undefined;
  private readonly attachmentResolver: ChannelAttachmentResolver | undefined;
  private readonly logger: ChannelLogger;

  constructor(options: ChannelOutboxServiceOptions) {
    this.bindingStore = options.bindingStore;
    this.getAdapter = options.getAdapter;
    this.attachmentResolver = options.attachmentResolver;
    this.logger = options.logger;
  }

  /**
   * Send a proactive channel message on behalf of `sessionId`. Resolves the
   * durable binding, builds the outbound message, gates on proactive
   * capability (fail closed), and delivers through the adapter. Returns the
   * adapter's `SendResult`.
   */
  async send(
    sessionId: string,
    request: ChannelOutboundRequest,
    options: ChannelOutboxSendOptions = {},
  ): Promise<SendResult> {
    const signal = options.signal;
    if (signal?.aborted) {
      const err = new Error('channel outbox send aborted for session ' + sessionId);
      err.name = 'AbortError';
      throw err;
    }

    const binding = await resolveBindingForSession(sessionId, this.bindingStore);
    const target: ChannelTarget = targetFromBinding(binding);

    const adapter = this.getAdapter(binding.channelId);
    if (!adapter) {
      throw new OutboxError(
        'OUTBOX_CAPABILITY_UNAVAILABLE',
        "no channel adapter for channel '" + binding.channelId + "'",
        { sessionId },
      );
    }

    const caps: OutboxCapabilities = resolveOutboxCapabilities(adapter);
    const hasText = !!request.text;
    const hasAttachment = !!request.attachmentId;
    if (!hasText && !hasAttachment) {
      throw new OutboxError(
        'OUTBOX_CAPABILITY_UNAVAILABLE',
        'a channel outbound send requires text and/or an attachment',
        { sessionId },
      );
    }
    if (hasText && !caps.proactiveText) {
      throw new OutboxError(
        'OUTBOX_CAPABILITY_UNAVAILABLE',
        "channel '" + binding.channelId + "' cannot proactively send text (proactiveText=false)",
        { sessionId },
      );
    }
    if (hasAttachment && !caps.proactiveMedia) {
      throw new OutboxError(
        'OUTBOX_CAPABILITY_UNAVAILABLE',
        "channel '" + binding.channelId + "' cannot proactively send media (proactiveMedia=false)",
        { sessionId },
      );
    }

    const message: OutboundMessage = { text: request.text };
    if (hasAttachment) {
      if (!this.attachmentResolver) {
        throw new OutboxError(
          'OUTBOX_CAPABILITY_UNAVAILABLE',
          'outbound attachments require a private asset store that is not configured',
          { sessionId },
        );
      }
      const asset = await this.attachmentResolver(request.attachmentId!, sessionId);
      message.parts = [
        {
          type: 'file',
          localData: asset.data,
          name: asset.name,
          ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
        },
      ];
    }

    this.logger.info(
      "[channel-harness] outbox send session='" + sessionId + "' channel='" + binding.channelId
        + "' text=" + hasText + ' attachment=' + hasAttachment,
    );
    const result = await adapter.send(target, message);
    this.logger.debug(
      "[channel-harness] outbox sent session='" + sessionId + "' delivered=" + result.delivered,
    );
    return result;
  }
}
