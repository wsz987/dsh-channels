import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelAdapter,
  InteractionReceived,
  MessageReceived,
  OutboundMessage,
} from '@wsz987/channel-core';
import type { AgentManager } from '../src/agent-manager.ts';
import { ChannelQuestionBridge } from '../src/channel-question-bridge.ts';
import { ReplyContextStore } from '../src/reply-context-store.ts';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

class QuestionAdapter {
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

function message(text: string, senderId = 'owner', conversationId = 'chat-1'): MessageReceived {
  return {
    type: 'message.received',
    channel: 'telegram' as never,
    accountId: 'main' as never,
    conversation: { id: conversationId as never, type: 'dm' },
    sender: { id: senderId as never },
    message: { id: `m-${text}` as never, content: [{ type: 'text', text }] },
  };
}

function interaction(
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

function requested(rpcId = 'rpc-1', questions: unknown[] = [packageManagerQuestion]) {
  return {
    rpcId,
    payload: {
      type: 'question/requested',
      sessionId: 'session-1',
      questions,
    },
  };
}

const packageManagerQuestion = {
  id: 'pkg_mgr',
  header: '包管理器',
  question: '你希望用哪个包管理器？',
  options: [
    { label: 'npm (推荐)', description: 'Node 自带，无需额外安装' },
    { label: 'pnpm', description: '安装速度快、节省磁盘' },
    { label: 'yarn', description: '经典选择' },
  ],
};

function setup(options: { active?: boolean; timeoutMs?: number } = {}) {
  const adapter = new QuestionAdapter();
  const responses: unknown[] = [];
  const apiProxy = {
    events: {
      async *mux() {
        // Tests drive validated envelopes directly.
      },
    },
    respond: vi.fn(async (response: unknown) => {
      responses.push(response);
      return { accepted: true as const };
    }),
  };
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
  const bridge = new ChannelQuestionBridge({
    apiProxy,
    agentManager,
    replyContexts,
    getAdapter: (channelId) => channelId === 'telegram'
      ? adapter as unknown as ChannelAdapter
      : undefined,
    logger,
    timeoutMs: options.timeoutMs ?? 300_000,
  });
  return { adapter, apiProxy, bridge, responses };
}

function actionId(adapter: QuestionAdapter, label: string): string {
  const action = adapter.sent.at(-1)?.actions
    ?.flatMap((row) => row.actions)
    .find((item) => item.label === label);
  if (!action) throw new Error(`missing action '${label}'`);
  return action.id;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ChannelQuestionBridge', () => {
  it('renders official questions as bounded opaque actions and returns the original label', async () => {
    const { adapter, bridge, responses } = setup();
    await bridge.handleMuxEnvelope(requested());

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.text).toContain('**包管理器**');
    expect(adapter.sent[0]?.text).toContain('Node 自带，无需额外安装');
    const npmAction = actionId(adapter, 'npm (推荐)');
    expect(npmAction).toMatch(/^uq_[0-9a-f]{32}$/);
    expect(Buffer.byteLength(npmAction, 'utf8')).toBeLessThanOrEqual(64);

    await expect(bridge.handleChannelEvent(interaction(npmAction))).resolves.toBe(true);
    expect(responses).toEqual([{
      type: 'client-response',
      rpcId: 'rpc-1',
      result: {
        ok: true,
        value: {
          sessionId: 'session-1',
          answer: { answers: [{ id: 'pkg_mgr', selected: ['npm (推荐)'] }] },
        },
      },
    }]);
    expect(adapter.edited).toContainEqual({ actions: [] });
  });

  it('maps a numeric text reply to the corresponding option before Agent routing', async () => {
    const { bridge, responses } = setup();
    await bridge.handleMuxEnvelope(requested());

    await expect(bridge.handleChannelEvent(message('2'))).resolves.toBe(true);
    expect(responses).toHaveLength(1);
    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'pkg_mgr', selected: ['pnpm'] },
    ]);
  });

  it('single-flights rapid text replies so one question advances only once', async () => {
    const { adapter, bridge, responses } = setup();
    await bridge.handleMuxEnvelope(requested());
    let releaseEdit!: () => void;
    adapter.editGate = new Promise<void>((resolve) => { releaseEdit = resolve; });

    const first = bridge.handleChannelEvent(message('1'));
    await Promise.resolve();
    await expect(bridge.handleChannelEvent(message('2'))).resolves.toBe(true);
    releaseEdit();
    await first;

    expect(responses).toHaveLength(1);
    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'pkg_mgr', selected: ['npm (推荐)'] },
    ]);
  });

  it('collects batched questions in order, including a custom text answer', async () => {
    const { adapter, bridge, responses } = setup();
    await bridge.handleMuxEnvelope(requested('rpc-batch', [
      packageManagerQuestion,
      { id: 'location', header: '位置', question: '项目放在哪里？' },
    ]));

    await bridge.handleChannelEvent(interaction(actionId(adapter, 'yarn')));
    expect(adapter.sent).toHaveLength(2);
    await bridge.handleChannelEvent(message('D:/workspace/demo'));

    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'pkg_mgr', selected: ['yarn'] },
      { id: 'location', selected: [], custom: 'D:/workspace/demo' },
    ]);
  });

  it('supports multi-select toggles and submits only the latest selected set', async () => {
    const { adapter, bridge, responses } = setup();
    await bridge.handleMuxEnvelope(requested('rpc-multi', [{
      ...packageManagerQuestion,
      multiSelect: true,
    }]));

    await bridge.handleChannelEvent(interaction(actionId(adapter, 'npm (推荐)')));
    expect(adapter.edited.at(-1)?.actions?.[0]?.actions[0]?.label).toBe('✓ npm (推荐)');
    const pnpm = adapter.edited.at(-1)?.actions
      ?.flatMap((row) => row.actions)
      .find((item) => item.label === 'pnpm')?.id;
    const done = adapter.edited.at(-1)?.actions
      ?.flatMap((row) => row.actions)
      .find((item) => item.label === '完成')?.id;
    expect(pnpm).toBeTruthy();
    expect(done).toBeTruthy();
    await bridge.handleChannelEvent(interaction(pnpm!));
    const latestDone = adapter.edited.at(-1)?.actions
      ?.flatMap((row) => row.actions)
      .find((item) => item.label === '完成')?.id;
    await bridge.handleChannelEvent(interaction(latestDone!));

    expect((responses[0] as any).result.value.answer.answers).toEqual([{
      id: 'pkg_mgr',
      selected: ['npm (推荐)', 'pnpm'],
    }]);
  });

  it('rejects replay, wrong-conversation, and wrong-sender answers', async () => {
    const { adapter, bridge, responses } = setup();
    await bridge.handleMuxEnvelope(requested());
    const npmAction = actionId(adapter, 'npm (推荐)');

    await expect(bridge.handleChannelEvent(interaction(npmAction, 'owner', 'other-chat')))
      .resolves.toBe(false);
    await expect(bridge.handleChannelEvent(interaction(npmAction, 'other-user')))
      .resolves.toBe(true);
    expect(responses).toHaveLength(0);
    await bridge.handleChannelEvent(interaction(npmAction));
    await expect(bridge.handleChannelEvent(interaction(npmAction))).resolves.toBe(false);
    expect(responses).toHaveLength(1);
  });

  it('ignores Web-origin questions without an active channel reply context', async () => {
    const { adapter, bridge, responses } = setup({ active: false });
    await bridge.handleMuxEnvelope(requested());
    expect(adapter.sent).toHaveLength(0);
    expect(responses).toHaveLength(0);
  });

  it('removes stale controls when another client resolves the question first', async () => {
    const { adapter, bridge } = setup();
    await bridge.handleMuxEnvelope(requested());
    await bridge.handleMuxEnvelope({
      rpcId: 'resolution-event',
      payload: {
        type: 'question/resolved',
        sessionId: 'session-1',
        questionRpcId: 'rpc-1',
        outcome: 'answered',
      },
    });

    expect(adapter.edited).toContainEqual({ actions: [] });
    await expect(bridge.handleChannelEvent(message('1'))).resolves.toBe(false);
  });

  it('cancels timed-out questions and clears their buttons', async () => {
    vi.useFakeTimers();
    const { adapter, bridge, responses } = setup({ timeoutMs: 1_000 });
    await bridge.handleMuxEnvelope(requested());
    await vi.advanceTimersByTimeAsync(1_000);

    expect((responses[0] as any).result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
    expect(adapter.edited).toContainEqual({ actions: [] });
    expect(adapter.sent.at(-1)?.text).toContain('问题已超时');
  });

  it('fails closed on malformed question envelopes', async () => {
    const { adapter, bridge } = setup();
    await bridge.handleMuxEnvelope({
      rpcId: 'bad',
      payload: { type: 'question/requested', sessionId: 'session-1', questions: 'not-an-array' },
    });
    expect(adapter.sent).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith('[channel-harness] invalid question/requested frame');
  });

  it('cancels one question instead of terminating the mux flow when channel send fails', async () => {
    const { adapter, bridge, responses } = setup();
    adapter.failSend = true;
    await expect(bridge.handleMuxEnvelope(requested())).resolves.toBeUndefined();
    expect((responses[0] as any).result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
  });
});
