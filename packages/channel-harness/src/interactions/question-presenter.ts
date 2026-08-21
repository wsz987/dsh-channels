/**
 * Channel question presentation — the half the channel layer truly owns
 * (upgrade plan §5.1 / §21 P0-3).
 *
 * Responsibilities kept here (and ONLY here):
 *
 * ```text
 * session -> channel binding        who may answer (the turn's sender)
 * rendering questions as actions    option / multi-select / custom / skip
 * callback + text answer collection per-conversation + per-rpc dedup
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
 */
import type {
  AskUserQuestionItem,
  AskUserQuestionAnswerItem,
} from '@deepseek-ai/dsh-user-questions/types';
import type {
  ChannelAdapter,
  ChannelEvent,
  ChannelLogger,
  ChannelTarget,
  InteractionReceived,
  MessageReceived,
  OutboundActionRow,
  OutboundMessage,
} from '@wsz987/channel-core';
import type { AgentManager } from '../agent-manager.js';
import type { ReplyContextStore } from '../reply-context-store.js';
import type {
  QuestionInteractionBackend,
  QuestionInteractionRequest,
  QuestionInteractionSink,
} from './question-backend.js';
import {
  QuestionStateStore,
  type PendingChannelQuestion,
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
 * Presents Harness-origin questions (Web profile: ApiProxy mux; headless:
 * the official UserQuestionProvider) through generic channel actions.
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
   * (no active reply context, no binding, non-interactive adapter, or
   * another question already pending on that conversation) — the backend
   * decides what a decline means per transport.
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
    if (!adapter?.capabilities.interactiveActions) return false;

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
      processing: false,
      responding: false,
      target,
      conversationKey: targetKey(target),
      allowedSenderId: active.context.senderId,
      actionIds: new Set(),
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
      void this.cancel(expired, '问题已超时，请重新发起。');
    });
    this.options.logger.info('[channel-harness] presenting user question on channel', {
      sessionId,
      channel: binding.channelId,
      questionCount: request.questions.length,
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
  async questionSettledExternally(key: string): Promise<void> {
    const pending = this.state.getByKey(key);
    if (pending) await this.cleanup(pending);
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
    const question = pending.questions[pending.questionIndex];
    if (!question) return this.submit(pending);
    this.state.clearActions(pending);
    const message = this.renderQuestion(pending, question);
    pending.renderedText = message.text;
    if (edit && pending.messageId && adapter.edit) {
      await adapter.edit(pending.target, pending.messageId, message);
      return;
    }
    const result = await adapter.send(pending.target, message);
    pending.messageId = result.messageId;
  }

  /**
   * Render the CURRENT question of a pending batch. Every official field is
   * honoured: `header` / `question` / `detail` as text, `options` /
   * `multiSelect` as action buttons, and `intent` as a minimal presentation
   * cue (a plan-review heading tag plus a primary-styled approve button —
   * the answer encoding is identical either way, so nothing is lost when a
   * UI ignores the tag).
   */
  private renderQuestion(
    pending: PendingChannelQuestion,
    question: AskUserQuestionItem,
  ): OutboundMessage {
    const intent = question.intent;
    const planReview = intent?.kind === 'plan-review';
    const heading = question.header ? `**${question.header}**` : '';
    const lines = [
      planReview ? (heading ? `${heading}（计划评审）` : '**计划评审**') : heading,
      question.question,
      question.detail ?? '',
    ];
    if (question.options?.some((option) => option.description)) {
      lines.push(...question.options.map((option, index) =>
        `${index + 1}. ${option.label}${option.description ? `\n   ${option.description}` : ''}`,
      ));
    }
    if (pending.awaitingCustom) lines.push('请直接回复你的自定义答案。');
    else if (!question.options?.length) lines.push('请直接回复文字，或选择“跳过本题”。');

    const approveLabel = planReview ? intent.approve : undefined;
    const actions: OutboundActionRow[] = [];
    if (!pending.awaitingCustom) {
      for (const [index, option] of (question.options ?? []).entries()) {
        const selected = pending.selected.has(option.label);
        actions.push({
          actions: [{
            id: this.state.bindAction(pending, { kind: 'option', optionIndex: index }),
            label: `${selected ? '✓ ' : ''}${option.label}`,
            ...(option.label === approveLabel ? { style: 'primary' as const } : {}),
          }],
        });
      }
      if (question.options?.length) {
        actions.push({ actions: [{ id: this.state.bindAction(pending, { kind: 'custom' }), label: '其他' }] });
        if (question.multiSelect) {
          actions.push({ actions: [{ id: this.state.bindAction(pending, { kind: 'done' }), label: '完成', style: 'primary' }] });
        }
      }
    }
    actions.push({ actions: [{ id: this.state.bindAction(pending, { kind: 'skip' }), label: '跳过本题' }] });
    return { text: lines.filter(Boolean).join('\n\n'), actions };
  }

  private async handleInteraction(event: InteractionReceived): Promise<boolean> {
    const ref = this.state.findAction(event.action);
    if (!ref || ref.pending.conversationKey !== eventKey(event)) return false;
    const pending = ref.pending;
    if (String(event.sender.id) !== pending.allowedSenderId) return true;
    if (pending.processing || pending.responding) return true;
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
        if (adapter) await this.present(pending, adapter, true);
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

  private async handleMessage(event: MessageReceived): Promise<boolean> {
    const pending = this.state.getByConversation(eventKey(event));
    if (!pending) return false;
    if (String(event.sender.id) !== pending.allowedSenderId) return false;
    const text = textOf(event);
    if (!text || text.startsWith('/')) return false;
    if (pending.processing || pending.responding) return true;
    const question = pending.questions[pending.questionIndex];
    if (!question) return false;
    pending.processing = true;
    try {
      if (text === '跳过' || text === '跳过本题') {
        await this.advance(pending, { id: question.id, selected: [] });
        return true;
      }
      const option = this.optionFromText(question, text);
      if (option && !question.multiSelect) {
        await this.advance(pending, { id: question.id, selected: [option.label] });
        return true;
      }
      await this.advance(pending, {
        id: question.id,
        selected: question.multiSelect ? [...pending.selected] : [],
        custom: text,
      });
    } catch (error) {
      this.options.logger.error('[channel-harness] failed to process question reply', error);
      await this.cancel(pending, '提交答案失败，问题已取消。');
    } finally {
      pending.processing = false;
    }
    return true;
  }

  private optionFromText(question: AskUserQuestionItem, text: string) {
    const options = question.options ?? [];
    const numeric = /^\d+$/.test(text) ? Number(text) - 1 : -1;
    if (numeric >= 0 && numeric < options.length) return options[numeric];
    return options.find((option) => option.label === text);
  }

  private async advance(pending: PendingChannelQuestion, answer: AskUserQuestionAnswerItem): Promise<void> {
    await this.removeButtons(pending);
    pending.answers.push(answer);
    pending.questionIndex += 1;
    pending.selected.clear();
    pending.awaitingCustom = false;
    const adapter = this.options.getAdapter(pending.target.channelId);
    if (!adapter) return this.cancel(pending, '渠道已断开，问题已取消。');
    await this.present(pending, adapter, false);
  }

  private async submit(pending: PendingChannelQuestion): Promise<void> {
    if (pending.responding) return;
    pending.responding = true;
    try {
      await this.options.backend.resolve({
        key: pending.key,
        sessionId: pending.sessionId,
        answer: { answers: pending.answers },
      });
      await this.cleanup(pending);
    } catch (error) {
      pending.responding = false;
      throw error;
    }
  }

  private async cancel(pending: PendingChannelQuestion, notice: string): Promise<void> {
    if (pending.responding) return;
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
