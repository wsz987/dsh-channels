/**
 * Shared fixtures for the question interaction tests (interactions/ modules).
 *
 * Wire fixtures use the OFFICIAL ApiProxy mux shapes
 * (`RpcRequest<MuxFrame>` envelopes, `AskUserQuestionItem` payloads incl.
 * `intent`) so the tests exercise the real dsh-host-apiproxy 0.1.1-rc.2
 * contract rather than a local mirror.
 */
import { vi } from 'vitest';
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types';
import type {
  ChannelAdapter,
  InteractionReceived,
  MessageReceived,
  OutboundMessage,
} from '@wsz987/channel-core';
import type { AgentManager } from '../src/agent-manager.ts';
import { ReplyContextStore } from '../src/reply-context-store.ts';
import { ApiProxyQuestionBackend } from '../src/interactions/question-apiproxy-backend.ts';
import { ChannelQuestionPresenter } from '../src/interactions/question-presenter.ts';
import type { ChannelQuestionApiProxy } from '../src/interactions/question-apiproxy-backend.ts';

export const testLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

export class QuestionAdapter {
  readonly id = 'telegram';
  readonly capabilities = { interactiveActions: true };
  readonly sent: OutboundMessage[] = [];
  readonly edited: OutboundMessage[] = [];
  editGate?: Promise<void>;
  failSend = false;

  async send(_target: unknown, message: OutboundMessage) {
    if (this.failSend) throw new Error('send failed');
    this.sent.push(message);
    return { delivered: true, messageId: String(this.sent.length) };
  }

  async edit(_target: unknown, _messageId: string, message: OutboundMessage) {
    this.edited.push(message);
    await this.editGate;
    return { delivered: true, messageId: _messageId };
  }
}

export function message(text: string, senderId = 'owner', conversationId = 'chat-1'): MessageReceived {
  return {
    type: 'message.received',
    channel: 'telegram' as never,
    accountId: 'main' as never,
    conversation: { id: conversationId as never, type: 'dm' },
    sender: { id: senderId as never },
    message: { id: `m-${text}` as never, content: [{ type: 'text', text }] },
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

/** Official `question/requested` MuxFrame payload fixture. */
export function requestedFrame(questions: AskUserQuestionItem[], sessionId = 'session-1') {
  return {
    type: 'question/requested' as const,
    sessionId,
    questions,
  };
}

/** Official `RpcRequest<MuxFrame>` mux envelope fixture. */
export function muxEnvelope(payload: unknown, rpcId = 'rpc-1') {
  return { rpcId, payload };
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

/** Minimal fake of the official ApiProxy question surfaces. */
export function makeApiProxy() {
  const responses: unknown[] = [];
  const apiProxy = {
    events: {
      async *mux() {
        // Tests drive validated envelopes directly through handleMuxEnvelope.
      },
    },
    respond: vi.fn(async (response: unknown) => {
      responses.push(response);
      return { accepted: true as const };
    }),
  };
  return { apiProxy: apiProxy as unknown as ChannelQuestionApiProxy, responses };
}

/** Wire a presenter on the ApiProxy backend (Web profile path). */
export function setupPresenter(options: { active?: boolean; timeoutMs?: number } = {}) {
  const adapter = new QuestionAdapter();
  const { apiProxy, responses } = makeApiProxy();
  const replyContexts = new ReplyContextStore();
  if (options.active !== false) {
    replyContexts.register('message-1', {
      sessionId: 'session-1',
      context: {
        conversationType: 'dm',
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
          conversationType: 'dm',
          sessionId,
        }
      : undefined,
  } as unknown as AgentManager;
  const backend = new ApiProxyQuestionBackend({ apiProxy, logger: testLogger });
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
  return { adapter, apiProxy, backend, presenter, responses };
}

export function actionId(adapter: QuestionAdapter, label: string): string {
  const action = adapter.sent.at(-1)?.actions
    ?.flatMap((row) => row.actions)
    .find((item) => item.label === label);
  if (!action) throw new Error(`missing action '${label}'`);
  return action.id;
}
