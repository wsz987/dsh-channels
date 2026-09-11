/**
 * Channel question presentation — the half the channel layer truly owns.
 *
 * Responsibilities kept here (and ONLY here):
 *
 * ```text
 * session -> channel binding        who may answer (the turn's sender)
 * rendering questions as actions    option / multi-select / custom / skip
 * capability-driven presentation    interactiveActions -> native buttons,
 *                                   otherwise text -> numbered fallback
 * action-failure degradation        a declared native-actions capability that
 *                                   FAILS to send degrades that batch to the
 *                                   numbered text form instead of cancelling
 * callback + text answer collection per-conversation + per-ask dedup
 * timeout                           channel message updates (edit / clear)
 * ```
 *
 * Everything Harness-shaped (question domain model, wire frames, provider
 * registration) lives behind {@link QuestionInteractionBackend}; this class
 * never inspects platform payloads and never branches on a channel id —
 * presentation differences go through adapter capabilities, exactly like the
 * rest of the bridge.
 *
 * Inbound access semantics (unchanged from the pre-refactor bridge): the
 * bridge's fail-closed Access Gate has already authorized the sender before
 * the turn that created the reply context; a pending question may then be
 * answered ONLY by that same sender (`allowedSenderId`) and only in the bound
 * conversation. Answers from anyone else are consumed without effect
 * (interactions) or left for ordinary routing (messages).
 *
 * Group/thread text correlation: an answer must match the pending question —
 * either the platform maps `replyTo` back to the presented prompt message, or
 * the reply carries the short per-question `replyToken` (e.g. `Q-A13F7C 2`).
 * DMs parse directly without correlation. The token is a routing hint only —
 * never an authorization credential.
 */
import type {
  AskUserQuestionAnswerItem,
} from '@deepseek-ai/dsh-user-questions/types';
import type {
  ChannelAdapter,
  ChannelEvent,
  ChannelLogger,
  ChannelTarget,
  InteractionReceived,
  MessageReceived,
  OutboundMessage,
} from '@wsz987/channel-core';
import type { AgentManager } from '../agent-manager.js';
import type { ReplyContextStore } from '../reply-context-store.js';
import type {
  QuestionInteractionBackend,
  QuestionInteractionRequest,
  QuestionInteractionSink,
} from './question-backend.js';
import { renderQuestionMessage } from './question-renderer.js';
import { parseQuestionTextAnswer } from './question-text-answer.js';
import {
  newReplyToken,
  QuestionStateStore,
  type PendingChannelQuestion,
  type QuestionPresentationMode,
} from './question-state.js';

export interface ChannelQuestionPresenterOptions {
  backend: QuestionInteractionBackend;
  agentManager: AgentManager;
  replyContexts: ReplyContextStore;
  getAdapter(channelId: string): ChannelAdapter | undefined;
  logger: ChannelLogger;
  timeoutMs: number;
}

function targetKey(target: ChannelTarget): string {
  return `${target.channelId}:${target.accountId}:${target.conversationId}:${target.threadId ?? ''}`;
}

function eventKey(event: MessageReceived | InteractionReceived): string {
  return `${event.channel}:${event.accountId}:${event.conversation.id}:${event.conversation.threadId ?? ''}`;
}

function textOf(event: MessageReceived): string {
  return event.message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}

/**
 * Presents Harness-origin questions (the official `user-questions/request`
 * waterfall) through generic channel actions.
 */
export class ChannelQuestionPresenter implements QuestionInteractionSink {
  private readonly state = new QuestionStateStore();

  constructor(private readonly options: ChannelQuestionPresenterOptions) {}

  /** Connect the sink and open the backend transport. */
  start(): void {
    this.options.backend.start(this);
  }

  /** Cancel every open question, then tear the backend transport down. */
  async stop(): Promise<void> {
    for (const pending of this.state.all()) {
      await this.cancel(pending, 'channel question bridge stopped');
    }
    await this.options.backend.stop();
  }

  // ---------------------------------------------------------------------------
  // QuestionInteractionSink — harness -> channel
  // ---------------------------------------------------------------------------

  /**
   * Present one question batch on the channel conversation bound to the
   * asking session. Returns false when the channel cannot take ownership
   * (no active reply context, no binding, adapter absent / text unsupported,
   * or another question already pending on that conversation) — the backend
   * decides what a decline means per transport.
   *
   * `interactiveActions` decides only presentation quality, never admission:
   * any `text: true` adapter can answer via numbered plain text; a
   * `interactiveActions: true` adapter upgrades to native buttons.
   */
  async questionRequested(request: QuestionInteractionRequest): Promise<boolean> {
    // Mux replay of a still-pending question (the official stream reuses the
    // rpcId verbatim on reopen): already owned, keep presenting it.
    if (this.state.getByKey(request.key)) return true;

    const sessionId = request.sessionId;
    const active = this.options.replyContexts.getActiveForSession(sessionId);
    const binding = this.options.agentManager.bindingFor(sessionId);
    if (!active || !binding || !active.context.senderId) return false;
    const adapter = this.options.getAdapter(binding.channelId);
    if (!adapter || !adapter.capabilities.text) return false;
    const presentationMode: QuestionPresentationMode =
      adapter.capabilities.interactiveActions === true ? 'actions' : 'text';

    const target: ChannelTarget = {
      channelId: binding.channelId as ChannelTarget['channelId'],
      accountId: binding.accountId as ChannelTarget['accountId'],
      conversationId: binding.conversationId as ChannelTarget['conversationId'],
      conversationType: active.context.conversationType,
      ...(binding.threadId ? { threadId: binding.threadId as ChannelTarget['threadId'] } : {}),
      ...(active.context.replyToMessageId
        ? { replyToMessageId: active.context.replyToMessageId as ChannelTarget['replyToMessageId'] }
        : {}),
      ...(active.context.raw === undefined ? {} : { raw: active.context.raw }),
      ...(active.context.runId ? { runId: active.context.runId } : {}),
    };
    const pending: PendingChannelQuestion = {
      key: request.key,
      sessionId,
      questions: request.questions,
      answers: [],
      questionIndex: 0,
      selected: new Set(),
      awaitingCustom: false,
      state: 'pending',
      processing: false,
      responding: false,
      target,
      conversationKey: targetKey(target),
      allowedSenderId: active.context.senderId,
      actionIds: new Set(),
      presentationMode,
      replyToken: newReplyToken(),
    };
    if (!this.state.register(pending)) {
      // One pending question per conversation at a time.
      this.options.logger.warn('[channel-harness] channel question already pending', {
        channel: binding.channelId,
        account: binding.accountId,
        conversation: binding.conversationId,
      });
      return false;
    }
    this.state.armTimeout(pending, this.options.timeoutMs, (expired) => {
      void this.cancel(expired, '问题已超时，请重新发起。', 'expired');
    });
    this.options.logger.info('[channel-harness] presenting user question on channel', {
      sessionId,
      channel: binding.channelId,
      questionCount: request.questions.length,
      presentationMode,
    });
    try {
      await this.present(pending, adapter, false);
    } catch (error) {
      this.options.logger.error('[channel-harness] failed to present user question', error);
      await this.cancel(pending, '无法在当前渠道展示问题，已取消。');
    }
    return true;
  }

  /** Another client answered, or the owning tool call aborted: drop controls. */
  async questionSettledExternally(
    key: string,
    state: 'aborted' | 'externally-settled' = 'externally-settled',
  ): Promise<void> {
    const pending = this.state.getByKey(key);
    if (!pending) return;
    // Mark terminal before the first await. A channel handler may still hold
    // this object after the store indexes are removed.
    if (pending.state === 'pending') pending.state = state;
    await this.cleanup(pending);
  }

  // ---------------------------------------------------------------------------
  // Channel -> answer collection
  // ---------------------------------------------------------------------------

  /** Consume an already-authorized channel answer before it reaches the Agent inbox. */
  async handleChannelEvent(event: ChannelEvent): Promise<boolean> {
    if (event.type === 'interaction.received') return this.handleInteraction(event);
    if (event.type === 'message.received') return this.handleMessage(event);
    return false;
  }

  private async present(
    pending: PendingChannelQuestion,
    adapter: ChannelAdapter,
    edit: boolean,
  ): Promise<void> {
    if (pending.state !== 'pending') return;
    const question = pending.questions[pending.questionIndex];
    if (!question) return this.submit(pending);
    this.state.clearActions(pending);
    const message = renderQuestionMessage(pending, question, (action) =>
      this.state.bindAction(pending, action),
    );
    pending.renderedText = message.text;
    if (edit && pending.messageId && adapter.edit) {
      await adapter.edit(pending.target, pending.messageId, message);
      return;
    }
    let result;
    try {
      result = await adapter.send(pending.target, message);
    } catch (error) {
      // A DECLARED native-actions capability can still be unusable in a live
      // deployment: a DingTalk interactive-card template that is not published
      // in THIS org, a missing card/markdown-keyboard permission, … The
      // capability flag is a declaration, never a probe, so a failed
      // interactive presentation must NOT kill the question — every
      // `text: true` adapter can answer the numbered-text form. Degrade this
      // batch to text and re-render (that rendering adds the reply
      // instructions and, in a group, the correlation token).
      if (pending.presentationMode !== 'actions') throw error;
      this.options.logger.warn(
        '[channel-harness] interactive actions failed to present; falling back to numbered text',
        {
          channel: pending.target.channelId,
          conversationType: pending.target.conversationType,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      pending.presentationMode = 'text';
      return this.present(pending, adapter, false);
    }
    if (pending.state !== 'pending') {
      if (message.actions?.length && result.messageId && adapter.edit) {
        await adapter.edit(pending.target, result.messageId, { actions: [] }).catch(() => {});
      }
      return;
    }
    if (message.replyPrompt) pending.promptMessageId = result.messageId;
    else pending.messageId = result.messageId;
  }

  private async handleInteraction(event: InteractionReceived): Promise<boolean> {
    const ref = this.state.findAction(event.action);
    if (!ref || ref.pending.conversationKey !== eventKey(event)) return false;
    const pending = ref.pending;
    if (String(event.sender.id) !== pending.allowedSenderId) return true;
    if (pending.state !== 'pending' || pending.processing || pending.responding) return true;
    const question = pending.questions[pending.questionIndex];
    if (!question) return true;
    const action = ref.action;

    pending.processing = true;
    try {
      if (action.kind === 'skip') {
        await this.advance(pending, { id: question.id, selected: [] });
      } else if (action.kind === 'custom') {
        pending.awaitingCustom = true;
        const adapter = this.options.getAdapter(pending.target.channelId);
        if (adapter) {
          await this.removeButtons(pending);
          if (pending.state !== 'pending') return true;
          await this.present(pending, adapter, false);
        }
      } else if (action.kind === 'done') {
        if (pending.selected.size > 0) {
          await this.advance(pending, { id: question.id, selected: [...pending.selected] });
        }
      } else if (action.optionIndex !== undefined) {
        const option = question.options?.[action.optionIndex];
        if (!option) return true;
        if (!question.multiSelect) {
          await this.advance(pending, { id: question.id, selected: [option.label] });
        } else {
          if (pending.selected.has(option.label)) pending.selected.delete(option.label);
          else pending.selected.add(option.label);
          const adapter = this.options.getAdapter(pending.target.channelId);
          if (adapter) await this.present(pending, adapter, true);
        }
      }
    } catch (error) {
      this.options.logger.error('[channel-harness] failed to process question interaction', error);
      await this.cancel(pending, '提交答案失败，问题已取消。');
    } finally {
      pending.processing = false;
    }
    return true;
  }

  /**
   * Route one authorized text message into the question flow. DM answers parse
   * directly; group/thread answers must correlate via the platform `replyTo`
   * mapping or the per-question `replyToken` (stripped before parsing).
   * Returns true when the message was consumed by a pending question (never
   * falls through to Agent routing); false otherwise.
   */
  private async handleMessage(event: MessageReceived): Promise<boolean> {
    const pending = this.state.getByConversation(eventKey(event));
    if (!pending) return false;
    if (String(event.sender.id) !== pending.allowedSenderId) return false;
    const text = textOf(event);
    if (!text || text.startsWith('/')) return false;
    if (pending.state !== 'pending' || pending.processing || pending.responding) return true;
    const question = pending.questions[pending.questionIndex];
    if (!question) return false;
    const body = this.correlateMessageBody(pending, event, text);
    if (body === undefined) return false;

    pending.processing = true;
    try {
      const parsed = parseQuestionTextAnswer(question, body);
      if (parsed.kind === 'invalid') {
        if (parsed.reason === 'option-out-of-range') {
          this.options.logger.debug('[channel-harness] invalid text answer for pending question', {
            channel: pending.target.channelId,
            conversationType: pending.target.conversationType,
            reason: parsed.reason,
          });
          const adapter = this.options.getAdapter(pending.target.channelId);
          const n = question.options?.length ?? 0;
          // Keep pending — do NOT cancel, do NOT re-arm the timeout. Only a
          // genuine send/backend failure, timeout or external settlement ends.
          if (adapter) {
            await adapter
              .send(pending.target, { text: `选项无效，请回复 1-${n}；多选可回复 1,3。` })
              .catch(() => {});
          }
        }
        return true;
      }
      if (parsed.kind === 'skip') {
        await this.advance(pending, { id: question.id, selected: [] });
        return true;
      }
      if (parsed.kind === 'selected') {
        await this.advance(pending, { id: question.id, selected: parsed.labels });
        return true;
      }
      await this.advance(pending, {
        id: question.id,
        selected: question.multiSelect ? [...pending.selected] : [],
        custom: parsed.text,
      });
    } catch (error) {
      this.options.logger.error('[channel-harness] failed to process question reply', error);
      await this.cancel(pending, '提交答案失败，问题已取消。');
    } finally {
      pending.processing = false;
    }
    return true;
  }

  /**
   * Resolve the answerable text of an inbound message against a pending
   * question. Returns:
   * - the message body for DMs (parse directly), or
   * - the token-stripped body when the platform `replyTo` maps to the prompt,
   *   or
   * - the token-stripped body when the reply carries `pending.replyToken`
   *   anywhere (`Q-XXXX 2`, `Q-XXXX: 2`, `@bot Q-XXXX 2`), or
   * - `undefined` when nothing correlates (leave for ordinary routing).
   */
  private correlateMessageBody(
    pending: PendingChannelQuestion,
    event: MessageReceived,
    text: string,
  ): string | undefined {
    if (pending.target.conversationType !== 'group') return text;
    if (pending.promptMessageId && event.message.replyTo === pending.promptMessageId) {
      return text;
    }
    // A reliable adapter-supplied mention is an explicit correlation signal:
    // after the Access Gate has authorized + activated it, `@bot 2` from the
    // pending question's allowed sender is an answer, not a new queued turn.
    if (event.message.activation?.mentionedBot === true) return text;
    const token = pending.replyToken;
    if (!token) return undefined;
    const index = text.indexOf(token);
    if (index === -1) return undefined;
    const before = text
      .slice(0, index)
      .replace(/@\S+\s*$/u, '')
      .replace(/[\s:：,，]+$/u, '');
    const after = text.slice(index + token.length).replace(/^[\s:：,，]+/u, '');
    const body = `${before} ${after}`.trim();
    return body.length > 0 ? body : undefined;
  }

  private async advance(pending: PendingChannelQuestion, answer: AskUserQuestionAnswerItem): Promise<void> {
    if (pending.state !== 'pending') return;
    await this.removeButtons(pending);
    if (pending.state !== 'pending') return;
    pending.answers.push(answer);
    pending.questionIndex += 1;
    // Reset per-question transient state so a delayed answer to a previous
    // question does not leak into the next one.
    pending.selected.clear();
    pending.awaitingCustom = false;
    pending.promptMessageId = undefined;
    pending.replyToken = newReplyToken();
    const adapter = this.options.getAdapter(pending.target.channelId);
    if (!adapter) return this.cancel(pending, '渠道已断开，问题已取消。');
    await this.present(pending, adapter, false);
  }

  private async submit(pending: PendingChannelQuestion): Promise<void> {
    if (pending.state !== 'pending' || pending.responding) return;
    pending.responding = true;
    try {
      await this.options.backend.resolve({
        key: pending.key,
        sessionId: pending.sessionId,
        answer: { answers: pending.answers },
      });
      if (pending.state === 'pending') pending.state = 'resolved';
      await this.cleanup(pending);
    } catch (error) {
      if (pending.state !== 'pending') {
        await this.cleanup(pending);
        return;
      }
      pending.responding = false;
      throw error;
    }
  }

  private async cancel(
    pending: PendingChannelQuestion,
    notice: string,
    state: 'expired' | 'aborted' = 'aborted',
  ): Promise<void> {
    if (pending.state !== 'pending' || pending.responding) return;
    pending.state = state;
    pending.responding = true;
    await this.removeButtons(pending);
    const adapter = this.options.getAdapter(pending.target.channelId);
    if (adapter) await adapter.send(pending.target, { text: notice }).catch(() => {});
    await this.options.backend.cancel({ key: pending.key, reason: notice }).catch(() => undefined);
    await this.cleanup(pending);
  }

  private async removeButtons(pending: PendingChannelQuestion): Promise<void> {
    this.state.clearActions(pending);
    if (!pending.messageId) return;
    const adapter = this.options.getAdapter(pending.target.channelId);
    if (adapter?.edit) {
      await adapter.edit(pending.target, pending.messageId, { actions: [] }).catch(() => {});
    }
    pending.messageId = undefined;
  }

  private async cleanup(pending: PendingChannelQuestion): Promise<void> {
    await this.removeButtons(pending);
    this.state.remove(pending);
  }
}
