/**
 * Headless question backend: the channel side AS the official
 * `UserQuestionProvider` (upgrade plan §5.2 / §21 P0-3).
 *
 * When no ApiProxy gateway is mounted, nothing serves `ctx.userQuestions`,
 * so this backend registers the official provider and the flow becomes:
 *
 * ```text
 * ask_user_question -> ctx.userQuestions.ask -> this provider -> channel
 *   -> Promise resolve -> Agent continues
 * ```
 *
 * `DirectQuestionBackend` IS the channel's UserQuestionProvider: it
 * implements the official `UserQuestionProvider` interface verbatim
 * (`ask(request)` with `questions` / `agent` / `signal`) — no ApiProxy is
 * simulated and no mux frames are minted. Settlement follows the official
 * provider semantics observed in the ApiProxy reference implementation
 * (`dsh-host-apiproxy` 0.1.1-rc.2): an abort or teardown rejects the ask
 * with `UserQuestionError` (`ASK_ABORTED`); a declined presentation rejects
 * immediately instead of leaving the tool call hanging (headless there is
 * no web client to fall back on).
 */
import { randomUUID } from 'node:crypto';
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
  type UserQuestionProvider,
  type UserQuestionService,
} from '@deepseek-ai/dsh-user-questions';
import type { ChannelLogger } from '@wsz987/channel-core';
import type {
  QuestionInteractionBackend,
  QuestionInteractionCancellation,
  QuestionInteractionResolution,
  QuestionInteractionSink,
} from './question-backend.js';

/**
 * Narrow view over the official `ctx.userQuestions` service — only the
 * provider registration the channel side needs.
 */
export type ChannelUserQuestionService = Pick<UserQuestionService, 'registerProvider'>;

interface PendingAsk {
  key: string;
  resolve: (answer: AskUserQuestionAnswer) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface DirectQuestionBackendOptions {
  userQuestions: ChannelUserQuestionService;
  logger: ChannelLogger;
}

/**
 * The channel's official UserQuestionProvider for headless deployments.
 * Registered via `ctx.userQuestions.registerProvider()` in `start()`; a
 * second registration anywhere in the same Context throws
 * `DUPLICATE_PROVIDER` (the service allows exactly one provider), which is
 * exactly why the Web profile must use the ApiProxy backend instead.
 */
export class DirectQuestionBackend implements QuestionInteractionBackend, UserQuestionProvider {
  readonly kind = 'direct' as const;

  private sink?: QuestionInteractionSink;
  private readonly pending = new Map<string, PendingAsk>();
  private disposeProvider?: () => void;

  constructor(private readonly options: DirectQuestionBackendOptions) {}

  start(sink: QuestionInteractionSink): void {
    if (this.disposeProvider) return;
    this.sink = sink;
    // Throws UserQuestionError DUPLICATE_PROVIDER when another provider is
    // already registered in this Context — the loud, fail-safe outcome the
    // one-shot selection in question-backend.ts exists to prevent.
    this.disposeProvider = this.options.userQuestions.registerProvider(this);
  }

  async stop(): Promise<void> {
    this.sink = undefined;
    this.disposeProvider?.();
    this.disposeProvider = undefined;
    for (const pending of [...this.pending.values()]) {
      this.settle(pending, () => {
        pending.reject(
          new UserQuestionError('channel user-questions provider was disposed', 'ASK_ABORTED'),
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

  /** Official `UserQuestionProvider.ask` — one channel presentation per ask. */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    // Official ApiProxy provider posture: an ask without its owning live
    // agent has no session to bind to a channel conversation.
    if (request.agent === undefined) {
      throw new UserQuestionError(
        'channel user interaction requires an agent-owned session',
        'ASK_MISSING_AGENT',
      );
    }
    const sessionId = String(request.agent.id);
    const sink = this.sink;
    if (!sink) {
      throw new UserQuestionError('channel question backend is not started', 'ASK_ABORTED');
    }
    return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      const key = `direct-${randomUUID()}`;
      const pending: PendingAsk = {
        key,
        resolve,
        reject,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      };
      const onAbort = () => {
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
        void sink.questionSettledExternally(key);
      };
      pending.onAbort = onAbort;
      request.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(key, pending);
      void sink
        .questionRequested({ key, sessionId, questions: request.questions })
        .then((accepted) => {
          // The channel declined ownership (no bound conversation, one
          // already pending there, non-interactive adapter): fail the ask
          // now — headless there is no other UI that could answer it.
          if (!accepted && this.pending.has(key)) {
            this.settle(pending, () => {
              reject(
                new UserQuestionError(
                  'no channel conversation is available to answer this question',
                  'ASK_ABORTED',
                ),
              );
            });
          }
        })
        .catch((error: unknown) => {
          if (this.pending.has(key)) {
            this.settle(pending, () => reject(error));
          }
        });
    });
  }
}
