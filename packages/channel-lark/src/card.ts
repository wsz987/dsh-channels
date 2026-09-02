/**
 * Lark CardKit 2.0 native streaming reply — the streaming reply
 * (`ReplyHandle`).
 *
 * Lark streaming rides the OFFICIAL CardKit native typewriter flow — never the
 * legacy `message.patch` pseudo-stream:
 *
 *   1. create a Card JSON 2.0 card entity with `streaming_mode: true`
 *      (`cardkit.v1.card.create`);
 *   2. send it as an interactive card reference
 *      (`im.v1.message.create` with `{ type: 'card', data: { card_id } }`);
 *   3. for every streamed delta, replace the markdown element's full content
 *      via `cardkit.v1.cardElement.content` with a monotonically increasing
 *      `sequence` and a stable `uuid` (idempotency);
 *   4. `finish()`/`fail()` close the stream by setting `streaming_mode: false`
 *      through `cardkit.v1.card.settings`, writing the final summary.
 *
 * Rollover: when a single markdown element approaches the platform's
 * ~30,000-char element cap (the official SDK's `Channel` guard), the handle
 * finalizes the current card, creates + sends a fresh streaming card, and
 * continues on it. `chunkIds` records every rollover card's message id.
 *
 * The handle does NOT throttle internally — ReplyRouter owns throttling via
 * config `reply.updateIntervalMs`. It guards no-op updates (skip when the text
 * is unchanged) and serializes card operations so concurrent router flushes
 * cannot interleave. State is observable for tests: `status`, `cardId`,
 * `text`, `error`, `sequence` and an `updates` record of applied operations.
 */
import type {
  ChannelLogger,
  ChannelTarget,
  OutboundMessage,
  ReplyHandle,
} from '@wsz987/channel-core';
import {
  STREAM_MARKDOWN_ELEMENT_ID,
  streamingCardJson,
} from './openapi-outbound.js';
import type { LarkUpstream } from './upstream.js';

export type LarkCardStatus = 'idle' | 'active' | 'finished' | 'failed';

/** One applied card operation (observable test surface). */
export interface LarkCardUpdate {
  kind: 'created' | 'streamed' | 'rollover' | 'finished' | 'failed';
  /** Card text at the time of the operation. */
  text?: string;
  /** Monotonic element sequence after the operation. */
  sequence?: number;
  /** Previous card entity id that a rollover finalized. */
  cardId?: string;
  /** Clock timestamp (injectable). */
  at: number;
  /** Error detail when the operation itself failed. */
  error?: string;
}

export interface LarkCardReplyOptions {
  /** The upstream outbound driver (official OpenAPI or an injected fake). */
  upstream: LarkUpstream;
  /** Conversation the card is attached to. */
  target: ChannelTarget;
  logger: ChannelLogger;
  /** Create the card on the first delta; otherwise only at `finish`. */
  createOnFirstDelta: boolean;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Hard cap for ONE markdown element before rolling over into a fresh card.
 * Feishu rejects oversized elements (error 230099); the official SDK's
 * high-level Channel uses the same 30,000-char default threshold.
 */
export const LARK_STREAM_ELEMENT_MAX_CHARS = 30_000;

/** Stable summary shown in chat previews while the card is still streaming. */
const GENERATING_SUMMARY = '[Generating...]';

export class LarkCardReply implements ReplyHandle {
  status: LarkCardStatus = 'idle';
  /** Current (latest) CardKit card entity; undefined until first create. */
  cardId?: string;
  /** Message id of the current card reference (changes on rollover). */
  messageId?: string;
  text = '';
  /** Monotonic per-element sequence (restarts on each rollover card). */
  sequence = 0;
  /** Every card sent during this reply, in order (the first is the primary one). */
  readonly chunkIds: string[] = [];
  /** Original failure value passed to `fail()`, if any. */
  error?: unknown;
  /** Ordered record of applied card operations. */
  readonly updates: LarkCardUpdate[] = [];

  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  /** A previous failure was already written to the card — do not overwrite it. */
  private failedShown = false;

  constructor(private readonly options: LarkCardReplyOptions) {
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
        // Nothing was streamed eagerly: create the final card now and write
        // the accumulated content into its markdown element (or do nothing
        // when there is no content to show).
        if (this.text) {
          await this.createCardAndSend();
          await this.pushContent(this.text);
        }
      } else if (needsSync) {
        await this.pushContent(this.text);
      }
      this.status = 'finished';
      if (this.cardId) {
        await this.closeStreaming(this.text);
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
      if (this.cardId && !this.failedShown) {
        try {
          // Write the failure into the card content first, then close the
          // stream. A secondary failure must NOT overwrite the original error.
          this.failedShown = true;
          await this.pushContent(this.text ? `${this.text}\n\n— _(Generation interrupted)_` : '— _(Generation interrupted)_');
          await this.closeStreaming(this.text || 'Generation failed');
          this.record('failed', this.text);
        } catch (secondary) {
          // Marking the card failed must not mask the original error.
          this.options.logger.error('[channel-lark] failed to mark card failed', secondary);
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
      await this.pushContent(this.text);
      return;
    }
    if (!this.options.createOnFirstDelta) return; // buffer until finish
    await this.createCardAndSend();
    await this.pushContent(this.text);
  }

  /** Create a CardKit entity and send its card reference (one-shot per card). */
  private async createCardAndSend(): Promise<void> {
    const cardJson = streamingCardJson('...', GENERATING_SUMMARY);
    const entity = await this.options.upstream.createCardEntity(cardJson);
    const sent = await this.options.upstream.sendCardEntity(this.options.target.conversationId, entity.cardId);
    this.cardId = entity.cardId;
    this.messageId = sent.messageId;
    this.sequence = 0;
    this.chunkIds.push(sent.messageId);
    this.status = 'active';
    this.record('created', this.text);
  }

  /**
   * Push the full element content through `cardElement.content`, rolling over
   * into a fresh card when the element exceeds the platform cap. Sequence is
   * monotonically increased and a stable uuid is derived from cardId +
   * sequence (idempotent on retry).
   */
  private async pushContent(content: string): Promise<void> {
    if (!this.cardId) return;
    if (content.length > LARK_STREAM_ELEMENT_MAX_CHARS) {
      await this.rollover(content);
      return;
    }
    this.sequence += 1;
    await this.options.upstream.updateCardElementContent(
      this.cardId,
      STREAM_MARKDOWN_ELEMENT_ID,
      content || ' ',
      this.sequence,
      uuidFor(this.cardId, this.sequence),
    );
    this.record('streamed', content, undefined, this.sequence);
  }

  /**
   * Finalize the current card with the head content and start a fresh
   * streaming card for the tail. Mirrors the official SDK Channel rollover:
   * the current element is pinned to the head, streaming is closed on it, and
   * a new streaming entity is created + sent seeded with the tail.
   */
  private async rollover(content: string): Promise<void> {
    if (!this.cardId) return;
    // A rollover cannot produce a single splittable piece below the cap.
    const chunks = splitForRollover(content, LARK_STREAM_ELEMENT_MAX_CHARS);
    const head = chunks[0]!;
    const tail = chunks.slice(1).join('\n');
    if (!tail) return; // nothing to continue with — keep on the current card

    // 1. Pin the current element to the head.
    this.sequence += 1;
    await this.options.upstream.updateCardElementContent(
      this.cardId,
      STREAM_MARKDOWN_ELEMENT_ID,
      head,
      this.sequence,
      uuidFor(this.cardId, this.sequence),
    );
    // 2. Close streaming on the old card (best-effort).
    try {
      await this.closeStreaming(head);
    } catch {
      // Feishu auto-closes an idle stream; a transient failure is recoverable.
    }
    // 3. Create + send the fresh streaming card seeded with the tail.
    const previousCardId = this.cardId;
    const cardJson = streamingCardJson(tail || '...', GENERATING_SUMMARY);
    const entity = await this.options.upstream.createCardEntity(cardJson);
    const sent = await this.options.upstream.sendCardEntity(this.options.target.conversationId, entity.cardId);
    this.cardId = entity.cardId;
    this.messageId = sent.messageId;
    this.sequence = 0;
    this.chunkIds.push(sent.messageId);
    this.record('rollover', tail, undefined, 0, previousCardId);
    // Continue streaming the tail immediately.
    this.sequence += 1;
    await this.options.upstream.updateCardElementContent(
      this.cardId,
      STREAM_MARKDOWN_ELEMENT_ID,
      tail || ' ',
      this.sequence,
      uuidFor(this.cardId, this.sequence),
    );
    this.record('streamed', tail, undefined, this.sequence);
  }

  /** Close the stream: `streaming_mode: false` + final summary. */
  private async closeStreaming(summaryText: string): Promise<void> {
    if (!this.cardId) return;
    this.sequence += 1;
    await this.options.upstream.finishStreamingCard(
      this.cardId,
      this.sequence,
      truncateSummary(summaryText),
    );
  }

  private record(
    kind: LarkCardUpdate['kind'],
    text?: string,
    error?: unknown,
    sequence?: number,
    cardId?: string,
  ): void {
    const update: LarkCardUpdate = {
      kind,
      text,
      at: this.now(),
    };
    if (sequence !== undefined) update.sequence = sequence;
    if (cardId !== undefined) update.cardId = cardId;
    if (error !== undefined) update.error = String(error);
    this.updates.push(update);
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

/** Stable request uuid derived from the card entity id + sequence. */
function uuidFor(cardId: string, sequence: number): string {
  return `c_${cardId}_${sequence}`;
}

/** Shorten markdown to a single-line preview for the card summary. */
export function truncateSummary(text: string, max = 50): string {
  if (!text) return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= max ? cleaned : `${cleaned.slice(0, max - 1)}…`;
}

/**
 * Split long content at ~`limit` chars while keeping fenced code blocks whole
 * (mirrors the official SDK Channel splitter). A single line that alone
 * exceeds `limit` (an unbreakable token) is hard-wrapped so the caller can
 * always roll over instead of being stuck with an oversized element.
 */
export function splitForRollover(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const lines = text.split('\n');
  const out: string[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  let fenceLang: string | null = null;
  const flush = (): void => {
    if (buf.length === 0) return;
    let chunk = buf.join('\n');
    if (fenceLang !== null) chunk += '\n```';
    out.push(chunk);
    buf = [];
    bufLen = 0;
    if (fenceLang !== null) {
      // Reopen the fence in the next chunk.
      buf.push(`\`\`\`${fenceLang}`);
      bufLen = buf[0]!.length;
    }
  };
  for (const line of lines) {
    const match = line.match(/^```(\w*)$/);
    const lineLen = line.length + (buf.length > 0 ? 1 : 0);
    const isHeading = /^#{1,6}\s/.test(line);
    const nearFull = bufLen > limit * 0.75;
    if (bufLen + lineLen > limit || (isHeading && nearFull && buf.length > 0)) {
      flush();
    }
    buf.push(line);
    bufLen += lineLen;
    if (match) {
      fenceLang = fenceLang === null ? (match[1] ?? '') : null;
    }
  }
  flush();
  // Hard-wrap any remaining oversized chunk (a single unbreakable line/token
  // cannot be split at a line boundary — never leave it above the cap).
  const final: string[] = [];
  for (const chunk of out) {
    if (chunk.length <= limit) {
      final.push(chunk);
      continue;
    }
    for (let i = 0; i < chunk.length; i += limit) {
      final.push(chunk.slice(i, i + limit));
    }
  }
  return final.length > 0 ? final : [text];
}
