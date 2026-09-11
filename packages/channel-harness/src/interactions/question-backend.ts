/**
 * Question interaction backend contract + answerer assembly.
 *
 * The official question domain (`ask_user_question` -> `ctx.userQuestions`)
 * dispatches the `user-questions/request` Cordis waterfall (dsh 0.1.2);
 * answerers claim a request by returning an answer or delegate with
 * `next()`. The channel composes ONE waterfall answerer that serves every
 * profile:
 *
 * - **Headless**: the channel is typically the only answerer, so a declined
 *   presentation fails the ask (`NO_PROVIDER` from the official service).
 * - **Web profile**: the official Remote/Web answerer is composed on the same
 *   waterfall and claims first unless the channel answerer is PREPENDED (see
 *   `question-waterfall-backend.ts`); a channel decline still delegates to it.
 *   (Before 0.1.2 this required the ApiProxy question mux, which broadcast to
 *   every consumer; ApiProxy was removed in 0.1.2 and the first-claim
 *   waterfall replaced it, so the old DUPLICATE_PROVIDER ordering contract is
 *   gone — but a NEW ordering contract took its place.)
 *
 * There is no version branching here: the waterfall is the only transport,
 * and the `userQuestions` probe is diagnostic (never an admission gate).
 *
 * Naming leaves room for the upcoming approval interaction:
 * everything here is `QuestionInteraction*` under `interactions/`,
 * and the official domain already carries approval requests a future
 * `ApprovalInteraction` can compose the same way.
 */
import type { Context } from '@deepseek-ai/cordis';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions/types';
import type { ChannelAdapter, ChannelLogger } from '@wsz987/channel-core';
import type { AgentManager } from '../agent-manager.js';
import type { ReplyContextStore } from '../reply-context-store.js';
import { WaterfallQuestionBackend, type ChannelUserQuestionService } from './question-waterfall-backend.js';
import { ChannelQuestionPresenter } from './question-presenter.js';

/** One question batch arriving from the Harness question domain. */
export interface QuestionInteractionRequest {
  /** Correlation key the backend minted (the waterfall ask key). */
  key: string;
  sessionId: string;
  /** Official question items; every field (incl. `intent`) is carried verbatim. */
  questions: AskUserQuestionItem[];
}

/**
 * The channel presentation side, as seen by a backend. Backends push
 * harness-origin question traffic through this sink; the presenter resolves
 * answers back through {@link QuestionInteractionBackend}.
 */
export interface QuestionInteractionSink {
  /**
   * Present a question batch on its bound channel conversation.
   *
   * @returns true when the channel took ownership (it will later resolve or
   * cancel through the backend); false when the channel declined (no bound
   * conversation, adapter absent / text unsupported, or a question already
   * pending there) and the backend must delegate the ask to the next
   * answerer.
   */
  questionRequested(request: QuestionInteractionRequest): Promise<boolean>;
  /**
   * The question settled WITHOUT the channel — the owning tool call aborted.
   * Removes stale channel controls.
   */
  questionSettledExternally(
    key: string,
    state?: 'aborted' | 'externally-settled',
  ): Promise<void>;
}

/** A channel-collected answer batch submitted to the Harness question domain. */
export interface QuestionInteractionResolution {
  key: string;
  sessionId: string;
  answer: AskUserQuestionAnswer;
}

/** The channel could not / will not answer a question it had taken. */
export interface QuestionInteractionCancellation {
  key: string;
  /** Human-readable reason; also the code-carrying message headless. */
  reason: string;
}

/** Which official transport a backend speaks. */
export type QuestionBackendKind = 'waterfall';

/**
 * Transport-neutral question domain port consumed by the presenter.
 * `QuestionInteraction*` naming keeps room for a future approval sibling
 * without sharing this interface prematurely.
 */
export interface QuestionInteractionBackend {
  readonly kind: QuestionBackendKind;
  /** Connect the presenter sink and begin consuming the question domain. */
  start(sink: QuestionInteractionSink): void;
  /** Tear the transport down and settle every still-open question. */
  stop(): Promise<void>;
  /** Submit a complete answer batch (one entry per question, in order). */
  resolve(submission: QuestionInteractionResolution): Promise<void>;
  /** Cancel an open question with a human-readable reason. */
  cancel(cancellation: QuestionInteractionCancellation): Promise<void>;
}

/**
 * Live service probes. The waterfall answerer registers on `ctx` and never
 * calls the service, so `getUserQuestions()` is a DIAGNOSTIC probe: it only
 * decides whether the startup miss is logged.
 */
export interface QuestionBackendProbe {
  /** The official `ctx.userQuestions` service, when the host spine provides it. */
  getUserQuestions(): ChannelUserQuestionService | undefined;
  /** Root Cordis context the waterfall listener registers on. */
  ctx: Context;
}

/** Channel presentation dependencies shared by every backend mode. */
export interface QuestionInteractionDeps {
  agentManager: AgentManager;
  replyContexts: ReplyContextStore;
  getAdapter(channelId: string): ChannelAdapter | undefined;
  logger: ChannelLogger;
  timeoutMs: number;
}

export interface QuestionInteractionOptions extends QuestionInteractionDeps, Omit<QuestionBackendProbe, 'ctx'> {
  ctx: Context;
}

/**
 * Backend selection: the waterfall answerer always exists, because it needs
 * only the ROOT context — `ctx.userQuestions` dispatches the event, and this
 * backend never calls the service. The probe is therefore DIAGNOSTIC ONLY.
 *
 * Treating a missing service as fatal (the pre-waterfall behavior) made a
 * transient startup state permanent: profile rows are composed concurrently
 * and `cordis.patch.yml` layers hot-reload, so a `userQuestions` service that
 * mounts after the bridge used to leave channel question presentation
 * disabled for the whole process — every channel-bound ask silently answered
 * by the Web UI instead. A registered listener with no service is inert, so
 * the answerer is composed unconditionally and the miss is only logged.
 */
export function selectQuestionBackend(
  probe: Omit<QuestionBackendProbe, 'ctx'> & { ctx: Context },
  deps: Pick<QuestionInteractionDeps, 'logger'>,
): QuestionInteractionBackend {
  if (!probe.getUserQuestions()) {
    deps.logger.warn(
      '[channel-harness] the userQuestions service is not mounted yet; the channel question answerer is registered anyway and claims asks as soon as the service appears',
    );
  }
  return new WaterfallQuestionBackend({ ctx: probe.ctx, logger: deps.logger });
}

/**
 * Assemble the whole question interaction stack: probe the service (diagnostic
 * only), build the waterfall backend, and wire the channel presenter on top.
 */
export function createQuestionInteraction(
  options: QuestionInteractionOptions,
): ChannelQuestionPresenter {
  const backend = selectQuestionBackend(options, options);
  return new ChannelQuestionPresenter({
    backend,
    agentManager: options.agentManager,
    replyContexts: options.replyContexts,
    getAdapter: options.getAdapter,
    logger: options.logger,
    timeoutMs: options.timeoutMs,
  });
}
