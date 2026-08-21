/**
 * `TelegramStreamingReply` — DSH `ReplyHandle` over Telegram edit streaming.
 *
 * Telegram streaming is modeled as: send one message, then edit it in place
 * with `editMessageText` as full-text previews arrive. This maps onto the
 * reply contract used by ReplyRouter for `streaming: 'edit'`:
 * - `replace(message)` -> create the message on first content, then edit
 * - `append(delta)`    -> accumulate and edit full text (kept for symmetry)
 * - `finish(message?)` -> render + send the final text and close
 * - `fail(error)`      -> edit a short failure note when a message exists
 *
 * ## Preview-freeze fix (plan §3.2 / §6.3 / §20.5)
 *
 * The old implementation always edited `chunks[0]`, so once the model passed
 * 4096 chars the first chunk stopped changing and the preview appeared frozen.
 * This version shows a *rolling preview*: up to 4096 visible chars it shows the
 * whole text; beyond that it shows `…` + the newest `4095` graphemes, so the
 * preview keeps visibly moving while the model streams. The final message is
 * always sent with complete, stable segmentation.
 *
 * ## Group rich final (plan §6.2)
 *
 * When configured for rich output on a non-DM target, `finish` upgrades the
 * same message to a Rich Message with `editMessageRich` (first segment) plus
 * `sendRichMessage` for any overflow. A formatting error falls back to plain
 * once; the preview phase always uses plain edits so partial Markdown never
 * triggers a rich parse (plan §20.5).
 *
 * ReplyRouter owns normal throttling via config `reply.updateIntervalMs`.
 * This handle additionally honors Telegram 429 cooldowns by retaining only
 * the newest desired preview until the retry window expires.
 */
import type {
  ChannelTarget,
  OutboundMessage,
  ReplyHandle,
} from '@wsz987/channel-core';
import type { TelegramUpstream } from './upstream.js';
import { TelegramApiError } from './api-error.js';
import { REGULAR_MESSAGE_MAX } from './rich-message.js';
import { truncateGraphemes, tailGraphemes, visibleLength, splitByGraphemes } from './render/segment.js';
import { sendWithFallback, type RenderOptions } from './render/index.js';

export interface TelegramStreamingReplyOptions {
  /** Output formatting policy for the final message (mode/fallback). */
  formatting?: Partial<RenderOptions>;
  /**
   * When true and rich formatting is active, `finish` edits the SAME message
   * into a Rich Message (group path); otherwise the final is plain text.
   */
  richFinal?: boolean;
}

export class TelegramStreamingReply implements ReplyHandle {
  private text = '';
  private sentPreview: string | undefined;
  private messageId: string | undefined;
  private finalized = false;
  private queue: Promise<void> = Promise.resolve();
  /** Latest desired preview; deliberately not an edit queue. */
  private pendingPreview: string | undefined;
  private cooldownUntil = 0;
  private cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  private finishing = false;

  constructor(
    private readonly upstream: TelegramUpstream,
    private readonly target: ChannelTarget,
    private readonly placeholder = '…',
    private readonly options: TelegramStreamingReplyOptions = {},
  ) {}

  /** Send the initial placeholder message (called once by the adapter). */
  async start(): Promise<void> {
    if (this.messageId) return;
    const preview = makePreview(this.placeholder, REGULAR_MESSAGE_MAX);
    const sent = await this.upstream.sendMessage(
      this.target.conversationId,
      preview,
      targetOptions(this.target),
    );
    this.messageId = sent.messageId;
    this.sentPreview = preview;
  }

  append(delta: string): Promise<void> {
    return this.replace({ text: this.text + delta });
  }

  replace(message: OutboundMessage): Promise<void> {
    return this.enqueue(async () => {
      if (this.finalized || this.finishing) return;
      if (message.text === undefined) return;
      this.text = message.text;
      this.pendingPreview = makePreview(this.text, REGULAR_MESSAGE_MAX);
      await this.sync(false);
    });
  }

  finish(message?: OutboundMessage): Promise<void> {
    // Suppress a deferred preview immediately. `finish` itself may wait in the
    // operation queue behind one in-flight edit, but no newer preview should
    // be sent once the turn has ended.
    this.finishing = true;
    this.clearCooldownTimer();
    return this.enqueue(async () => {
      if (this.finalized) return;
      if (message?.text !== undefined) this.text = message.text;
      this.pendingPreview = undefined;
      await this.sync(true);
      this.finalized = true;
    });
  }

  fail(error: unknown): Promise<void> {
    return this.enqueue(async () => {
      if (this.finalized) return;
      if (isRateLimitError(error)) return;
      this.finalized = true;
      if (!this.messageId) return;
      const text = truncateGraphemes(`Warning: ${messageOf(error)}`, REGULAR_MESSAGE_MAX);
      try {
        await this.upstream.editMessageText(this.target.conversationId, this.messageId, text);
      } catch {
        // Marking the message failed must not mask the original error.
      }
    });
  }

  /** Edit the rolling preview now; on `final` render + send the complete result. */
  private async sync(final: boolean): Promise<void> {
    if (!this.text) return;
    if (final) {
      await this.waitForCooldown();
      await this.sendFinal();
      return;
    }
    if (!this.messageId) return;
    const preview = this.pendingPreview ?? makePreview(this.text, REGULAR_MESSAGE_MAX);
    if (this.finishing || this.isCoolingDown()) {
      this.pendingPreview = preview;
      if (!this.finishing) this.scheduleCooldownFlush();
      return;
    }
    if (this.sentPreview !== preview) {
      this.pendingPreview = undefined;
      try {
        await this.upstream.editMessageText(this.target.conversationId, this.messageId, preview);
        this.sentPreview = preview;
      } catch (error) {
        if (!isRateLimitError(error)) throw error;
        if (this.pendingPreview === undefined) this.pendingPreview = preview;
        this.startCooldown(error);
      }
    }
  }

  /**
   * Send the final message. Plain mode: first chunk edits the existing message,
   * overflow chunks are sent as new messages. Rich mode (richFinal + rich
   * formatting): upgrade the same message to a Rich Message; fall back to plain
   * once on a format error.
   */
  private async sendFinal(): Promise<void> {
    const mode = this.options.formatting?.mode ?? 'auto';
    if (this.options.richFinal && mode !== 'plain') {
      await this.sendRichFinal();
      return;
    }
    const chunks = splitByGraphemes(this.text, REGULAR_MESSAGE_MAX);
    if (this.messageId && this.sentPreview !== chunks[0]) {
      await this.editFinalText(chunks[0] ?? '');
      this.sentPreview = chunks[0];
    } else if (!this.messageId) {
      const sent = await this.upstream.sendMessage(
        this.target.conversationId,
        chunks[0] ?? '',
        targetOptions(this.target),
      );
      this.messageId = sent.messageId;
    }
    for (const chunk of chunks.slice(1)) {
      await this.upstream.sendMessage(this.target.conversationId, chunk, {
        messageThreadId: this.target.threadId,
      });
    }
  }

  /** Upgrade the in-place message to a Rich Message with plain-once fallback. */
  private async sendRichFinal(): Promise<void> {
    const source = this.text;
    if (!source) return;
    await sendWithFallback(source, { mode: 'rich-markdown' }, async (plan) => {
      if (plan.kind === 'rich') {
        // Edit the same message into the first rich segment; overflow as new
        // rich messages.
        if (this.messageId) {
          await this.editFinalRich({ markdown: plan.texts[0] ?? '' });
        }
        for (const text of plan.texts.slice(1)) {
          await this.upstream.sendRichMessage(this.target.conversationId, { markdown: text });
        }
        return;
      }
      // Plain fallback on the same message + new overflow messages.
      if (this.messageId) {
        await this.editFinalText(plan.chunks[0] ?? '');
      } else {
        const sent = await this.upstream.sendMessage(
          this.target.conversationId,
          plan.chunks[0] ?? '',
          targetOptions(this.target),
        );
        this.messageId = sent.messageId;
      }
      for (const chunk of plan.chunks.slice(1)) {
        await this.upstream.sendMessage(this.target.conversationId, chunk, {
          messageThreadId: this.target.threadId,
        });
      }
    });
  }

  /** Retry only the in-place final edit after a Telegram-requested cooldown. */
  private async editFinalText(text: string): Promise<void> {
    while (true) {
      await this.waitForCooldown();
      try {
        await this.upstream.editMessageText(this.target.conversationId, this.messageId!, text);
        return;
      } catch (error) {
        if (!isRateLimitError(error)) throw error;
        this.startCooldown(error);
      }
    }
  }

  /** The rich final path uses Telegram's edit endpoint too, so it shares 429 recovery. */
  private async editFinalRich(message: { markdown: string }): Promise<void> {
    while (true) {
      await this.waitForCooldown();
      try {
        await this.upstream.editMessageRich(this.target.conversationId, this.messageId!, message);
        return;
      } catch (error) {
        if (!isRateLimitError(error)) throw error;
        this.startCooldown(error);
      }
    }
  }

  private isCoolingDown(): boolean {
    return Date.now() < this.cooldownUntil;
  }

  /** Honor the server's retry hint, extending (never shortening) cooldown. */
  private startCooldown(error: TelegramApiError): void {
    const retryAfter = error.parameters?.retryAfter;
    const delayMs = Number.isFinite(retryAfter)
      ? Math.max(1, Math.ceil(retryAfter!)) * 1000
      : 1000;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delayMs);
    this.scheduleCooldownFlush();
  }

  /** One timer, one latest-value flush. It never replays a sequence of edits. */
  private scheduleCooldownFlush(): void {
    if (this.finishing || this.finalized || this.cooldownTimer || !this.pendingPreview) return;
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = undefined;
      void this.enqueue(() => this.sync(false)).catch(() => {});
    }, Math.max(1, this.cooldownUntil - Date.now()));
  }

  private clearCooldownTimer(): void {
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = undefined;
  }

  private async waitForCooldown(): Promise<void> {
    while (this.isCoolingDown()) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.max(1, this.cooldownUntil - Date.now()));
      });
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

function isRateLimitError(error: unknown): error is TelegramApiError {
  return error instanceof TelegramApiError && error.kind === 'rate-limit';
}

function targetOptions(target: ChannelTarget) {
  return {
    replyToMessageId: target.replyToMessageId,
    messageThreadId: target.threadId,
  };
}

/**
 * Build a rolling preview for an in-progress stream: show the whole text up to
 * `limit`, otherwise `…` + the newest `limit - 1` graphemes. This keeps the
 * preview visibly changing once the model exceeds the single-message limit
 * (plan §6.3), fixing the frozen `chunks[0]` behaviour.
 */
export function makePreview(text: string, limit: number): string {
  return makeRollingPreview(text, limit);
}

/** Internal: rolling head/tail preview implementation. */
function makeRollingPreview(text: string, limit: number): string {
  if (visibleLength(text) <= limit) return text;
  // Show `…` + the newest (limit-1) graphemes so the user sees output continue.
  return `…${tailGraphemes(text, limit - 1)}`;
}
