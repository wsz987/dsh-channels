/**
 * Shared fixtures for the question interaction tests (interactions/ modules).
 *
 * Questions are driven through the OFFICIAL `ctx.userQuestions.ask()` — the
 * same waterfall dispatch the `ask_user_question` tool uses in dsh 0.1.2 —
 * so the tests exercise the real `user-questions/request` contract (items
 * incl. `intent`, agent-scoped dispatch, NO_PROVIDER delegation) rather than
 * a local mirror.
 */
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  UserQuestionService,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions';
import { vi } from 'vitest';
import type {
  ChannelAdapter,
  InteractionReceived,
  MessageReceived,
  OutboundMessage,
} from '@wsz987/channel-core';
import type { AgentManager } from '../src/agent-manager.ts';
import { ReplyContextStore } from '../src/reply-context-store.ts';
import { WaterfallQuestionBackend } from '../src/interactions/question-waterfall-backend.ts';
import { ChannelQuestionPresenter } from '../src/interactions/question-presenter.ts';

export const testLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

export class QuestionAdapter {
  readonly id = 'telegram';
  readonly capabilities: { text: boolean; interactiveActions: boolean };
  readonly sent: OutboundMessage[] = [];
  readonly edited: OutboundMessage[] = [];
  editGate?: Promise<void>;
  failSend = false;
  /** Fail ONLY the first send (e.g. a native-actions attempt), then succeed. */
  failSendOnce = false;

  constructor(options: { interactiveActions?: boolean } = {}) {
    this.capabilities = {
      text: true,
      interactiveActions: options.interactiveActions ?? true,
    };
  }

  async send(_target: unknown, message: OutboundMessage) {
    if (this.failSend) throw new Error('send failed');
    if (this.failSendOnce) {
      this.failSendOnce = false;
      throw new Error('actions send failed');
    }
    this.sent.push(message);
    return { delivered: true, messageId: String(this.sent.length) };
  }

  async edit(_target: unknown, _messageId: string, message: OutboundMessage) {
    this.edited.push(message);
    await this.editGate;
    return { delivered: true, messageId: _messageId };
  }
}

export function message(
  text: string,
  senderId = 'owner',
  conversationId = 'chat-1',
  options: { type?: 'dm' | 'group'; replyTo?: string; threadId?: string; mentionedBot?: boolean } = {},
): MessageReceived {
  return {
    type: 'message.received',
    channel: 'telegram' as never,
    accountId: 'main' as never,
    conversation: {
      id: conversationId as never,
      type: options.type ?? 'dm',
      ...(options.threadId ? { threadId: options.threadId as never } : {}),
    },
    sender: { id: senderId as never },
    message: {
      id: `m-${text}` as never,
      content: [{ type: 'text', text }],
      ...(options.replyTo ? { replyTo: options.replyTo as never } : {}),
      ...(options.mentionedBot !== undefined
        ? { activation: { mentionedBot: options.mentionedBot } }
        : {}),
    },
  };
}

export function interaction(
  action: string,
  senderId = 'owner',
  conversationId = 'chat-1',
): InteractionReceived {
  return {
    type: 'interaction.received',
    channel: 'telegram' as never,
    accountId: 'main' as never,
    conversation: { id: conversationId as never, type: 'dm' },
    sender: { id: senderId as never },
    interactionId: `i-${action}`,
    action,
  };
}

export const packageManagerQuestion: AskUserQuestionItem = {
  id: 'pkg_mgr',
  header: '包管理器',
  question: '你希望用哪个包管理器？',
  options: [
    { label: 'npm (推荐)', description: 'Node 自带，无需额外安装' },
    { label: 'pnpm', description: '安装速度快、节省磁盘' },
    { label: 'yarn', description: '经典选择' },
  ],
};

/** Plan-review intent fixture (official `AskUserQuestionIntent`). */
export const planReviewQuestion: AskUserQuestionItem = {
  id: 'plan_review',
  question: '是否按该计划执行？',
  detail: '1. 重构问题后端\n2. 跑全量测试',
  options: [{ label: '执行' }, { label: '需要修改' }, { label: '放弃' }],
  intent: { kind: 'plan-review', approve: '执行' },
};

export interface PresenterHarness {
  adapter: QuestionAdapter;
  backend: WaterfallQuestionBackend;
  presenter: ChannelQuestionPresenter;
  userQuestions: UserQuestionService;
  /**
   * Dispatch one official ask and wait until the presentation decision has
   * landed (the question was rendered, or the ask settled — e.g. declined /
   * aborted). Resolves to `{ pending }` — the ask promise wrapped in a
   * NON-thenable object, because `await` would otherwise adopt and wait on
   * the still-open ask itself. Channel interactions later resolve or reject
   * `pending`.
   */
  present(
    questions: AskUserQuestionItem[],
    options?: { signal?: AbortSignal },
  ): Promise<{ pending: Promise<AskUserQuestionAnswer> }>;
}

/**
 * Wire a presenter on the waterfall backend and mount the official
 * `ctx.userQuestions` service (with the fake live-agents registry `ask()`
 * validates against) so tests drive the real ask() dispatch.
 */
export function setupPresenter(options: {
  active?: boolean;
  timeoutMs?: number;
  conversationType?: 'dm' | 'group';
  threadId?: string;
  interactiveActions?: boolean;
} = {}): PresenterHarness {
  const adapter = new QuestionAdapter({
    interactiveActions: options.interactiveActions ?? true,
  });
  const rootCtx = new Context();
  const userQuestions = new UserQuestionService(rootCtx);
  const liveAgent = { id: SessionId('session-1') };
  rootCtx.provide('agents', {
    get: (id: unknown) => (String(id) === 'session-1' ? liveAgent : undefined),
    roots: (): unknown[] => [liveAgent],
  });
  const replyContexts = new ReplyContextStore();
  if (options.active !== false) {
    replyContexts.register('message-1', {
      sessionId: 'session-1',
      context: {
        conversationType: options.conversationType ?? 'dm',
        senderId: 'owner',
        replyToMessageId: 'telegram-message-1',
      },
    });
    replyContexts.claim({ sessionId: 'session-1', messageId: 'message-1', turn: 1 });
  }
  const agentManager = {
    bindingFor: (sessionId: string) => sessionId === 'session-1'
      ? {
          channelId: 'telegram',
          accountId: 'main',
          conversationId: 'chat-1',
          conversationType: options.conversationType ?? 'dm',
          ...(options.threadId ? { threadId: options.threadId } : {}),
          sessionId,
        }
      : undefined,
  } as unknown as AgentManager;
  const backend = new WaterfallQuestionBackend({ ctx: rootCtx, logger: testLogger });
  const presenter = new ChannelQuestionPresenter({
    backend,
    agentManager,
    replyContexts,
    getAdapter: (channelId) => channelId === 'telegram'
      ? adapter as unknown as ChannelAdapter
      : undefined,
    logger: testLogger,
    timeoutMs: options.timeoutMs ?? 300_000,
  });
  presenter.start();

  function present(
    questions: AskUserQuestionItem[],
    options: { signal?: AbortSignal } = {},
  ): Promise<{ pending: Promise<AskUserQuestionAnswer> }> {
    let settled = false;
    const sentBefore = adapter.sent.length;
    const pending = userQuestions.ask({
      questions,
      agent: liveAgent as never,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // Presentation decision: the question rendered (a NEW sent message), or
    // the ask already settled (declined -> NO_PROVIDER rejection, abort,
    // timeout).
    return vi.waitFor(() => {
      if (adapter.sent.length > sentBefore || settled) return;
      throw new Error('presentation still pending');
    }).then(() => ({ pending }));
  }

  return { adapter, backend, presenter, userQuestions, present };
}

export function actionId(adapter: QuestionAdapter, label: string): string {
  const action = adapter.sent.at(-1)?.actions
    ?.flatMap((row) => row.actions)
    .find((item) => item.label === label);
  if (!action) throw new Error(`missing action '${label}'`);
  return action.id;
}
