/**
 * Inbound processing: dedup window + structured mapping + media hydration +
 * emit. Handles both `message` and `callback_query` updates.
 *
 * The getUpdates offset ack already prevents protocol-level redelivery; this
 * dedup window is the adapter-level second layer for redelivery inside one
 * cycle (e.g. a webhook-style retry with the same update_id).
 *
 * Media hydration runs after the duplicate check and before emit. The dedup
 * entry is committed only after emit succeeds, so a failed dispatch remains
 * retryable. Each `image` and
 * `file` part with an opaque Telegram `resourceRef` (file_id) is resolved and
 * downloaded through the platform upstream and its bytes are placed on
 * `localData`. A download failure never blocks text delivery — the part keeps
 * its `resourceRef` and records a stable `ingressFailure` code.
 *
 * ## Interactions (plan §5 / §12.2)
 *
 * A `callback_query` update maps to `interaction.received` with
 * `action = callback_data` (untrusted, zod-validated, never interpreted by the
 * adapter). The adapter immediately issues a best-effort `answerCallbackQuery`
 * ACK so Telegram clears the button progress spinner — this must NOT block on
 * agent resolution, so the ACK is fired and never gates the emit.
 */
import type {
  ChannelAdapterContext,
  MessagePart,
  MessageReceived,
} from '@wsz987/channel-core';
import type { InteractionReceived } from '@wsz987/channel-core';
import { hydrateTelegramParts, type TelegramFileResolver } from './media-hydrator.js';
import {
  dedupKey,
  isCallbackQueryUpdate,
  mapCallbackQuery,
  mapInbound,
  type TelegramInboundMeta,
} from './mapper.js';

/** Compact per-part summary for inbound message logs (debug diagnostics). */
function summarizeParts(parts: readonly MessagePart[]): unknown[] {
  return parts.map((part) => {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text.slice(0, 80) };
      case 'image':
        return {
          type: 'image',
          url: part.url,
          resourceRef: part.resourceRef,
          mimeType: part.mimeType,
          localDataBytes: part.localData?.byteLength,
          ingressFailure: part.ingressFailure,
        };
      case 'file':
        return {
          type: 'file',
          name: part.name,
          size: part.size,
          mimeType: part.mimeType,
          localDataBytes: part.localData?.byteLength,
          ingressFailure: part.ingressFailure,
        };
      case 'audio':
        return { type: 'audio', durationMs: part.durationMs, localDataBytes: part.localData?.byteLength };
      case 'video':
        return { type: 'video', durationMs: part.durationMs, localDataBytes: part.localData?.byteLength };
      default:
        return { type: part.type };
    }
  });
}

export interface InboundProcessorOptions {
  ctx: ChannelAdapterContext;
  meta: TelegramInboundMeta;
  dedupEnabled: boolean;
  dedupWindowMs: number;
  /** Platform file resolver used to hydrate image/file `resourceRef` parts. */
  files?: TelegramFileResolver;
  /** Hard byte cap for one inbound media download. */
  maxDownloadBytes?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /**
   * Best-effort `answerCallbackQuery` ACK for callback_query updates. The
   * adapter wires this to the upstream; the call is fired immediately and never
   * gates the emit (plan §12.2).
   */
  ackCallback?: (callbackQueryId: string) => Promise<void>;
}

export class InboundProcessor {
  private readonly now: () => number;
  /** dedup key -> last-seen timestamp, pruned on every handle. */
  private readonly seen = new Map<string, number>();

  constructor(private readonly options: InboundProcessorOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Process one raw update from the upstream; dedup, hydrate, then emit. */
  async handle(raw: unknown): Promise<void> {
    const key = dedupKey(raw);
    if (this.options.dedupEnabled) {
      const now = this.now();
      const last = this.seen.get(key);
      if (last !== undefined && now - last < this.options.dedupWindowMs) {
        this.options.ctx.logger.debug(`[channel-telegram] dropped duplicate update '${key}'`);
        return;
      }
      this.prune(now);
    }

    if (isCallbackQueryUpdate(raw)) {
      await this.handleCallbackQuery(raw);
      if (this.options.dedupEnabled) this.seen.set(key, this.now());
      return;
    }

    await this.handleMessage(raw);
    if (this.options.dedupEnabled) this.seen.set(key, this.now());
  }

  /** Map + ACK + emit a callback_query interaction. */
  private async handleCallbackQuery(raw: unknown): Promise<void> {
    const event: InteractionReceived = mapCallbackQuery(raw, this.options.meta);
    // Immediate best-effort ACK (clears the button spinner). It must never
    // block on agent resolution, so any failure is logged, not propagated to
    // the emit.
    if (this.options.ackCallback) {
      void this.options.ackCallback(event.interactionId).catch((error) => {
        this.options.ctx.logger.warn(
          '[channel-telegram] answerCallbackQuery failed',
          error instanceof Error ? error.message : error,
        );
      });
    }
    this.options.ctx.logger.info(
      `[channel-telegram] inbound interaction ${event.interactionId} from ${event.sender.id} in ${event.conversation.id}`,
      { action: event.action.slice(0, 80) },
    );
    await this.options.ctx.emit(event);
  }

  /** Map + hydrate + emit a message update. */
  private async handleMessage(raw: unknown): Promise<void> {
    const event: MessageReceived = mapInbound(raw, this.options.meta);
    if (this.options.files) {
      await hydrateTelegramParts(event.message.content, this.options.files, {
        maxBytes: this.options.maxDownloadBytes ?? 20 * 1024 * 1024,
        signal: this.options.ctx.signal,
        logger: this.options.ctx.logger,
      });
    }
    // Inbound message log (debug diagnostics): visible in web:debug with
    // DSH_CHANNELS_DEBUG=1, shows mapped parts incl. hydration result.
    this.options.ctx.logger.info(
      `[channel-telegram] inbound message ${event.message.id} from ${event.sender.id} in ${event.conversation.id}`,
      { parts: summarizeParts(event.message.content) },
    );
    await this.options.ctx.emit(event);
  }

  private prune(now: number): void {
    for (const [key, ts] of this.seen) {
      if (now - ts >= this.options.dedupWindowMs) this.seen.delete(key);
    }
  }
}
