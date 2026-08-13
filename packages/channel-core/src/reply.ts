/**
 * Reply pipeline helpers shared by the Harness bridge.
 *
 * `streaming` capability (`native` | `edit` | `buffered`) maps onto a reply
 * strategy; `BufferedReply` provides the generic accumulate-and-flush
 * implementation used by platforms without native streaming.
 */
import type { ChannelCapabilities } from './capabilities.js';
import type { ReplyHandle } from './adapter.js';
import type { OutboundMessage, SendResult } from './messages.js';

/** How a channel consumes incremental assistant output. */
export type ReplyStrategy = 'native' | 'edit' | 'buffered';

/** Derive the reply strategy from the adapter's streaming capability. */
export function replyStrategyFromCapabilities(capabilities: ChannelCapabilities): ReplyStrategy {
  return capabilities.streaming;
}

export interface BufferedReplyOptions {
  /** Text to send when the reply is finished. */
  deliver(text: string): Promise<SendResult>;
  /** Optional per-chunk hook (e.g. throttled preview). */
  onDelta?: (text: string) => Promise<void> | void;
}

/**
 * Generic accumulate-and-flush reply for platforms without native or
 * editable streaming. Deltas accumulate into a buffer; `finish()` delivers
 * once, `fail()` discards without delivery.
 */
export class BufferedReply implements ReplyHandle {
  private buffer = '';
  private finished = false;
  private failed = false;

  constructor(private readonly options: BufferedReplyOptions) {}

  async append(delta: string): Promise<void> {
    if (this.finished || this.failed) return;
    this.buffer += delta;
    await this.options.onDelta?.(this.buffer);
  }

  async replace(message: OutboundMessage): Promise<void> {
    if (this.finished || this.failed) return;
    if (message.text === undefined) return;
    this.buffer = message.text;
    await this.options.onDelta?.(this.buffer);
  }

  async finish(message?: OutboundMessage): Promise<void> {
    if (this.finished || this.failed) return;
    this.finished = true;
    const text = message?.text ?? this.buffer;
    if (text) {
      await this.options.deliver(text);
    }
  }

  async fail(): Promise<void> {
    this.failed = true;
    this.buffer = '';
  }
}
