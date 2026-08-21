/**
 * `TelegramRichStreamingReply` — DSH `ReplyHandle` over Bot API 10.1 rich
 * drafts (plan §6.1 / §20.4).
 *
 * For private DMs with rich output active, the plan replaces per-delta
 * `editMessageText` with the native rich draft flow:
 *
 *   sendRichMessageDraft(draft_id)   → 30s temporary preview, updated in place
 *   … (throttled by ReplyRouter)     →  same draft_id re-sent with the growing
 *                                       partial Markdown
 *   sendRichMessage(final)           →  persists the final result; the draft
 *                                       preview is superseded
 *
 * The draft is inherently *partial-safe*: the server renders whatever has been
 * sent so far, so an unfinished code fence / table / link never breaks the
 * pipeline (plan §20.4 Partial Markdown Gate). Only the final `sendRichMessage`
 * renders the *complete* Markdown; on a format failure the final falls back to
 * plain text once (never an infinite rich→plain→rich loop).
 *
 * The handle does NOT throttle internally — ReplyRouter owns throttling via
 * config `reply.updateIntervalMs`. Operations are serialized so concurrent
 * router flushes cannot interleave.
 */
import type { ChannelTarget, OutboundMessage, ReplyHandle } from '@wsz987/channel-core';
import type { TelegramUpstream } from './upstream.js';
import { TelegramApiError } from './api-error.js';
import { RICH_MESSAGE_MAX_UTF8 } from './rich-message.js';
import { truncateGraphemes } from './render/segment.js';
import { sendWithFallback, type RenderOptions } from './render/index.js';

/** A non-zero integer that identifies this reply stream across draft updates. */
function newDraftId(): number {
  const value = globalThis.crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return value === 0 ? 1 : value;
}

export interface TelegramRichStreamingReplyOptions {
  /** Output formatting policy (mode/fallback) for the final rich send. */
  formatting?: Partial<RenderOptions>;
}

export class TelegramRichStreamingReply implements ReplyHandle {
  private text = '';
  private draftId: number;
  private started = false;
  private finalized = false;
  private draftPending = false;
  private finalPending = false;
  private cooldownUntil = 0;
  private cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly upstream: TelegramUpstream,
    private readonly target: ChannelTarget,
    private readonly placeholder = '…',
    private readonly options: TelegramRichStreamingReplyOptions = {},
    draftId?: number,
  ) {
    this.draftId = draftId ?? newDraftId();
  }

  get activeDraftId(): number {
    return this.draftId;
  }

  /** Open the temporary draft preview. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.draftPending = true;
    await this.flushDraft(this.placeholder);
  }

  append(delta: string): Promise<void> {
    return this.replace({ text: this.text + delta });
  }

  replace(message: OutboundMessage): Promise<void> {
    return this.enqueue(async () => {
      if (this.finalized) return;
      if (message.text === undefined) return;
      this.text = message.text;
      this.draftPending = true;
      await this.flushDraft();
    });
  }

  finish(message?: OutboundMessage): Promise<void> {
    return this.enqueue(async () => {
      if (this.finalized) return;
      if (message?.text !== undefined) this.text = message.text;
      this.draftPending = false;
      this.finalPending = true;
      await this.flushFinal();
    });
  }

  fail(error: unknown): Promise<void> {
    return this.enqueue(async () => {
      if (this.finalized) return;
      if (isRateLimit(error)) return;
      this.finalized = true;
      this.clearCooldown();
      const msg = `Warning: ${messageOf(error)}`;
      try {
        await sendWithFallback(msg, { mode: 'plain' }, (plan) => {
          const text = plan.kind === 'rich' ? (plan.texts[0] ?? '') : (plan.chunks[0] ?? '');
          return this.upstream.sendMessage(this.target.conversationId, text);
        });
      } catch {
        // Marking failure must not mask the original error.
      }
    });
  }

  /** Re-send the same draft id with the newest partial Markdown preview. */
  private async flushDraft(placeholder?: string): Promise<void> {
    if (!this.started || !this.draftPending || this.inCooldown()) return;
    const source = this.text || placeholder;
    if (!source) return;
    try {
      await this.upstream.sendRichMessageDraft(
        this.target.conversationId,
        this.draftId,
        { markdown: truncateGraphemes(source, RICH_MESSAGE_MAX_UTF8) },
        targetOptions(this.target),
      );
      this.draftPending = false;
    } catch (error) {
      if (!isRateLimit(error)) throw error;
      this.enterCooldown(error);
    }
  }

  /**
   * Persist the final result. For DM rich mode the final is one (or, when
   * overflowing, several) `sendRichMessage` calls carrying the complete
   * Markdown; a format failure falls back to plain exactly once.
   */
  private async flushFinal(): Promise<void> {
    if (!this.finalPending || this.inCooldown()) return;
    try {
      await this.sendFinal();
      this.finalPending = false;
      this.finalized = true;
      this.clearCooldown();
    } catch (error) {
      if (!isRateLimit(error)) throw error;
      this.enterCooldown(error);
    }
  }

  private async sendFinal(): Promise<void> {
    const options: RenderOptions = {
      mode: this.options.formatting?.mode ?? 'auto',
    };
    const source = this.text;
    if (!source) return;
    await sendWithFallback(source, options, async (plan) => {
      if (plan.kind === 'rich') {
        for (const text of plan.texts) {
          await this.upstream.sendRichMessage(this.target.conversationId, { markdown: text }, targetOptions(this.target));
        }
        return;
      }
      // plain fallback path.
      for (const chunk of plan.chunks) {
        await this.upstream.sendMessage(
          this.target.conversationId,
          chunk,
          targetOptions(this.target),
          plan.parseMode ? { parseMode: plan.parseMode } : undefined,
        );
      }
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

  private inCooldown(): boolean {
    if (Date.now() >= this.cooldownUntil) return false;
    this.scheduleCooldown();
    return true;
  }

  /** Keep only the current draft/final state while Telegram asks us to wait. */
  private enterCooldown(error: TelegramApiError): void {
    const seconds = error.parameters?.retryAfter;
    const delay = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
      ? Math.ceil(seconds * 1000)
      : 1_000;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + delay);
    this.scheduleCooldown();
  }

  private scheduleCooldown(): void {
    if (this.cooldownTimer || this.finalized) return;
    const delay = Math.max(0, this.cooldownUntil - Date.now());
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = undefined;
      void this.enqueue(async () => {
        if (this.finalized) return;
        if (this.finalPending) {
          await this.flushFinal();
        } else {
          await this.flushDraft();
        }
      });
    }, delay);
  }

  private clearCooldown(): void {
    this.cooldownUntil = 0;
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = undefined;
    }
  }
}

function isRateLimit(error: unknown): error is TelegramApiError {
  return error instanceof TelegramApiError || (
    typeof error === 'object'
    && error !== null
    && 'kind' in error
    && error.kind === 'rate-limit'
  );
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
