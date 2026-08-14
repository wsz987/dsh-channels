/**
 * `QQStreamingReply` — DSH `ReplyHandle` over a Tencent `StreamSession`.
 *
 * The Tencent stream API is **replace semantics**: `update(fullText)` always
 * receives the full accumulated text (never a delta). This class accumulates
 * deltas locally and forwards the monotonic full text on every change.
 */
import type { ReplyHandle, OutboundMessage } from '@dsh/channel-core';
import type { QQStreamSession } from './sdk-client.js';

export class QQStreamingReply implements ReplyHandle {
  private text = '';

  constructor(private readonly stream: QQStreamSession) {}

  async append(delta: string): Promise<void> {
    this.text += delta;
    await this.stream.update(this.text);
  }

  async replace(message: OutboundMessage): Promise<void> {
    this.text = message.text ?? '';
    await this.stream.update(this.text);
  }

  async finish(message?: OutboundMessage): Promise<void> {
    if (message?.text !== undefined && message.text !== this.text) {
      this.text = message.text;
      await this.stream.update(this.text);
    }
    await this.stream.complete();
  }

  async fail(): Promise<void> {
    this.stream.cancel();
  }
}
