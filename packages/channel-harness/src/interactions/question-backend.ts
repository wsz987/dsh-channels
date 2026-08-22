/**
 * Question interaction backend contract + one-shot capability selection
 * (upgrade plan §5 / §18 / §21 P0-3).
 *
 * Two official transports exist for the Harness question domain
 * (`ask_user_question` -> `ctx.userQuestions`):
 *
 * - **Web profile**: the ApiProxy gateway is itself the registered
 *   `UserQuestionProvider` and forwards questions as `question/requested`
 *   mux frames. One Context allows exactly ONE provider
 *   (`registerProvider` throws `DUPLICATE_PROVIDER`), so the channel side
 *   must consume the mux stream here and NEVER register a provider of its
 *   own in this mode.
 * - **Headless / no ApiProxy**: nothing serves `ctx.userQuestions`, so the
 *   channel side registers its own official `UserQuestionProvider` and the
 *   tool call flows `ask_user_question` -> UserQuestionService -> provider ->
 *   channel -> resolve -> Agent continues. No ApiProxy is simulated.
 *
 * The mode is decided by ONE capability probe at startup, in this file
 * (plan §18 red line: no `if (version >= …)` scattering). A failed probe
 * fails safe: an explicit error is logged and channel question presentation
 * is disabled — never a silent double registration.
 *
 * Naming leaves room for the upcoming approval interaction (plan §19 /
 * P1-3): everything here is `QuestionInteraction*` under `interactions/`,
 * and the official mux already carries `approval/requested` /
 * `approval/resolved` frames a future `ApprovalInteraction` can reuse.
 */
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions/types';
import type { ChannelAdapter, ChannelLogger } from '@wsz987/channel-core';
import type { AgentManager } from '../agent-manager.js';
import type { ReplyContextStore } from '../reply-context-store.js';
import { ApiProxyQuestionBackend, type ChannelQuestionApiProxy } from './question-apiproxy-backend.js';
import { DirectQuestionBackend, type ChannelUserQuestionService } from './question-direct-backend.js';
import { ChannelQuestionPresenter } from './question-presenter.js';

/** One question batch arriving from the Harness question domain. */
export interface QuestionInteractionRequest {
  /** Correlation key the backend minted (ApiProxy rpcId / direct ask key). */
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
   * conversation, non-interactive adapter, or a question already pending
   * there) and the backend must settle the ask some other way.
   */
  questionRequested(request: QuestionInteractionRequest): Promise<boolean>;
  /**
   * The question settled WITHOUT the channel — another client answered, or
   * the owning tool call aborted. Removes stale channel controls.
   */
  questionSettledExternally(key: string): Promise<void>;
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
export type QuestionBackendKind = 'apiproxy' | 'direct';

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

/** Live service probes (startup snapshot; call sites stay dumb). */
export interface QuestionBackendProbe {
  /** The public ApiProxy gateway, when this deployment runs the Web profile. */
  getApiProxy(): ChannelQuestionApiProxy | undefined;
  /** The official `ctx.userQuestions` service, when the host spine provides it. */
  getUserQuestions(): ChannelUserQuestionService | undefined;
}

/** Channel presentation dependencies shared by every backend mode. */
export interface QuestionInteractionDeps {
  agentManager: AgentManager;
  replyContexts: ReplyContextStore;
  getAdapter(channelId: string): ChannelAdapter | undefined;
  logger: ChannelLogger;
  timeoutMs: number;
}

export interface QuestionInteractionOptions extends QuestionInteractionDeps, QuestionBackendProbe {}

/**
 * One-shot backend selection (plan §5). ApiProxy wins whenever present —
 * in the Web profile ApiProxy is already the registered UserQuestion
 * provider, so the channel side consumes its mux stream instead of ever
 * registering a second provider. Only without ApiProxy does the channel
 * register the official provider headless. A probe that finds neither
 * transport fails safe: explicit error, no backend (never both).
 *
 * ORDERING CONTRACT: this probe is only race-free when the api-gateway fiber
 * has already applied (both sides claim the single provider slot; the second
 * registration throws DUPLICATE_PROVIDER and kills the boot). The stock
 * bundle guarantees that with `inject: [apiProxy]` on the channels-harness
 * patch row; custom hosts mounting the gateway must order the same way.
 */
export function selectQuestionBackend(
  probe: QuestionBackendProbe,
  deps: Pick<QuestionInteractionDeps, 'logger'>,
): QuestionInteractionBackend | undefined {
  const apiProxy = probe.getApiProxy();
  if (apiProxy) {
    return new ApiProxyQuestionBackend({ apiProxy, logger: deps.logger });
  }
  const userQuestions = probe.getUserQuestions();
  if (userQuestions) {
    return new DirectQuestionBackend({ userQuestions, logger: deps.logger });
  }
  deps.logger.error(
    '[channel-harness] user question backend unavailable: neither the public apiProxy gateway nor the userQuestions service is mounted; channel question presentation is disabled',
  );
  return undefined;
}

/**
 * Assemble the whole question interaction stack: probe the transport once,
 * build the matching backend, and wire the channel presenter on top.
 * Returns undefined (after an explicit error log) when no transport exists.
 */
export function createQuestionInteraction(
  options: QuestionInteractionOptions,
): ChannelQuestionPresenter | undefined {
  const backend = selectQuestionBackend(options, options);
  if (!backend) return undefined;
  return new ChannelQuestionPresenter({
    backend,
    agentManager: options.agentManager,
    replyContexts: options.replyContexts,
    getAdapter: options.getAdapter,
    logger: options.logger,
    timeoutMs: options.timeoutMs,
  });
}
