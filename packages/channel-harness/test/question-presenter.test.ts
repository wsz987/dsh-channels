import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuestionAdapter } from './question-test-utils.ts';
import {
  actionId,
  interaction,
  message,
  muxEnvelope,
  packageManagerQuestion,
  planReviewQuestion,
  requestedFrame,
  setupPresenter,
  testLogger,
} from './question-test-utils.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ChannelQuestionPresenter', () => {
  it('renders official questions as bounded opaque actions and returns the original label', async () => {
    const { adapter, backend, presenter, responses } = setupPresenter();
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.text).toContain('**包管理器**');
    expect(adapter.sent[0]?.text).toContain('Node 自带，无需额外安装');
    const npmAction = actionId(adapter, 'npm (推荐)');
    expect(npmAction).toMatch(/^uq_[0-9a-f]{32}$/);
    expect(Buffer.byteLength(npmAction, 'utf8')).toBeLessThanOrEqual(64);

    await expect(presenter.handleChannelEvent(interaction(npmAction))).resolves.toBe(true);
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
    const { backend, presenter, responses } = setupPresenter();
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));

    await expect(presenter.handleChannelEvent(message('2'))).resolves.toBe(true);
    expect(responses).toHaveLength(1);
    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'pkg_mgr', selected: ['pnpm'] },
    ]);
  });

  it('single-flights rapid text replies so one question advances only once', async () => {
    const { adapter, backend, presenter, responses } = setupPresenter();
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));
    let releaseEdit!: () => void;
    adapter.editGate = new Promise<void>((resolve) => { releaseEdit = resolve; });

    const first = presenter.handleChannelEvent(message('1'));
    await Promise.resolve();
    await expect(presenter.handleChannelEvent(message('2'))).resolves.toBe(true);
    releaseEdit();
    await first;

    expect(responses).toHaveLength(1);
    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'pkg_mgr', selected: ['npm (推荐)'] },
    ]);
  });

  it('collects batched questions in order, including a custom text answer', async () => {
    const { adapter, backend, presenter, responses } = setupPresenter();
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([
      packageManagerQuestion,
      { id: 'location', header: '位置', question: '项目放在哪里？' },
    ]), 'rpc-batch'));

    await presenter.handleChannelEvent(interaction(actionId(adapter, 'yarn')));
    expect(adapter.sent).toHaveLength(2);
    await presenter.handleChannelEvent(message('D:/workspace/demo'));

    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'pkg_mgr', selected: ['yarn'] },
      { id: 'location', selected: [], custom: 'D:/workspace/demo' },
    ]);
  });

  it('presents a free-text question with a generic reply prompt', async () => {
    const { adapter, backend } = setupPresenter();
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([
      { id: 'location', question: '项目放在哪里？' },
    ])));

    expect(adapter.sent[0]).toMatchObject({
      replyPrompt: { kind: 'text' },
    });
    expect(adapter.sent[0]?.actions).toBeUndefined();
  });

  it('uses a separate reply prompt after the custom action and clears old controls', async () => {
    const { adapter, backend, presenter } = setupPresenter();
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));

    await presenter.handleChannelEvent(interaction(actionId(adapter, '其他')));

    expect(adapter.edited).toContainEqual({ actions: [] });
    expect(adapter.sent.at(-1)).toMatchObject({ replyPrompt: { kind: 'text' } });
  });

  it('requires group free-text answers to reply to the presented prompt', async () => {
    const { adapter, backend, presenter, responses } = setupPresenter({ conversationType: 'group' });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([
      { id: 'location', question: '项目放在哪里？' },
    ])));
    const promptId = '1';

    await expect(presenter.handleChannelEvent(message('unrelated', 'owner', 'chat-1', { type: 'group' })))
      .resolves.toBe(false);
    await expect(presenter.handleChannelEvent(message('D:/workspace/demo', 'owner', 'chat-1', {
      type: 'group',
      replyTo: promptId,
    }))).resolves.toBe(true);
    expect(responses).toHaveLength(1);
    expect(adapter.sent[0]?.replyPrompt).toBeDefined();
  });

  it('consumes an explicitly @mentioned numeric answer to an actions question in a group', async () => {
    const { backend, presenter, responses } = setupPresenter({ conversationType: 'group' });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));

    await expect(presenter.handleChannelEvent(message('2', 'owner', 'chat-1', {
      type: 'group',
      mentionedBot: true,
    }))).resolves.toBe(true);
    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'pkg_mgr', selected: ['pnpm'] },
    ]);
  });

  it('supports multi-select toggles and submits only the latest selected set', async () => {
    const { adapter, backend, presenter, responses } = setupPresenter();
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([{
      ...packageManagerQuestion,
      multiSelect: true,
    }]), 'rpc-multi'));

    await presenter.handleChannelEvent(interaction(actionId(adapter, 'npm (推荐)')));
    expect(adapter.edited.at(-1)?.actions?.[0]?.actions[0]?.label).toBe('✓ npm (推荐)');
    const pnpm = adapter.edited.at(-1)?.actions
      ?.flatMap((row) => row.actions)
      .find((item) => item.label === 'pnpm')?.id;
    expect(pnpm).toBeTruthy();
    await presenter.handleChannelEvent(interaction(pnpm!));
    const latestDone = adapter.edited.at(-1)?.actions
      ?.flatMap((row) => row.actions)
      .find((item) => item.label === '完成')?.id;
    await presenter.handleChannelEvent(interaction(latestDone!));

    expect((responses[0] as any).result.value.answer.answers).toEqual([{
      id: 'pkg_mgr',
      selected: ['npm (推荐)', 'pnpm'],
    }]);
  });

  it('passes intent/detail/header through and marks the plan-review approve option primary', async () => {
    const { adapter, backend, presenter, responses } = setupPresenter();
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([planReviewQuestion]), 'rpc-plan'));

    // Presentation cue: plan-review heading + detail body + primary approve.
    expect(adapter.sent[0]?.text).toContain('计划评审');
    expect(adapter.sent[0]?.text).toContain('1. 重构问题后端');
    const rows = adapter.sent[0]?.actions?.flatMap((row) => row.actions) ?? [];
    expect(rows.find((item) => item.label === '执行')?.style).toBe('primary');
    expect(rows.find((item) => item.label === '需要修改')?.style).toBeUndefined();

    await presenter.handleChannelEvent(interaction(actionId(adapter, '执行')));
    // Answer encoding is identical to a generic question (intent never
    // changes the protocol): selected labels, no intent loss downstream.
    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'plan_review', selected: ['执行'] },
    ]);
  });

  it('rejects replay, wrong-conversation, and wrong-sender answers', async () => {
    const { adapter, backend, presenter, responses } = setupPresenter();
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));
    // Replay of the same still-pending rpcId (official mux reuses rpcId on
    // stream reopen): already owned, no second presentation.
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));
    expect(adapter.sent).toHaveLength(1);
    const npmAction = actionId(adapter, 'npm (推荐)');

    await expect(presenter.handleChannelEvent(interaction(npmAction, 'owner', 'other-chat')))
      .resolves.toBe(false);
    await expect(presenter.handleChannelEvent(interaction(npmAction, 'other-user')))
      .resolves.toBe(true);
    expect(responses).toHaveLength(0);
    await presenter.handleChannelEvent(interaction(npmAction));
    await expect(presenter.handleChannelEvent(interaction(npmAction))).resolves.toBe(false);
    expect(responses).toHaveLength(1);
  });

  it('declines questions without an active channel reply context', async () => {
    const { adapter, backend, presenter, responses } = setupPresenter({ active: false });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));
    expect(adapter.sent).toHaveLength(0);
    expect(responses).toHaveLength(0);
  });

  it('declines a second question on a conversation that already has one pending', async () => {
    const { adapter, backend, presenter, responses } = setupPresenter();
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion]), 'rpc-1'));
    await backend.handleMuxEnvelope(muxEnvelope(
      requestedFrame([{ id: 'other', question: '另一个问题？' }], 'session-1'),
      'rpc-2',
    ));
    expect(adapter.sent).toHaveLength(1);
    expect(responses).toHaveLength(0);
    expect(testLogger.warn).toHaveBeenCalledWith(
      '[channel-harness] channel question already pending',
      expect.anything(),
    );
  });

  it('removes stale controls when another client resolves the question first', async () => {
    const { adapter, backend, presenter } = setupPresenter();
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));
    await backend.handleMuxEnvelope(muxEnvelope({
      type: 'question/resolved',
      sessionId: 'session-1',
      questionRpcId: 'rpc-1',
      outcome: 'answered',
    }, 'resolution-event'));

    expect(adapter.edited).toContainEqual({ actions: [] });
    await expect(presenter.handleChannelEvent(message('1'))).resolves.toBe(false);
  });

  it('does not resolve or advance when an external settlement races an in-flight answer', async () => {
    const { adapter, backend, presenter, responses } = setupPresenter();
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));
    let releaseEdit!: () => void;
    adapter.editGate = new Promise<void>((resolve) => { releaseEdit = resolve; });

    const channelAnswer = presenter.handleChannelEvent(message('1'));
    await vi.waitFor(() => expect(adapter.edited.length).toBeGreaterThan(0));
    const externalSettlement = backend.handleMuxEnvelope(muxEnvelope({
      type: 'question/resolved',
      sessionId: 'session-1',
      questionRpcId: 'rpc-1',
      outcome: 'answered',
    }, 'resolution-race'));
    await Promise.resolve();

    releaseEdit();
    await Promise.all([channelAnswer, externalSettlement]);

    expect(responses).toHaveLength(0);
    expect(adapter.sent).toHaveLength(1);
    await expect(presenter.handleChannelEvent(message('2'))).resolves.toBe(false);
  });

  it('cancels timed-out questions and clears their buttons', async () => {
    vi.useFakeTimers();
    const { adapter, backend, presenter, responses } = setupPresenter({ timeoutMs: 1_000 });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));
    await vi.advanceTimersByTimeAsync(1_000);

    expect((responses[0] as any).result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
    expect(adapter.edited).toContainEqual({ actions: [] });
    expect(adapter.sent.at(-1)?.text).toContain('问题已超时');
  });

  it('cancels one question instead of terminating the mux flow when channel send fails', async () => {
    const { adapter, backend, presenter, responses } = setupPresenter();
    adapter.failSend = true;
    await expect(
      backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion]))),
    ).resolves.toBeUndefined();
    expect((responses[0] as any).result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
  });

  // -------------------------------------------------------------------------
  // P0 text fallback (interactiveActions=false) — plan §7.1 T1..T15
  // -------------------------------------------------------------------------

  function replyTokenOf(adapter: QuestionAdapter): string {
    const text = adapter.sent.at(-1)?.text ?? '';
    const match = text.match(/Q-[0-9A-F]{6}/);
    if (!match) throw new Error(`no reply token in rendered text: ${JSON.stringify(text)}`);
    return match[0];
  }

  it('T1: accepts a question on a text-only adapter without buttons', async () => {
    const { adapter, backend } = setupPresenter({ interactiveActions: false });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.actions).toBeUndefined();
    expect(adapter.sent[0]?.text).toContain('1. npm (推荐)');
    expect(adapter.sent[0]?.text).toContain('2. pnpm');
    expect(adapter.sent[0]?.text).toContain('3. yarn');
    expect(adapter.sent[0]?.text).toContain('回复 1 / 2 / 3，或直接回复选项文字。');
  });

  it('T2: options without description still render numbered in text mode', async () => {
    const { adapter, backend } = setupPresenter({ interactiveActions: false });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([planReviewQuestion])));

    expect(adapter.sent[0]?.text).toContain('1. 执行');
    expect(adapter.sent[0]?.text).toContain('2. 需要修改');
    expect(adapter.sent[0]?.text).toContain('3. 放弃');
  });

  it('T3: a DM numeric reply selects the matching option', async () => {
    const { backend, presenter, responses } = setupPresenter({ interactiveActions: false });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));

    await expect(presenter.handleChannelEvent(message('2'))).resolves.toBe(true);
    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'pkg_mgr', selected: ['pnpm'] },
    ]);
  });

  it('T4: an exact option label reply selects that option', async () => {
    const { backend, presenter, responses } = setupPresenter({ interactiveActions: false });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));

    await expect(presenter.handleChannelEvent(message('pnpm'))).resolves.toBe(true);
    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'pkg_mgr', selected: ['pnpm'] },
    ]);
  });

  it('T5: unmatched text becomes a custom answer', async () => {
    const { backend, presenter, responses } = setupPresenter({ interactiveActions: false });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));

    await expect(presenter.handleChannelEvent(message('bun'))).resolves.toBe(true);
    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'pkg_mgr', selected: [], custom: 'bun' },
    ]);
  });

  it('T6: multi-select text reply selects options in options order', async () => {
    const { backend, presenter, responses } = setupPresenter({ interactiveActions: false });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([
      { ...packageManagerQuestion, multiSelect: true },
    ]), 'rpc-multi'));

    await expect(presenter.handleChannelEvent(message('1,3'))).resolves.toBe(true);
    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'pkg_mgr', selected: ['npm (推荐)', 'yarn'] },
    ]);
  });

  it('T7: an out-of-range multi-select reply stays pending and can be retried', async () => {
    const { adapter, backend, presenter, responses } = setupPresenter({ interactiveActions: false });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([
      { ...packageManagerQuestion, multiSelect: true },
    ]), 'rpc-multi'));

    await expect(presenter.handleChannelEvent(message('1,9'))).resolves.toBe(true);
    expect(responses).toHaveLength(0);
    expect(adapter.sent.at(-1)?.text).toBe('选项无效，请回复 1-3；多选可回复 1,3。');

    await expect(presenter.handleChannelEvent(message('1,2'))).resolves.toBe(true);
    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'pkg_mgr', selected: ['npm (推荐)', 'pnpm'] },
    ]);
  });

  it('T8: batched questions collect a numeric then a custom text answer', async () => {
    const { backend, presenter, responses } = setupPresenter({ interactiveActions: false });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([
      packageManagerQuestion,
      { id: 'location', header: '位置', question: '项目放在哪里？' },
    ]), 'rpc-batch'));

    await expect(presenter.handleChannelEvent(message('2'))).resolves.toBe(true);
    await expect(presenter.handleChannelEvent(message('D:/workspace/demo'))).resolves.toBe(true);
    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'pkg_mgr', selected: ['pnpm'] },
      { id: 'location', selected: [], custom: 'D:/workspace/demo' },
    ]);
  });

  it('T9: plan-review text fallback keeps intent/detail/header and the protocol label', async () => {
    const { adapter, backend, presenter, responses } = setupPresenter({ interactiveActions: false });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([planReviewQuestion]), 'rpc-plan'));

    expect(adapter.sent[0]?.text).toContain('计划评审');
    expect(adapter.sent[0]?.text).toContain('1. 重构问题后端');
    expect(adapter.sent[0]?.text).toContain('1. 执行');
    expect(adapter.sent[0]?.actions).toBeUndefined();

    await expect(presenter.handleChannelEvent(message('1'))).resolves.toBe(true);
    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'plan_review', selected: ['执行'] },
    ]);
  });

  it('T10: a slash command while a question is pending is not consumed', async () => {
    const { backend, presenter, responses } = setupPresenter({ interactiveActions: false });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));

    await expect(presenter.handleChannelEvent(message('/stop'))).resolves.toBe(false);
    expect(responses).toHaveLength(0);
  });

  it('T11: group replies correlating via replyTo are still accepted in text mode', async () => {
    const { adapter, backend, presenter, responses } = setupPresenter({
      interactiveActions: false,
      conversationType: 'group',
    });
    // A free-text question renders with a replyPrompt, so the presenter keeps
    // the sent messageId as promptMessageId — replyTo correlation applies.
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([
      { id: 'location', question: '项目放在哪里？' },
    ])));
    const promptId = '1';

    await expect(presenter.handleChannelEvent(message('unrelated', 'owner', 'chat-1', { type: 'group' })))
      .resolves.toBe(false);
    await expect(presenter.handleChannelEvent(message('D:/workspace/demo', 'owner', 'chat-1', {
      type: 'group',
      replyTo: promptId,
    }))).resolves.toBe(true);
    expect(responses).toHaveLength(1);
    expect(adapter.sent[0]?.replyPrompt).toBeDefined();
  });

  it('T12: group replies carrying the replyToken are accepted and stripped', async () => {
    const { adapter, backend, presenter, responses } = setupPresenter({
      interactiveActions: false,
      conversationType: 'group',
    });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));

    const token = replyTokenOf(adapter);
    expect(token).toMatch(/^Q-[0-9A-F]{6}$/);
    expect(adapter.sent[0]?.text).toContain(`如果当前渠道无法关联回复，请发送：${token} 2`);

    // Unrelated group message without the token is not consumed.
    await expect(presenter.handleChannelEvent(message('unrelated', 'owner', 'chat-1', { type: 'group' })))
      .resolves.toBe(false);

    // Token-prefixed answers are accepted; the token is stripped before parsing.
    await expect(presenter.handleChannelEvent(message(`${token} 2`, 'owner', 'chat-1', { type: 'group' })))
      .resolves.toBe(true);
    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'pkg_mgr', selected: ['pnpm'] },
    ]);
  });

  it('T12b: token correlation also accepts colon and @-mention forms', async () => {
    const { adapter, backend, presenter, responses } = setupPresenter({
      interactiveActions: false,
      conversationType: 'group',
    });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion]), 'rpc-colon'));
    const tokenColon = replyTokenOf(adapter);
    await expect(presenter.handleChannelEvent(message(
      `${tokenColon}: 1`, 'owner', 'chat-1', { type: 'group' },
    ))).resolves.toBe(true);

    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion]), 'rpc-mention'));
    const tokenMention = replyTokenOf(adapter);
    await expect(presenter.handleChannelEvent(message(
      `@bot ${tokenMention} 3`, 'owner', 'chat-1', { type: 'group' },
    ))).resolves.toBe(true);

    expect((responses[0] as any).result.value.answer.answers).toEqual([
      { id: 'pkg_mgr', selected: ['npm (推荐)'] },
    ]);
    expect((responses[1] as any).result.value.answer.answers).toEqual([
      { id: 'pkg_mgr', selected: ['yarn'] },
    ]);
  });

  it('T13: a wrong sender cannot answer a pending question', async () => {
    const { backend, presenter, responses } = setupPresenter({ interactiveActions: false });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));

    await expect(presenter.handleChannelEvent(message('2', 'other-user'))).resolves.toBe(false);
    expect(responses).toHaveLength(0);
    await expect(presenter.handleChannelEvent(message('2'))).resolves.toBe(true);
    expect(responses).toHaveLength(1);
  });

  it('T14: external settlement clears the pending question so later numbers are not swallowed', async () => {
    const { backend, presenter, responses } = setupPresenter({ interactiveActions: false });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));
    await backend.handleMuxEnvelope(muxEnvelope({
      type: 'question/resolved',
      sessionId: 'session-1',
      questionRpcId: 'rpc-1',
      outcome: 'answered',
    }, 'resolution-event'));

    await expect(presenter.handleChannelEvent(message('2'))).resolves.toBe(false);
    expect(responses).toHaveLength(0);
  });

  it('T15: text-mode questions time out and cancel like actions mode', async () => {
    vi.useFakeTimers();
    const { adapter, backend, presenter, responses } = setupPresenter({
      timeoutMs: 1_000,
      interactiveActions: false,
    });
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([packageManagerQuestion])));
    await vi.advanceTimersByTimeAsync(1_000);

    expect((responses[0] as any).result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
    expect(adapter.sent.at(-1)?.text).toContain('问题已超时');
  });
});
