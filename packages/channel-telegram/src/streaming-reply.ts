/**
 * `TelegramStreamingReply` — DSH `ReplyHandle` over Telegram edit streaming.
 *
 * Telegram streaming is modeled as: send one message, then edit it in place
 * with `editMessageText` as full-text previews arrive. This maps onto the
 * reply contract used by ReplyRouter for `streaming: 'edit'`:
 * - `replace(message)` -> create the message on first content, then edit
 * - `append(delta)`    -> accumulate and edit full text (kept for symmetry)
 * - `finish(message?)` -> send the final text (or create it if nothing was
 *   streamed) and close
 * - `fail(error)`      -> edit a short failure note when a message exists
 *
 * The handle does NOT throttle internally — ReplyRouter owns throttling via
 * config `reply.updateIntervalMs`. It guards no-op edits (skip when the text
 * is unchanged) and serializes operations so concurrent router flushes cannot
 * interleave.
 */
import type {
  ChannelTarget,
  OutboundMessage,
  ReplyHandle,
} from '@wsz987/channel-core';
import type { TelegramUpstream } from './upstream.js';

export class TelegramStreamingReply implements ReplyHandle {
  private text = '';
  private sentText: string | undefined;
  private messageId: string | undefined;
  private finalized = false;
  private queue: Promise<void> = Promise.resolve();
  private static readonly MAX_TEXT_LENGTH = 4096;

  constructor(
    private readonly upstream: TelegramUpstream,
    private readonly target: ChannelTarget,
    private readonly placeholder = '…',
  ) {}

  /** Send the initial placeholder message (called once by the adapter). */
  async start(): Promise<void> {
    if (this.messageId) return;
    const sent = await this.upstream.sendMessage(
      this.target.conversationId,
      truncateText(this.placeholder, TelegramStreamingReply.MAX_TEXT_LENGTH),
      targetOptions(this.target),
    );
    this.messageId = sent.messageId;
    this.sentText = truncateText(this.placeholder, TelegramStreamingReply.MAX_TEXT_LENGTH);
  }

  append(delta: string): Promise<void> {
    return this.replace({ text: this.text + delta });
  }

  replace(message: OutboundMessage): Promise<void> {
    return this.enqueue(async () => {
      if (this.finalized) return;
      if (message.text === undefined) return;
      this.text = message.text;
      await this.sync(false);
    });
  }

  finish(message?: OutboundMessage): Promise<void> {
    return this.enqueue(async () => {
      if (this.finalized) return;
      if (message?.text !== undefined) this.text = message.text;
      await this.sync(true);
      this.finalized = true;
    });
  }

  fail(error: unknown): Promise<void> {
    return this.enqueue(async () => {
      if (this.finalized) return;
      this.finalized = true;
      if (!this.messageId) return;
      try {
        await this.upstream.editMessageText(
          this.target.conversationId,
          this.messageId,
          truncateText(`Warning: ${messageOf(error)}`, TelegramStreamingReply.MAX_TEXT_LENGTH),
        );
      } catch {
        // Marking the message failed must not mask the original error.
      }
    });
  }

  /** Send or edit the full text when it changed since the last sent state. */
  private async sync(final: boolean): Promise<void> {
    if (!this.text) return;
    const chunks = splitText(this.text, TelegramStreamingReply.MAX_TEXT_LENGTH);
    const preview = chunks[0]!;
    if (this.messageId) {
      if (this.sentText !== preview) {
        await this.upstream.editMessageText(this.target.conversationId, this.messageId, preview);
      }
    } else {
      const sent = await this.upstream.sendMessage(
        this.target.conversationId,
        preview,
        targetOptions(this.target),
      );
      this.messageId = sent.messageId;
    }
    this.sentText = preview;
    if (final) {
      for (const chunk of chunks.slice(1)) {
        await this.upstream.sendMessage(this.target.conversationId, chunk, {
          messageThreadId: this.target.threadId,
        });
      }
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function targetOptions(target: ChannelTarget) {
  return {
    replyToMessageId: target.replyToMessageId,
    messageThreadId: target.threadId,
  };
}

function truncateText(text: string, maxLength: number): string {
  return Array.from(text).slice(0, maxLength).join('');
}

function splitText(text: string, maxLength: number): string[] {
  const characters = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < characters.length; index += maxLength) {
    chunks.push(characters.slice(index, index + maxLength).join(''));
  }
  return chunks;
}
