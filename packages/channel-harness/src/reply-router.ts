/**
 * ReplyRouter — the outbound reply pipeline (architecture §19).
 *
 * Consumes only official `session/event` records:
 * - `assistant/chunk` (text-delta) feeds the reply buffer, throttled per
 *   strategy;
 * - `assistant/message` provides a fallback final text when no deltas flowed;
 * - `turn/end` flushes and finishes the reply, then cleans up.
 *
 * Strategy comes from the adapter's resolved streaming mode, which may be
 * target-aware (via `adapter.resolveStreamingMode(target)` falling back to the
 * static `adapter.capabilities.streaming`):
 * - `native`  — `adapter.createReply` + `handle.append` (throttled previews);
 * - `edit`    — `adapter.createReply` + `handle.replace` (throttled previews);
 * - `buffered` — accumulate and send once via `adapter.send` at `turn/end`
 *   (throttling is irrelevant for a send-once strategy).
 * An adapter without `createReply` is always `buffered`.
 *
 * The reply target is resolved by reversing `sessionId -> SessionBinding`,
 * never by inspecting the agent itself. Per-turn reply context (conversation
 * type + triggering message id) comes from the shared `ReplyContextStore`.
 *
 * The two concepts are deliberately separated (core hardening):
 * - `SessionBinding` answers "WHERE would a reply go" (the channel
 *   conversation ↔ session relation). It does NOT authorize outbound.
 * - `ReplyContext` answers "SHOULD this turn go back to the channel" — a turn
 *   is only routed when the store has an active context for `sessionId:turn`,
 *   which exists only because the turn was triggered by a channel inbound
 *   message (`register` → `agent/inbox/claimed` → `getTurn`).
 * Both are required: a turn driven by Web UI / CLI / steer / another plugin
 * on a channel-bound session has no `ReplyContext`, so it is never delivered
 * back to the channel.
 *
 * - `turn/start` only establishes turn existence (no active reply);
 * - `assistant/chunk` / `assistant/message` require an active `ReplyContext`
 *   (authoritative by then because `agent/inbox/claimed` fired first) and
 *   otherwise drop the output;
 * - `turn/end` releases the active context via `releaseTurn`.
 * The target passed to `createReply`/`send` carries the context so
 * target-aware adapters (e.g. QQ C2C native streaming) behave correctly.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';
import type { AssistantMessage } from '@deepseek-ai/dsh-llm';
import type {
  ChannelAdapter,
  ChannelLogger,
  ChannelTarget,
  ReplyHandle,
} from '@wsz987/channel-core';
import type { ReplyConfig } from './config.js';
import type { SessionBinding } from './session-router.js';
import type { ChannelReplyContext, ReplyContextStore } from './reply-context-store.js';
import { formatChannelTurnFailure } from './failure-display.js';

type ReplyStrategy = 'native' | 'edit' | 'buffered';

interface ActiveReply {
  binding: SessionBinding;
  strategy: ReplyStrategy;
  target: ChannelTarget;
  context?: ChannelReplyContext;
  handle: ReplyHandle | null;
  buffer: string;
  /** Fallback text from `assistant/message` when no deltas flowed. */
  finalText: string;
  timer: ReturnType<typeof setTimeout> | null;
  lastFlush: number;
  lastSentLength: number;
  turn: number;
  finished: boolean;
  /**
   * In-flight preview chain. Flushes are serialized: a delta arriving while a
   * flush is pending joins the running chain instead of starting a second
   * concurrent one (which would double-`createReply` on the same reply).
   */
  flushing: Promise<void> | null;
}

export interface ReplyRouterOptions {
  config: ReplyConfig;
  getAdapter(channelId: string): ChannelAdapter | undefined;
  getBinding(sessionId: string): SessionBinding | undefined;
  replyContexts: ReplyContextStore;
  logger: ChannelLogger;
}

export class ReplyRouter {
  private readonly active = new Map<string, ActiveReply>();

  constructor(private readonly options: ReplyRouterOptions) {}

  /** Register the `session/event` listener; returns a disposer. */
  attach(ctx: Context): () => boolean {
    return ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.onSessionEvent(session, event);
    });
  }

  /** Testable entry point; the registered listener delegates here. */
  onSessionEvent(session: Session, event: SessionEvent): void {
    switch (event.type) {
      case 'turn/start':
        // Turn existence only — no active reply is established here. Outbound
        // delivery requires a Channel ReplyContext (message-id → claimed →
        // turn), which is only authoritative once chunks flow. A non-channel
        // turn on a channel-bound session must NOT auto-route (see header).
        break;
      case 'assistant/chunk': {
        const { turn, chunk } = event.data;
        if (chunk.type === 'text-delta') {
          const active = this.ensureActive(session, turn);
          if (active) this.appendText(active, chunk.text);
        }
        break;
      }
      case 'assistant/message': {
        const text = assistantText(event.data.message);
        if (text) {
          const active = this.ensureActive(session, event.data.turn);
          if (active) active.finalText = text;
        }
        break;
      }
      case 'turn/end':
        void this.finishTurn(session, event.data.turn, event.data.reason);
        break;
    }
  }

  /** Session ids with an in-flight reply (used by the lifecycle drain). */
  activeSessions(): string[] {
    return [...this.active.keys()];
  }

  /**
   * Finalize every reply still marked active, exactly like `turn/end` would.
   * Turns still streaming at unload never deliver `turn/end`, so the lifecycle
   * drain calls this after `whenIdle` to guarantee buffered/final text is
   * delivered (or the reply handle fails) instead of being dropped.
   */
  async flushAll(): Promise<void> {
    for (const sessionId of [...this.active.keys()]) {
      const active = this.active.get(sessionId);
      if (active) await this.finalize(active, active.turn);
    }
  }

  /**
   * Durable-log reconcile (doc §4.3 / §4.4): deliver the final assistant text
   * for the last unfinished turn straight from the Session durable log, even
   * when the `session/event` listener is no longer attached.
   *
   * Finds the last `turn/start` with no matching `turn/end`; if the
   * ReplyRouter already holds an active reply for it, finalizes normally.
   * Otherwise it rebuilds the assistant text by replaying the turn's
   * `assistant/chunk` text-delta events (falling back to the
   * `assistant/message` text) and delivers it via `adapter.send` (buffered
   * strategy), then finishes/cleans up. The Session log is the ONLY source of
   * transcript truth — reconcile never maintains a second copy.
   */
  async reconcileSession(session: { id: string; events: readonly SessionEvent[] }): Promise<void> {
    const sessionId = String(session.id);
    const unfinished = lastUnfinishedTurn(session.events);
    if (!unfinished) return; // no unfinished turn to reconcile
    const { turn } = unfinished;
    const rebuilt = rebuildAssistantText(session.events, turn);

    // Same outbound gate as the live path: a durable-log turn with no active
    // ReplyContext was not channel-inbound, so it must not be delivered back
    // to the channel on unload.
    const context = this.options.replyContexts.getTurn(sessionId, turn);
    if (!context) {
      this.options.replyContexts.releaseTurn(sessionId, turn);
      return;
    }

    const active = this.active.get(sessionId);
    if (active && !active.finished) {
      // Already tracking this reply — finalize it normally with the durable
      // text as the authoritative content.
      active.buffer = rebuilt;
      if (rebuilt) active.finalText = rebuilt;
      await this.finalize(active, turn);
      return;
    }

    if (!rebuilt) {
      this.options.replyContexts.releaseTurn(sessionId, turn);
      return;
    }

    const binding = this.options.getBinding(sessionId);
    if (!binding) {
      this.options.logger.warn(`[channel-harness] reconcile: no session binding for '${sessionId}'`);
      this.options.replyContexts.releaseTurn(sessionId, turn);
      return;
    }
    const adapter = this.options.getAdapter(binding.channelId);
    if (!adapter) {
      this.options.logger.warn(
        `[channel-harness] reconcile: no adapter for channel '${binding.channelId}'`,
      );
      this.options.replyContexts.releaseTurn(sessionId, turn);
      return;
    }
    if (active?.handle) {
      // Deliver the missing remainder through the already-open reply handle.
      await active.handle.finish(rebuilt ? { text: rebuilt } : undefined).catch(() => {});
    } else {
      await this.deliver(adapter, targetFor(binding, context), rebuilt);
    }
    this.options.replyContexts.releaseTurn(sessionId, turn);
  }

  /** Clear all timers and drop active replies. */
  dispose(): void {
    for (const active of this.active.values()) {
      if (active.timer) clearTimeout(active.timer);
      active.finished = true;
    }
    this.active.clear();
  }

  private ensureActive(session: Session, turn: number): ActiveReply | null {
    const sessionId = String(session.id);

    // ReplyContext is the outbound gate: a turn without an active context was
    // not triggered by a channel inbound message, so it must never be routed
    // back to the channel (even if the session is channel-bound).
    const context = this.options.replyContexts.getTurn(sessionId, turn);
    if (!context) {
      return null;
    }

    const existing = this.active.get(sessionId);
    if (existing) {
      // Defensive refresh: re-resolve target/strategy if the context changed.
      // A session is single-flight (one turn at a time), so this is normally
      // a no-op.
      if (existing.context !== context) {
        existing.context = context;
        existing.target = targetFor(existing.binding, context);
        existing.strategy = strategyFor(
          this.options.getAdapter(existing.binding.channelId)!,
          existing.target,
        );
      }
      return existing;
    }

    const binding = this.options.getBinding(sessionId);
    if (!binding) {
      this.options.logger.warn(`[channel-harness] no session binding for '${sessionId}'`);
      return null;
    }
    const adapter = this.options.getAdapter(binding.channelId);
    if (!adapter) {
      this.options.logger.warn(
        `[channel-harness] no adapter for channel '${binding.channelId}'`,
      );
      return null;
    }
    const target = targetFor(binding, context);
    const active: ActiveReply = {
      binding,
      strategy: strategyFor(adapter, target),
      target,
      context,
      handle: null,
      buffer: '',
      finalText: '',
      timer: null,
      lastFlush: 0,
      lastSentLength: 0,
      turn,
      finished: false,
      flushing: null,
    };
    this.active.set(sessionId, active);
    return active;
  }

  private appendText(active: ActiveReply, delta: string): void {
    active.buffer += delta;
    const interval = this.options.config.updateIntervalMs;
    if (interval <= 0) {
      // updateIntervalMs: 0 — flush on every delta (deterministic testing).
      void this.flush(active);
      return;
    }
    const now = Date.now();
    if (now - active.lastFlush >= interval) {
      void this.flush(active);
      return;
    }
    if (!active.timer) {
      active.timer = setTimeout(() => {
        active.timer = null;
        void this.flush(active);
      }, interval - (now - active.lastFlush));
    }
  }

  /**
   * Enqueue a preview flush. Deltas are drained through a single in-flight
   * chain so concurrent deltas can never double-`createReply` on the same
   * reply; the chain reads the current buffer at execution time, so a flush
   * that started before the newest delta still covers it.
   */
  private flush(active: ActiveReply): void {
    if (active.finished) return;
    if (!active.flushing) {
      active.flushing = this.drain(active).finally(() => {
        active.flushing = null;
      });
    }
  }

  /** Drain all pending deltas, flushing until the buffer is fully sent. */
  private async drain(active: ActiveReply): Promise<void> {
    while (!active.finished) {
      if (active.strategy === 'buffered') return; // send-once: deliver at turn/end
      const sentBefore = active.lastSentLength;
      await this.doFlush(active);
      if (active.lastSentLength === sentBefore) return; // no progress — stop
    }
  }

  private async doFlush(active: ActiveReply): Promise<void> {
    if (active.finished) return;
    active.lastFlush = Date.now();
    if (active.buffer.length === active.lastSentLength) return;
    const adapter = this.options.getAdapter(active.binding.channelId);
    if (!adapter?.createReply) return;
    try {
      if (!active.handle) {
        active.handle = await adapter.createReply(active.target, {
          markdown: true,
        });
        // The owning scope may have finished while the card was created.
        if (active.finished) return;
      }
      if (active.strategy === 'edit') {
        await active.handle.replace({ text: active.buffer });
        active.lastSentLength = active.buffer.length;
      } else {
        const delta = active.buffer.slice(active.lastSentLength);
        active.lastSentLength = active.buffer.length;
        await active.handle.append(delta);
      }
    } catch (error) {
      await active.handle?.fail(error).catch(() => {});
      this.options.logger.error(
        `[channel-harness] reply flush failed for session '${active.binding.sessionId}'`,
        error,
      );
    }
  }

  private resolveTurnTarget(
    sessionId: string,
    context: ChannelReplyContext | undefined,
  ):
    | {
        binding: SessionBinding;
        adapter: ChannelAdapter;
        target: ChannelTarget;
      }
    | undefined {
    if (!context) return undefined;

    const binding = this.options.getBinding(sessionId);
    if (!binding) {
      this.options.logger.warn(`[channel-harness] no session binding for '${sessionId}'`);
      return undefined;
    }
    const adapter = this.options.getAdapter(binding.channelId);
    if (!adapter) {
      this.options.logger.warn(
        `[channel-harness] no adapter for channel '${binding.channelId}'`,
      );
      return undefined;
    }

    return { binding, adapter, target: targetFor(binding, context) };
  }

  private async finishTurn(
    session: Session,
    turn: number,
    reason: TurnEndReason,
  ): Promise<void> {
    const sessionId = String(session.id);
    const active = this.active.get(sessionId);
    // finalize() releases the reply context, so resolve it while it is still
    // the outbound authority for this terminal event.
    const context = this.options.replyContexts.getTurn(sessionId, turn);
    const terminalTarget = active
      ? (() => {
          const adapter = this.options.getAdapter(active.binding.channelId);
          return adapter
            ? { binding: active.binding, adapter, target: active.target }
            : undefined;
        })()
      : this.resolveTurnTarget(sessionId, context);

    try {
      // Existing assistant content retains its normal finalization path.
      if (active) await this.finalize(active, turn);

      // A terminal failure is a separate system notice, never part of model
      // output. The ReplyContext gate prevents Web/CLI turns from leaking to a
      // channel-bound conversation.
      if (reason.kind === 'error' && terminalTarget) {
        this.options.logger.error(
          `[channel-harness] Harness turn failed for session '${sessionId}'`,
          {
            turn,
            code: reason.error.code,
            status: reason.error.status,
            requestId: reason.error.requestId,
            providerRetryAfterMs: reason.error.providerRetryAfterMs,
          },
        );
        try {
          await this.deliver(
            terminalTarget.adapter,
            terminalTarget.target,
            formatChannelTurnFailure(reason.error),
          );
        } catch (error) {
          this.options.logger.error(
            `[channel-harness] failed to deliver turn error for session '${sessionId}'`,
            error,
          );
        }
      }
    } finally {
      // Active replies clean up in finalize(). No-output terminal turns need
      // the same release and typing cleanup even when delivery fails.
      if (!active) {
        this.options.replyContexts.releaseTurn(sessionId, turn);
        if (terminalTarget) {
          this.stopTypingIfSupported(
            terminalTarget.binding.channelId,
            terminalTarget.target,
          );
        }
      }
    }
  }

  /**
   * Finalize one active reply: clear its timer, drain any in-flight preview
   * chain, deliver the accumulated text (or fail the handle), and release the
   * active reply context for its turn (v1.1 §20). Shared by `turn/end`
   * handling and the lifecycle `flushAll()` so an unloaded turn is finalized
   * exactly like a completed one.
   */
  private async finalize(active: ActiveReply, turn: number): Promise<void> {
    if (active.timer) {
      clearTimeout(active.timer);
      active.timer = null;
    }
    this.active.delete(active.binding.sessionId);
    if (active.finished) return;
    // Let any in-flight preview chain drain first; otherwise the flush could
    // land an update on a card that is about to be finalized (orphan card).
    if (active.flushing) {
      await active.flushing.catch(() => {});
    }
    active.finished = true;

    const text = active.buffer.length > 0 ? active.buffer : active.finalText;
    const adapter = this.options.getAdapter(active.binding.channelId);
    if (!adapter) {
      this.options.logger.warn(
        `[channel-harness] no adapter for channel '${active.binding.channelId}'`,
      );
      // Still release the active context for this turn (v1.1 §20).
      this.options.replyContexts.releaseTurn(active.binding.sessionId, turn);
      return;
    }
    const target = active.target;
    try {
      if (active.handle) {
        // Pass the authoritative accumulated text: for `edit`, deltas pending
        // in the throttle window may not have been flushed to the handle yet,
        // so finalizing without them would drop content (M2 regression).
        await active.handle.finish(text ? { text } : undefined);
      } else if (active.strategy !== 'buffered' && adapter.createReply && text) {
        const handle = await adapter.createReply(target, { markdown: true });
        await handle.finish({ text });
      } else if (text) {
        await this.deliver(adapter, target, text);
      }
    } catch (error) {
      try {
        await active.handle?.fail(error);
      } catch {
        // Ignore secondary failure during fail.
      }
      this.options.logger.error(
        `[channel-harness] reply finish failed for session '${active.binding.sessionId}'`,
        error,
      );
    }
    // Release the active reply context for this turn (v1.1 §20).
    this.options.replyContexts.releaseTurn(active.binding.sessionId, turn);
    // Best-effort typing stop: a typing API failure must never break delivery.
    this.stopTypingIfSupported(active.binding.channelId, active.target);
  }

  private stopTypingIfSupported(channelId: string, target: ChannelTarget): void {
    const adapter = this.options.getAdapter(channelId);
    if (adapter?.stopTypingForTarget) {
      void adapter.stopTypingForTarget(target).catch(() => {});
    } else if (adapter?.stopTyping) {
      void adapter.stopTyping(target.conversationId).catch(() => {});
    }
  }

  private async deliver(
    adapter: ChannelAdapter,
    target: ChannelTarget,
    text: string,
  ): Promise<void> {
    if (!text) return;
    const max = this.options.config.maxTextLength;
    if (!max || text.length <= max) {
      await adapter.send(target, { text });
      return;
    }
    const pieces = splitMessage(text, max, this.options.config);
    for (const piece of pieces) {
      await adapter.send(target, { text: piece });
    }
  }
}

function strategyFor(adapter: ChannelAdapter, target: ChannelTarget): ReplyStrategy {
  const mode = adapter.resolveStreamingMode?.(target) ?? adapter.capabilities.streaming;
  if (adapter.createReply) {
    if (mode === 'native') return 'native';
    if (mode === 'edit') return 'edit';
  }
  return 'buffered';
}

function assistantText(message: AssistantMessage): string {
  let text = '';
  for (const block of message.content) {
    if (block.type === 'text') text += block.text;
  }
  return text;
}

function targetFor(binding: SessionBinding, context?: ChannelReplyContext): ChannelTarget {
  const target: ChannelTarget = {
    channelId: binding.channelId as ChannelTarget['channelId'],
    accountId: binding.accountId as ChannelTarget['accountId'],
    conversationId: binding.conversationId as ChannelTarget['conversationId'],
  };
  if (binding.threadId) {
    target.threadId = binding.threadId as ChannelTarget['threadId'];
  }
  if (context) {
    target.conversationType = context.conversationType;
    if (context.replyToMessageId) {
      target.replyToMessageId = context.replyToMessageId as ChannelTarget['replyToMessageId'];
    }
    if (context.raw !== undefined) {
      target.raw = context.raw;
    }
    if (context.runId) {
      target.runId = context.runId;
    }
  }
  return target;
}

/**
 * Find the last turn that started but never ended. Returns its turn number, or
 * `undefined` when every opened turn was closed.
 */
function lastUnfinishedTurn(events: readonly SessionEvent[]): { turn: number } | undefined {
  let lastOpen: number | undefined;
  for (const event of events) {
    if (event.type === 'turn/start') {
      lastOpen = event.data.turn;
    } else if (event.type === 'turn/end' && event.data.turn === lastOpen) {
      lastOpen = undefined;
    }
  }
  return lastOpen === undefined ? undefined : { turn: lastOpen };
}

/**
 * Rebuild the assistant text for one turn by replaying its `assistant/chunk`
 * text-delta events (in seq order), falling back to the `assistant/message`
 * text when no deltas flowed.
 */
function rebuildAssistantText(events: readonly SessionEvent[], turn: number): string {
  let text = '';
  let sawDelta = false;
  for (const event of events) {
    if (event.type === 'assistant/chunk' && event.data.turn === turn && event.data.chunk.type === 'text-delta') {
      text += event.data.chunk.text;
      sawDelta = true;
    }
  }
  if (sawDelta || text.length > 0) return text;
  for (const event of events) {
    if (event.type === 'assistant/message' && event.data.turn === turn) {
      const fallback = assistantText(event.data.message);
      if (fallback) return fallback;
    }
  }
  return '';
}

/**
 * Split a long message into `maxLength`-bounded pieces, keeping fenced code
 * blocks whole and preferring paragraph boundaries. `finalFlush: false`
 * drops a trailing partial piece instead of delivering it.
 */
export function splitMessage(
  text: string,
  maxLength: number,
  config: { splitParagraphs: boolean; splitCodeBlocks: boolean; finalFlush: boolean },
): string[] {
  if (text.length <= maxLength) return [text];
  const segments = config.splitCodeBlocks ? splitCodeSegments(text) : [text];
  const pieces: string[] = [];
  for (const segment of segments) {
    if (segment.length === 0) continue;
    if (segment.length <= maxLength) {
      pieces.push(segment);
      continue;
    }
    if (config.splitParagraphs) {
      pieces.push(...packSegments(segment, maxLength));
    } else {
      pieces.push(...hardWrap(segment, maxLength));
    }
  }
  if (!config.finalFlush && pieces.length > 1) {
    const last = pieces[pieces.length - 1];
    if (last && last.length < maxLength) pieces.pop();
  }
  return pieces;
}

function splitCodeSegments(text: string): string[] {
  const segments: string[] = [];
  const fence = /```[\s\S]*?```/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text))) {
    const before = text.slice(cursor, match.index);
    if (before) segments.push(before);
    segments.push(match[0]);
    cursor = match.index + match[0].length;
  }
  const rest = text.slice(cursor);
  if (rest) segments.push(rest);
  return segments.length > 0 ? segments : [text];
}

function packSegments(segment: string, maxLength: number): string[] {
  const paragraphs = segment.split(/\n\s*\n/);
  const pieces: string[] = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxLength) {
      const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
      if (candidate.length <= maxLength) {
        current = candidate;
      } else {
        if (current) pieces.push(current);
        current = paragraph;
      }
    } else {
      if (current) pieces.push(current);
      current = '';
      pieces.push(...hardWrap(paragraph, maxLength));
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function hardWrap(text: string, maxLength: number): string[] {
  const pieces: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > maxLength) {
      if (current) pieces.push(current);
      current = '';
      for (let i = 0; i < line.length; i += maxLength) {
        pieces.push(line.slice(i, i + maxLength));
      }
    } else {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length <= maxLength) {
        current = candidate;
      } else {
        pieces.push(current);
        current = line;
      }
    }
  }
  if (current) pieces.push(current);
  return pieces;
}
