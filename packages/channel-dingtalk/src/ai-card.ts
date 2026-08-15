/**
 * DingTalk AI Card — the streaming reply (`ReplyHandle`).
 *
 * DingTalk streaming is modeled as: create card → update card with content
 * (status 'update') → finalize card (status 'finished') → failure card
 * (status 'failed'). This maps directly onto the reply contract:
 * - `append(delta)` / `replace(message)` → update the card body
 * - `finish()` → finalize the card
 * - `fail(error)` → mark the card failed
 *
 * The handle does NOT throttle internally — ReplyRouter owns throttling via
 * config `reply.updateIntervalMs`. It guards no-op updates (skip when the text
 * is unchanged) and serializes card operations so concurrent router flushes
 * cannot interleave. State is observable for tests: `status`, `cardId`,
 * `text`, `error` and an `updates` record of applied operations.
 */
import type {
  ChannelLogger,
  ChannelTarget,
  OutboundMessage,
  ReplyHandle,
} from '@wsz987/channel-core';
import type { DingTalkUpstream } from './upstream.js';

export type DingTalkCardStatus = 'idle' | 'active' | 'finished' | 'failed';

/** One applied card operation (observable test surface). */
export interface DingTalkCardUpdate {
  kind: 'created' | 'update' | 'finished' | 'failed';
  /** Card text at the time of the operation. */
  text?: string;
  /** Clock timestamp (injectable). */
  at: number;
  /** Error detail when the operation itself failed. */
  error?: string;
}

export interface DingTalkCardReplyOptions {
  upstream: DingTalkUpstream;
  /** Conversation the card is attached to. */
  target: ChannelTarget;
  logger: ChannelLogger;
  /** Create the card on the first delta; otherwise only at `finish`. */
  createOnFirstDelta: boolean;
  /** Injectable clock (tests). */
  now?: () => number;
}

export class DingTalkCardReply implements ReplyHandle {
  status: DingTalkCardStatus = 'idle';
  cardId?: string;
  text = '';
  /** Original failure value passed to `fail()`, if any. */
  error?: unknown;
  /** Ordered record of applied card operations. */
  readonly updates: DingTalkCardUpdate[] = [];

  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  /** Card API/template failures fall back to one final sessionWebhook text reply. */
  private cardUnavailable = false;

  constructor(private readonly options: DingTalkCardReplyOptions) {
    this.now = options.now ?? Date.now;
  }

  append(delta: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.finalized) return;
      if (!delta) return;
      this.text += delta;
      await this.push();
    });
  }

  replace(message: OutboundMessage): Promise<void> {
    return this.enqueue(async () => {
      if (this.finalized) return;
      if (message.text === undefined) return;
      // No-op guard: skip the network round-trip when nothing changed.
      if (message.text === this.text) return;
      this.text = message.text;
      await this.push();
    });
  }

  finish(message?: OutboundMessage): Promise<void> {
    return this.enqueue(async () => {
      if (this.finalized) return;
      const finalText = message?.text;
      let needsSync = false;
      if (finalText !== undefined && finalText !== this.text) {
        this.text = finalText;
        needsSync = true;
      }
      if (!this.cardId) {
        // Nothing was streamed eagerly: create the final card now, or a card
        // with no content when there is nothing to show.
        if (this.text) await this.createCard();
      } else if (needsSync) {
        await this.options.upstream.updateCard(this.cardId, this.text);
        this.record('update', this.text);
      }
      if (this.cardUnavailable && this.text) {
        await this.options.upstream.sendText(this.options.target, this.text);
        this.record('update', this.text);
      }
      this.status = 'finished';
      if (this.cardId) {
        await this.options.upstream.finishCard(this.cardId, this.text);
        this.record('finished', this.text);
      } else {
        this.record('finished', undefined);
      }
    });
  }

  fail(error: unknown): Promise<void> {
    return this.enqueue(async () => {
      if (this.finalized) return;
      this.error = error;
      this.status = 'failed';
      if (this.cardId) {
        try {
          await this.options.upstream.failCard(this.cardId, messageOf(error));
          this.record('failed', this.text);
        } catch (secondary) {
          // Marking the card failed must not mask the original error.
          this.options.logger.error('[channel-dingtalk] failed to mark card failed', secondary);
          this.record('failed', this.text, secondary);
        }
      } else {
        this.record('failed', this.text);
      }
    });
  }

  private get finalized(): boolean {
    return this.status === 'finished' || this.status === 'failed';
  }

  private async push(): Promise<void> {
    if (this.cardId) {
      await this.options.upstream.updateCard(this.cardId, this.text);
      this.record('update', this.text);
      return;
    }
    if (!this.options.createOnFirstDelta) return; // buffer until finish
    await this.createCard();
    if (this.cardUnavailable) return;
    await this.options.upstream.updateCard(this.cardId!, this.text);
    this.record('update', this.text);
  }

  private async createCard(): Promise<void> {
    if (this.cardUnavailable) return;
    try {
      const result = await this.options.upstream.createCard(this.options.target, this.text);
      this.cardId = result.cardId;
      this.status = 'active';
      this.record('created', this.text);
    } catch (error) {
      // A card may be disabled for an otherwise valid bot. The session webhook
      // can still deliver the completed answer, so defer that fallback to
      // finish() rather than losing the whole Harness reply.
      this.cardUnavailable = true;
      this.options.logger.warn('[channel-dingtalk] AI Card unavailable; falling back to text', error);
    }
  }

  private record(kind: DingTalkCardUpdate['kind'], text?: string, error?: unknown): void {
    this.updates.push({
      kind,
      text,
      at: this.now(),
      error: error !== undefined ? String(error) : undefined,
    });
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
