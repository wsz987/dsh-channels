/**
 * Inbound processing: dedup window + structured mapping + emit.
 *
 * Message payloads map to `message.received`; interaction callbacks (card
 * button presses) route to `interaction.received` (Task 12.3). Both paths
 * share the same dedup window so webhook retries cannot double-deliver.
 */
import type { ChannelAdapterContext, MessageReceived, InteractionReceived } from '@dsh/channel-core';
import { dedupKey, mapInbound, mapInteraction, type LarkInboundMeta } from './mapper.js';

export interface InboundProcessorOptions {
  ctx: ChannelAdapterContext;
  meta: LarkInboundMeta;
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

  /** Process one raw payload from the upstream; dedup then emit. */
  async handle(raw: unknown): Promise<void> {
    const key = dedupKey(raw);
    if (this.options.dedupEnabled) {
      const now = this.now();
      const last = this.seen.get(key);
      if (last !== undefined && now - last < this.options.dedupWindowMs) {
        this.options.ctx.logger.debug(`[channel-lark] dropped duplicate payload '${key}'`);
        return;
      }
      this.seen.set(key, now);
      this.prune(now);
    }

    const kind = (raw as { type?: string } | null)?.type;
    if (kind === 'interaction') {
      const event: InteractionReceived = mapInteraction(raw, this.options.meta);
      await this.options.ctx.emit(event);
      return;
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
