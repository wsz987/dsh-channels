/**
 * Unified question backend: the official `user-questions/request` waterfall.
 *
 * Since dsh 0.1.2 the question domain (`ask_user_question` ->
 * `ctx.userQuestions.ask`) dispatches a Cordis waterfall event instead of
 * using a single registered `UserQuestionProvider`: every interested surface
 * composes an answerer listener, claims the request by returning an answer,
 * or delegates with `next()` (the official service rejects with
 * `UserQuestionError` `NO_PROVIDER` when the whole waterfall delegates).
 * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`) admits untagged
 * listeners globally, so ONE root-level listener serves every profile:
 *
 * - headless: the channel is typically the only answerer — the old direct
 *   backend semantics (declined presentation fails the ask) survive as
 *   "decline -> next() -> NO_PROVIDER";
 * - web profile: the official Web UI composes its own answerer on the same
 *   waterfall, so a channel decline now DELEGATES to it instead of racing a
 *   duplicate provider registration. This replaces the retired ApiProxy
 *   question mux (dsh-host-apiproxy was removed in 0.1.2).
 *
 * The listener is registered on the ROOT context in `start()`; per-request
 * settlement follows the official provider semantics observed in the former
 * ApiProxy reference implementation: an abort or teardown rejects the ask
 * with `UserQuestionError` (`ASK_ABORTED`).
 *
 * ## Why the listener is PREPENDED (ordering IS a contract)
 *
 * The scoped dispatch admits untagged root listeners, but a Cordis waterfall
 * is SEQUENTIAL: the first listener that returns an answer vetoes every later
 * one. The shipped `web` profile composes the official Remote/Web answerer
 * (`@deepseek-ai/dsh-api-remotes`) on this same event, and that fiber applies
 * at boot — long before the bridge (it only waits for `typertGateway`, while
 * the bridge waits for `channels`) — so a plain `ctx.on()` registration loses
 * every channel-bound ask to the browser:
 *
 * - a connected client materializes the Agent scope for ANY forwarded ask and
 *   holds it until the human answers in the Web UI (`dsh-client-ui-user-questions`
 *   claims whenever `sessions.scopeOf(owner)` resolves), so the channel never
 *   sees the request;
 * - with no client connected the forwarded request is parked in the gateway
 *   (`pendingRemoteEvents`) with nobody to deliver it to and no auto-`next()`,
 *   so the channel still never sees it.
 *
 * Prepending inverts that: a channel-bound conversation claims its own ask
 * (buttons where the platform supports them, numbered-text fallback
 * otherwise), and every ask the channel cannot present — no binding, no
 * active reply context, unsupported text, or one already pending on that
 * conversation — still delegates through `next()` to the Web answerer.
 */
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type UserQuestionService,
} from '@deepseek-ai/dsh-user-questions';
import type { AskUserQuestionRequestEvent } from '@deepseek-ai/dsh-user-questions/types';
import type { ChannelLogger } from '@wsz987/channel-core';
import type {
  QuestionInteractionBackend,
  QuestionInteractionCancellation,
  QuestionInteractionResolution,
  QuestionInteractionSink,
} from './question-backend.js';

/**
 * Narrow view over the official `ctx.userQuestions` service — the channel
 * only probes its presence; asks are received via the waterfall event.
 */
export type ChannelUserQuestionService = UserQuestionService;

interface PendingAsk {
  key: string;
  resolve: (answer: AskUserQuestionAnswer) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface WaterfallQuestionBackendOptions {
  /** Root Cordis context the `user-questions/request` listener registers on. */
  ctx: Context;
  logger: ChannelLogger;
}

/**
 * The channel's answerer on the official question waterfall. One listener
 * instance serves every Agent (untagged root registration receives all
 * agent-scoped dispatches); requests the channel cannot present are
 * delegated to the next answerer via `next()`.
 */
export class WaterfallQuestionBackend implements QuestionInteractionBackend {
  readonly kind = 'waterfall' as const;

  private sink?: QuestionInteractionSink;
  private readonly pending = new Map<string, PendingAsk>();
  private disposeListener?: () => void;

  constructor(private readonly options: WaterfallQuestionBackendOptions) {}

  start(sink: QuestionInteractionSink): void {
    if (this.disposeListener) return;
    this.sink = sink;
    // `prepend: true` — see the class header: the official Remote/Web
    // answerer registers first in the shipped web profile and would
    // otherwise veto every channel-bound ask.
    this.disposeListener = this.options.ctx.on(
      'user-questions/request',
      (request, next) => this.answer(request, next),
      { prepend: true },
    );
  }

  async stop(): Promise<void> {
    this.sink = undefined;
    this.disposeListener?.();
    this.disposeListener = undefined;
    for (const pending of [...this.pending.values()]) {
      this.settle(pending, () => {
        pending.reject(
          new UserQuestionError('channel user-questions answerer was disposed', 'ASK_ABORTED'),
        );
      });
    }
  }

  async resolve(submission: QuestionInteractionResolution): Promise<void> {
    const pending = this.pending.get(submission.key);
    if (!pending) return;
    this.settle(pending, () => pending.resolve(submission.answer));
  }

  async cancel(cancellation: QuestionInteractionCancellation): Promise<void> {
    const pending = this.pending.get(cancellation.key);
    if (!pending) return;
    this.settle(pending, () => {
      pending.reject(new UserQuestionError(cancellation.reason, 'ASK_ABORTED'));
    });
  }

  /**
   * One official waterfall ask. The channel claims the request by presenting
   * it on the bound conversation and parking the answer promise; a declined
   * presentation (no bound conversation, one already pending there, adapter
   * absent / text unsupported) delegates to the next answerer.
   */
  private async answer(
    request: AskUserQuestionRequestEvent,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    const sink = this.sink;
    // An ask without its owning live agent has no session to bind to a
    // channel conversation — never the channel's business.
    if (!sink || request.agent === undefined) return next();
    const sessionId = String(request.agent.id);
    const key = `waterfall-${randomUUID()}`;
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const pending: PendingAsk = {
        key,
        resolve,
        reject,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      };
      const onAbort = (): void => {
        this.settle(pending, () => {
          reject(
            new UserQuestionError(
              'ask_user_question was aborted before the user answered',
              'ASK_ABORTED',
            ),
          );
        });
        // Drop the channel-side presentation (buttons/state) after the ask
        // itself settled; a racing channel answer becomes a backend no-op.
        void sink.questionSettledExternally(key, 'aborted');
      };
      pending.onAbort = onAbort;
      request.signal?.addEventListener('abort', onAbort, { once: true });
      // Park the pending entry BEFORE presenting: the presenter hands the key
      // to channel interactions, which resolve through `resolve()`/`cancel()`.
      this.pending.set(key, pending);
      void sink
        .questionRequested({ key, sessionId, questions: request.questions })
        .then(async (accepted) => {
          if (accepted || !this.pending.has(key)) return;
          // The channel declined ownership — remove the parked entry and let
          // the next answerer (e.g. the official Web UI) take the request.
          this.settle(pending, () => {});
          resolve(await next());
        })
        .catch((error: unknown) => {
          if (this.pending.has(key)) {
            this.settle(pending, () => reject(error));
            return;
          }
          // Decline-path `next()` failure (e.g. NO_PROVIDER when no further
          // answerer claims): the parked entry is already gone, so the ask
          // promise itself must reject instead of hanging forever.
          reject(error);
        });
    });
  }

  /** Detach the abort listener and run the settlement exactly once. */
  private settle(pending: PendingAsk, settle: () => void): void {
    if (!this.pending.has(pending.key)) return;
    this.pending.delete(pending.key);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    pending.onAbort = undefined;
    settle();
  }
}
