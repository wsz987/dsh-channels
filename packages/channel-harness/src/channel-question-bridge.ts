import { randomUUID } from 'node:crypto';
import { z } from 'zod';
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
import type { AgentManager } from './agent-manager.js';
import type { ReplyContextStore } from './reply-context-store.js';

type RpcId = string;

const questionItemSchema = z.object({
  id: z.string(),
  question: z.string(),
  header: z.string().optional(),
  detail: z.string().optional(),
  options: z.array(z.object({
    label: z.string(),
    description: z.string().optional(),
  })).optional(),
  multiSelect: z.boolean().optional(),
});

const questionRequestedSchema = z.object({
  type: z.literal('question/requested'),
  sessionId: z.string(),
  questions: z.array(questionItemSchema).min(1),
});

const questionResolvedSchema = z.object({
  type: z.literal('question/resolved'),
  sessionId: z.string(),
  questionRpcId: z.string(),
  outcome: z.enum(['answered', 'cancelled']),
});

const muxEnvelopeSchema = z.object({
  rpcId: z.string(),
  payload: z.object({ type: z.string() }).passthrough(),
});

type QuestionFrame = z.infer<typeof questionRequestedSchema>;
type QuestionItem = QuestionFrame['questions'][number];
type AnswerItem = { id: string; selected: string[]; custom?: string };

interface ChannelQuestionApiProxy {
  events: {
    mux(
      request: { rpcId: string; payload: { since?: Record<string, number> } },
      signal: AbortSignal,
    ): AsyncIterable<unknown>;
  };
  respond(message: {
    type: 'client-response';
    rpcId: string;
    result:
      | { ok: true; value: { sessionId: string; answer: { answers: AnswerItem[] } } }
      | {
          ok: false;
          error: { code: 'cancelled'; message: string; details: Record<string, never> };
        };
  }): Promise<{ accepted: true } | { accepted: false; reason: 'not-pending' | 'bad-response' }>;
}

interface PendingAction {
  pending: PendingQuestion;
  kind: 'option' | 'custom' | 'done' | 'skip';
  optionIndex?: number;
}

interface PendingQuestion {
  rpcId: RpcId;
  sessionId: string;
  questions: QuestionItem[];
  answers: AnswerItem[];
  questionIndex: number;
  selected: Set<string>;
  awaitingCustom: boolean;
  processing: boolean;
  responding: boolean;
  target: ChannelTarget;
  conversationKey: string;
  allowedSenderId: string;
  actionIds: Set<string>;
  messageId?: string;
  renderedText?: string;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ChannelQuestionBridgeOptions {
  apiProxy: ChannelQuestionApiProxy;
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
 * Public ApiProxy-mux client that presents channel-origin Harness questions
 * through generic Channel actions. It never inspects Telegram payloads.
 */
export class ChannelQuestionBridge {
  private readonly pendingByRpcId = new Map<string, PendingQuestion>();
  private readonly pendingByConversation = new Map<string, PendingQuestion>();
  private readonly actions = new Map<string, PendingAction>();
  private streamAbort?: AbortController;

  constructor(private readonly options: ChannelQuestionBridgeOptions) {}

  start(): void {
    if (this.streamAbort) return;
    const controller = new AbortController();
    this.streamAbort = controller;
    const request = {
      rpcId: randomUUID(),
      payload: {},
    };
    void this.consumeMux(request, controller.signal).catch((error) => {
      if (!controller.signal.aborted) {
        this.options.logger.error('[channel-harness] question mux failed', error);
      }
    });
  }

  async stop(): Promise<void> {
    this.streamAbort?.abort();
    this.streamAbort = undefined;
    for (const pending of [...this.pendingByRpcId.values()]) {
      await this.cancel(pending, 'channel question bridge stopped');
    }
  }

  /** Testable entry point for one official ApiProxy mux envelope. */
  async handleMuxEnvelope(input: unknown): Promise<void> {
    const envelope = muxEnvelopeSchema.safeParse(input);
    if (!envelope.success) {
      this.options.logger.warn('[channel-harness] invalid question mux envelope');
      return;
    }
    if (envelope.data.payload.type === 'question/requested') {
      const frame = questionRequestedSchema.safeParse(envelope.data.payload);
      if (!frame.success) {
        this.options.logger.warn('[channel-harness] invalid question/requested frame');
        return;
      }
      await this.handleRequested(envelope.data.rpcId, frame.data);
    } else if (envelope.data.payload.type === 'question/resolved') {
      const frame = questionResolvedSchema.safeParse(envelope.data.payload);
      if (!frame.success) {
        this.options.logger.warn('[channel-harness] invalid question/resolved frame');
        return;
      }
      const pending = this.pendingByRpcId.get(frame.data.questionRpcId);
      if (pending) await this.cleanup(pending);
    }
  }

  /** Consume an already-authorized channel answer before it reaches Agent inbox. */
  async handleChannelEvent(event: ChannelEvent): Promise<boolean> {
    if (event.type === 'interaction.received') return this.handleInteraction(event);
    if (event.type === 'message.received') return this.handleMessage(event);
    return false;
  }

  private async consumeMux(
    request: { rpcId: string; payload: { since?: Record<string, number> } },
    signal: AbortSignal,
  ): Promise<void> {
    for await (const envelope of this.options.apiProxy.events.mux(request, signal)) {
      await this.handleMuxEnvelope(envelope);
    }
  }

  private async handleRequested(rpcId: RpcId, frame: QuestionFrame): Promise<void> {
    if (this.pendingByRpcId.has(String(rpcId))) return;
    const sessionId = String(frame.sessionId);
    const active = this.options.replyContexts.getActiveForSession(sessionId);
    const binding = this.options.agentManager.bindingFor(sessionId);
    if (!active || !binding || !active.context.senderId) return;
    const adapter = this.options.getAdapter(binding.channelId);
    if (!adapter?.capabilities.interactiveActions) return;

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
    const conversationKey = targetKey(target);
    if (this.pendingByConversation.has(conversationKey)) {
      this.options.logger.warn('[channel-harness] channel question already pending', {
        channel: binding.channelId,
        account: binding.accountId,
        conversation: binding.conversationId,
      });
      return;
    }

    const pending: PendingQuestion = {
      rpcId,
      sessionId,
      questions: frame.questions,
      answers: [],
      questionIndex: 0,
      selected: new Set(),
      awaitingCustom: false,
      processing: false,
      responding: false,
      target,
      conversationKey,
      allowedSenderId: active.context.senderId,
      actionIds: new Set(),
    };
    pending.timer = setTimeout(() => {
      void this.cancel(pending, '问题已超时，请重新发起。');
    }, this.options.timeoutMs);
    this.pendingByRpcId.set(String(rpcId), pending);
    this.pendingByConversation.set(conversationKey, pending);
    this.options.logger.info('[channel-harness] presenting user question on channel', {
      sessionId,
      channel: binding.channelId,
      questionCount: frame.questions.length,
    });
    try {
      await this.present(pending, adapter, false);
    } catch (error) {
      this.options.logger.error('[channel-harness] failed to present user question', error);
      await this.cancel(pending, '无法在当前渠道展示问题，已取消。');
    }
  }

  private async present(
    pending: PendingQuestion,
    adapter: ChannelAdapter,
    edit: boolean,
  ): Promise<void> {
    const question = pending.questions[pending.questionIndex];
    if (!question) return this.submit(pending);
    this.clearActions(pending);
    const message = this.renderQuestion(pending, question);
    pending.renderedText = message.text;
    if (edit && pending.messageId && adapter.edit) {
      await adapter.edit(pending.target, pending.messageId, message);
      return;
    }
    const result = await adapter.send(pending.target, message);
    pending.messageId = result.messageId;
  }

  private renderQuestion(pending: PendingQuestion, question: QuestionItem): OutboundMessage {
    const lines = [
      question.header ? `**${question.header}**` : '',
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

    const actions: OutboundActionRow[] = [];
    if (!pending.awaitingCustom) {
      for (const [index, option] of (question.options ?? []).entries()) {
        const selected = pending.selected.has(option.label);
        actions.push({
          actions: [{
            id: this.bindAction(pending, { kind: 'option', optionIndex: index }),
            label: `${selected ? '✓ ' : ''}${option.label}`,
          }],
        });
      }
      if (question.options?.length) {
        actions.push({ actions: [{ id: this.bindAction(pending, { kind: 'custom' }), label: '其他' }] });
        if (question.multiSelect) {
          actions.push({ actions: [{ id: this.bindAction(pending, { kind: 'done' }), label: '完成', style: 'primary' }] });
        }
      }
    }
    actions.push({ actions: [{ id: this.bindAction(pending, { kind: 'skip' }), label: '跳过本题' }] });
    return { text: lines.filter(Boolean).join('\n\n'), actions };
  }

  private bindAction(pending: PendingQuestion, action: Omit<PendingAction, 'pending'>): string {
    const id = `uq_${randomUUID().replaceAll('-', '')}`;
    pending.actionIds.add(id);
    this.actions.set(id, { pending, ...action });
    return id;
  }

  private async handleInteraction(event: InteractionReceived): Promise<boolean> {
    const action = this.actions.get(event.action);
    if (!action || action.pending.conversationKey !== eventKey(event)) return false;
    const pending = action.pending;
    if (String(event.sender.id) !== pending.allowedSenderId) return true;
    if (pending.processing || pending.responding) return true;
    const question = pending.questions[pending.questionIndex];
    if (!question) return true;

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
    const pending = this.pendingByConversation.get(eventKey(event));
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

  private optionFromText(question: QuestionItem, text: string) {
    const options = question.options ?? [];
    const numeric = /^\d+$/.test(text) ? Number(text) - 1 : -1;
    if (numeric >= 0 && numeric < options.length) return options[numeric];
    return options.find((option) => option.label === text);
  }

  private async advance(pending: PendingQuestion, answer: AnswerItem): Promise<void> {
    await this.removeButtons(pending);
    pending.answers.push(answer);
    pending.questionIndex += 1;
    pending.selected.clear();
    pending.awaitingCustom = false;
    const adapter = this.options.getAdapter(pending.target.channelId);
    if (!adapter) return this.cancel(pending, '渠道已断开，问题已取消。');
    await this.present(pending, adapter, false);
  }

  private async submit(pending: PendingQuestion): Promise<void> {
    if (pending.responding) return;
    pending.responding = true;
    try {
      const receipt = await this.options.apiProxy.respond({
        type: 'client-response',
        rpcId: pending.rpcId,
        result: {
          ok: true,
          value: {
            sessionId: pending.sessionId,
            answer: { answers: pending.answers },
          },
        },
      });
      if (!receipt.accepted) {
        this.options.logger.warn('[channel-harness] question answer was rejected', {
          sessionId: pending.sessionId,
          reason: receipt.reason,
        });
      }
      await this.cleanup(pending);
    } catch (error) {
      pending.responding = false;
      throw error;
    }
  }

  private async cancel(pending: PendingQuestion, notice: string): Promise<void> {
    if (pending.responding) return;
    pending.responding = true;
    await this.removeButtons(pending);
    const adapter = this.options.getAdapter(pending.target.channelId);
    if (adapter) await adapter.send(pending.target, { text: notice }).catch(() => {});
    await this.options.apiProxy.respond({
      type: 'client-response',
      rpcId: pending.rpcId,
      result: {
        ok: false,
        error: {
          code: 'cancelled',
          message: notice,
          details: {},
        },
      },
    }).catch(() => undefined);
    await this.cleanup(pending);
  }

  private async removeButtons(pending: PendingQuestion): Promise<void> {
    this.clearActions(pending);
    if (!pending.messageId) return;
    const adapter = this.options.getAdapter(pending.target.channelId);
    if (adapter?.edit) {
      await adapter.edit(pending.target, pending.messageId, { actions: [] }).catch(() => {});
    }
    pending.messageId = undefined;
  }

  private clearActions(pending: PendingQuestion): void {
    for (const id of pending.actionIds) this.actions.delete(id);
    pending.actionIds.clear();
  }

  private async cleanup(pending: PendingQuestion): Promise<void> {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = undefined;
    await this.removeButtons(pending);
    this.pendingByRpcId.delete(String(pending.rpcId));
    if (this.pendingByConversation.get(pending.conversationKey) === pending) {
      this.pendingByConversation.delete(pending.conversationKey);
    }
  }
}
