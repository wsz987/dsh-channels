/**
 * Inbound processing: dedup window + structured mapping + emit.
 *
 * Input is the Tencent SDK's `QQBotInboundMessage`. Dedup keys on `messageId`
 * (DSH keeps its own dedup policy; the SDK middleware chain is unused). Only
 * `kind === 'c2c'` and `kind === 'group'` are accepted in V1 — anything else
 * (guild/dm) is logged and dropped.
 */
import type { ChannelAdapterContext, MessageReceived } from '@wsz987/channel-core';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { mapInbound, type QQInboundMeta } from './mapper.js';

export interface InboundProcessorOptions {
  ctx: ChannelAdapterContext;
  meta: QQInboundMeta;
  dedupEnabled: boolean;
  dedupWindowMs: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export class InboundProcessor {
  private readonly now: () => number;
  /** messageId -> last-seen timestamp, pruned on every handle. */
  private readonly seen = new Map<string, number>();

  constructor(private readonly options: InboundProcessorOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Process one SDK inbound message; dedup then emit. */
  async handle(raw: QQBotInboundMessage): Promise<void> {
    if (raw.kind !== 'c2c' && raw.kind !== 'group') {
      this.options.ctx.logger.debug(
        `[channel-qq] dropping unsupported inbound kind '${raw.kind}'`,
      );
      return;
    }

    const key = raw.messageId;
    if (this.options.dedupEnabled) {
      const now = this.now();
      const last = this.seen.get(key);
      if (last !== undefined && now - last < this.options.dedupWindowMs) {
        this.options.ctx.logger.debug(`[channel-qq] dropped duplicate message '${key}'`);
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
