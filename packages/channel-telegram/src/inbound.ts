/**
 * Inbound processing: dedup window + structured mapping + media hydration +
 * emit.
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
 */
import type {
  ChannelAdapterContext,
  MessagePart,
  MessageReceived,
} from '@wsz987/channel-core';
import { hydrateTelegramParts, type TelegramFileResolver } from './media-hydrator.js';
import { dedupKey, mapInbound, type TelegramInboundMeta } from './mapper.js';

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
    if (this.options.dedupEnabled) this.seen.set(key, this.now());
  }

  private prune(now: number): void {
    for (const [key, ts] of this.seen) {
      if (now - ts >= this.options.dedupWindowMs) this.seen.delete(key);
    }
  }
}
