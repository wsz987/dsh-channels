import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
