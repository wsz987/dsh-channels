/**
 * Pending-question state machine for channel question interactions.
 *
 * Owns exactly the runtime bookkeeping of an in-flight question batch:
 * the pending registry (by backend correlation key and by channel
 * conversation — one pending question per conversation at a time), the
 * action-button binding table, and the cancel timer. Rendering, channel
 * binding and answer collection live in `question-presenter.ts`; the
 * Harness-side transport lives in the backend modules.
 *
 * Question/answer shapes are the official `dsh-user-questions` types
 * (`AskUserQuestionItem` / `AskUserQuestionAnswerItem`) — every official
 * field (`detail` / `header` / `options` / `multiSelect` / `intent`) is
 * carried verbatim; nothing is stripped or re-encoded here.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions/types';
import type { ChannelTarget } from '@wsz987/channel-core';

/**
 * How a question batch is presented on a channel conversation:
 * - `'actions'` — the adapter supports `interactiveActions`; native buttons.
 * - `'text'`    — text-only fallback; numbered options + free-text answers.
 *
 * Internal to `channel-harness`; NOT part of the public Channel Contract.
 * Decided by capability negotiation (never by channel id).
 */
export type QuestionPresentationMode = 'actions' | 'text';

/**
 * Mint a short correlation token for a text-presented question (e.g.
 * `Q-A13F7C`). It is a route/typing correlate for group/thread replies only,
 * NEVER an auth credential — Authorization stays with the Access Gate +
 * `allowedSenderId`. Kept short (not a UUID) so it is comfortable to type in
 * group chat.
 */
export function newReplyToken(prefix = 'Q-'): string {
  const hex = randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}${hex}`;
}

/** What one bound channel action button does when pressed. */
export interface PendingQuestionAction {
  kind: 'option' | 'custom' | 'done' | 'skip';
  optionIndex?: number;
}

/** A bound action button: opaque channel-facing id -> its pending question. */
export interface PendingQuestionActionRef {
  pending: PendingChannelQuestion;
  action: PendingQuestionAction;
}

/** Explicit lifecycle so removed objects held by an async handler stay terminal. */
export type QuestionLifecycleState =
  | 'pending'
  | 'resolved'
  | 'expired'
  | 'aborted'
  | 'externally-settled';

/**
 * One in-flight question batch as presented on one channel conversation.
 * Transport-neutral: `key` is whatever correlation id the active backend
 * minted (the waterfall ask key today).
 */
export interface PendingChannelQuestion {
  /** Backend correlation key; echoed back on resolve/cancel. */
  key: string;
  sessionId: string;
  /** Official question items, fields carried verbatim (incl. `intent`). */
  questions: AskUserQuestionItem[];
  answers: AskUserQuestionAnswerItem[];
  questionIndex: number;
  selected: Set<string>;
  awaitingCustom: boolean;
  state: QuestionLifecycleState;
  processing: boolean;
  responding: boolean;
  target: ChannelTarget;
  conversationKey: string;
  /**
   * Only the sender whose inbound turn created the active reply context may
   * answer (existing access semantics — authorization already happened at the
   * bridge Access Gate before the question was presented).
   */
  allowedSenderId: string;
  actionIds: Set<string>;
  /** How this batch is presented (capability-negotiated, never channel id). */
  presentationMode: QuestionPresentationMode;
  /**
   * Short correlation token for group/thread text replies when the platform
   * cannot (or does not) map `replyTo` reliably. Regenerated per question via
   * {@link advance}. Not a secret; never a substitute for authorization.
   */
  replyToken?: string;
  /** Message that a free-text response must reply to in a group or forum. */
  promptMessageId?: string;
  messageId?: string;
  renderedText?: string;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Registry + timers for in-flight channel questions. All lookups are
 * synchronous; the class never touches adapters or backends.
 */
export class QuestionStateStore {
  private readonly byKey = new Map<string, PendingChannelQuestion>();
  private readonly byConversation = new Map<string, PendingChannelQuestion>();
  private readonly actions = new Map<string, PendingQuestionActionRef>();

  /**
   * Register a freshly built pending question. Returns false (and registers
   * nothing) when either its key was already presented (mux replay of a
   * still-pending question — rpcId is reused verbatim on stream reopen) or
   * its conversation already has a pending question.
   */
  register(pending: PendingChannelQuestion): boolean {
    if (this.byKey.has(pending.key)) return false;
    if (this.byConversation.has(pending.conversationKey)) return false;
    this.byKey.set(pending.key, pending);
    this.byConversation.set(pending.conversationKey, pending);
    return true;
  }

  getByKey(key: string): PendingChannelQuestion | undefined {
    return this.byKey.get(key);
  }

  getByConversation(conversationKey: string): PendingChannelQuestion | undefined {
    return this.byConversation.get(conversationKey);
  }

  /** Snapshot of every in-flight question (stop()/cancel-all iteration). */
  all(): PendingChannelQuestion[] {
    return [...this.byKey.values()];
  }

  /**
   * Mint a bounded, opaque channel-facing action id and bind it. Ids stay
   * within platform callback-payload budgets (e.g. Telegram callback_data).
   */
  bindAction(pending: PendingChannelQuestion, action: PendingQuestionAction): string {
    const id = `uq_${randomUUID().replaceAll('-', '')}`;
    pending.actionIds.add(id);
    this.actions.set(id, { pending, action });
    return id;
  }

  findAction(actionId: string): PendingQuestionActionRef | undefined {
    return this.actions.get(actionId);
  }

  /** Drop every bound action of a pending question (re-render / settle). */
  clearActions(pending: PendingChannelQuestion): void {
    for (const id of pending.actionIds) this.actions.delete(id);
    pending.actionIds.clear();
  }

  /** Arm the one-shot cancel timer for a pending question. */
  armTimeout(
    pending: PendingChannelQuestion,
    timeoutMs: number,
    onTimeout: (pending: PendingChannelQuestion) => void,
  ): void {
    this.clearTimer(pending);
    pending.timer = setTimeout(() => onTimeout(pending), timeoutMs);
  }

  clearTimer(pending: PendingChannelQuestion): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = undefined;
  }

  /** Fully unregister a settled question (timer + both indexes). */
  remove(pending: PendingChannelQuestion): void {
    this.clearTimer(pending);
    this.byKey.delete(pending.key);
    if (this.byConversation.get(pending.conversationKey) === pending) {
      this.byConversation.delete(pending.conversationKey);
    }
  }
}
