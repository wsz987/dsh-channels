/**
 * Inbound processing: dedup window + structured mapping + emit.
 *
 * The getUpdates offset ack already prevents protocol-level redelivery; this
 * dedup window is the adapter-level second layer for redelivery inside one
 * cycle (e.g. a webhook-style retry with the same update_id).
 */
import type { ChannelAdapterContext, MessageReceived } from '@wsz987/channel-core';
import { dedupKey, mapInbound, type TelegramInboundMeta } from './mapper.js';

export interface InboundProcessorOptions {
  ctx: ChannelAdapterContext;
  meta: TelegramInboundMeta;
  dedupEnabled: boolean;
  dedupWindowMs: number;
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

  /** Process one raw update from the upstream; dedup then emit. */
  async handle(raw: unknown): Promise<void> {
    const key = dedupKey(raw);
    if (this.options.dedupEnabled) {
      const now = this.now();
      const last = this.seen.get(key);
      if (last !== undefined && now - last < this.options.dedupWindowMs) {
        this.options.ctx.logger.debug(`[channel-telegram] dropped duplicate update '${key}'`);
        return;
      }
      this.seen.set(key, now);
      this.prune(now);
    }
    const event: MessageReceived = mapInbound(raw, this.options.meta);
    await this.options.ctx.emit(event);
  }

  private prune(now: number): void {
    for (const [key, ts] of this.seen) {
      if (now - ts >= this.options.dedupWindowMs) this.seen.delete(key);
    }
  }
}
