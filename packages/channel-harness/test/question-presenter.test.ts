import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuestionAdapter } from './question-test-utils.ts';
import {
  actionId,
  interaction,
  message,
  packageManagerQuestion,
  planReviewQuestion,
  setupPresenter,
  testLogger,
} from './question-test-utils.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ChannelQuestionPresenter', () => {
  it('renders official questions as bounded opaque actions and returns the original label', async () => {
    const { adapter, presenter, present } = setupPresenter();
    const { pending } = await present([packageManagerQuestion]);

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.text).toContain('**包管理器**');
    expect(adapter.sent[0]?.text).toContain('Node 自带，无需额外安装');
    const npmAction = actionId(adapter, 'npm (推荐)');
    expect(npmAction).toMatch(/^uq_[0-9a-f]{32}$/);
    expect(Buffer.byteLength(npmAction, 'utf8')).toBeLessThanOrEqual(64);

    await expect(presenter.handleChannelEvent(interaction(npmAction))).resolves.toBe(true);
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'pkg_mgr', selected: ['npm (推荐)'] }],
    });
    expect(adapter.edited).toContainEqual({ actions: [] });
  });

  it('maps a numeric text reply to the corresponding option before Agent routing', async () => {
    const { presenter, present } = setupPresenter();
    const { pending } = await present([packageManagerQuestion]);

    await expect(presenter.handleChannelEvent(message('2'))).resolves.toBe(true);
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'pkg_mgr', selected: ['pnpm'] }],
    });
  });

  it('single-flights rapid text replies so one question advances only once', async () => {
    const { adapter, presenter, present } = setupPresenter();
    const { pending } = await present([packageManagerQuestion]);
    let releaseEdit!: () => void;
    adapter.editGate = new Promise<void>((resolve) => { releaseEdit = resolve; });

    const first = presenter.handleChannelEvent(message('1'));
    await Promise.resolve();
    await expect(presenter.handleChannelEvent(message('2'))).resolves.toBe(true);
    releaseEdit();
    await first;

    await expect(pending).resolves.toEqual({
      answers: [{ id: 'pkg_mgr', selected: ['npm (推荐)'] }],
    });
  });

  it('collects batched questions in order, including a custom text answer', async () => {
    const { adapter, presenter, present } = setupPresenter();
    const { pending } = await present([
      packageManagerQuestion,
      { id: 'location', header: '位置', question: '项目放在哪里？' },
    ]);

    await presenter.handleChannelEvent(interaction(actionId(adapter, 'yarn')));
    expect(adapter.sent).toHaveLength(2);
    await presenter.handleChannelEvent(message('D:/workspace/demo'));

    await expect(pending).resolves.toEqual({
      answers: [
        { id: 'pkg_mgr', selected: ['yarn'] },
        { id: 'location', selected: [], custom: 'D:/workspace/demo' },
      ],
    });
  });

  it('presents a free-text question with a generic reply prompt', async () => {
    const { adapter, present } = setupPresenter();
    await present([{ id: 'location', question: '项目放在哪里？' }]);

    expect(adapter.sent[0]).toMatchObject({
      replyPrompt: { kind: 'text' },
    });
    expect(adapter.sent[0]?.actions).toBeUndefined();
  });

  it('uses a separate reply prompt after the custom action and clears old controls', async () => {
    const { adapter, presenter, present } = setupPresenter();
    await present([packageManagerQuestion]);

    await presenter.handleChannelEvent(interaction(actionId(adapter, '其他')));

    expect(adapter.edited).toContainEqual({ actions: [] });
    expect(adapter.sent.at(-1)).toMatchObject({ replyPrompt: { kind: 'text' } });
  });

  it('requires group free-text answers to reply to the presented prompt', async () => {
    const { adapter, presenter, present } = setupPresenter({ conversationType: 'group' });
    const { pending } = await present([{ id: 'location', question: '项目放在哪里？' }]);
    const promptId = '1';

    await expect(presenter.handleChannelEvent(message('unrelated', 'owner', 'chat-1', { type: 'group' })))
      .resolves.toBe(false);
    await expect(presenter.handleChannelEvent(message('D:/workspace/demo', 'owner', 'chat-1', {
      type: 'group',
      replyTo: promptId,
    }))).resolves.toBe(true);
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'location', selected: [], custom: 'D:/workspace/demo' }],
    });
    expect(adapter.sent[0]?.replyPrompt).toBeDefined();
  });

  it('consumes an explicitly @mentioned numeric answer to an actions question in a group', async () => {
    const { presenter, present } = setupPresenter({ conversationType: 'group' });
    const { pending } = await present([packageManagerQuestion]);

    await expect(presenter.handleChannelEvent(message('2', 'owner', 'chat-1', {
      type: 'group',
      mentionedBot: true,
    }))).resolves.toBe(true);
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'pkg_mgr', selected: ['pnpm'] }],
    });
  });

  it('supports multi-select toggles and submits only the latest selected set', async () => {
    const { adapter, presenter, present } = setupPresenter();
    const { pending } = await present([{ ...packageManagerQuestion, multiSelect: true }]);

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

    await expect(pending).resolves.toEqual({
      answers: [{ id: 'pkg_mgr', selected: ['npm (推荐)', 'pnpm'] }],
    });
  });

  it('passes intent/detail/header through and marks the plan-review approve option primary', async () => {
    const { adapter, presenter, present } = setupPresenter();
    const { pending } = await present([planReviewQuestion]);

    // Presentation cue: plan-review heading + detail body + primary approve.
    expect(adapter.sent[0]?.text).toContain('计划评审');
    expect(adapter.sent[0]?.text).toContain('1. 重构问题后端');
    const rows = adapter.sent[0]?.actions?.flatMap((row) => row.actions) ?? [];
    expect(rows.find((item) => item.label === '执行')?.style).toBe('primary');
    expect(rows.find((item) => item.label === '需要修改')?.style).toBeUndefined();

    await presenter.handleChannelEvent(interaction(actionId(adapter, '执行')));
    // Answer encoding is identical to a generic question (intent never
    // changes the protocol): selected labels, no intent loss downstream.
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'plan_review', selected: ['执行'] }],
    });
  });

  it('declines a second ask while one question is pending on the conversation', async () => {
    const { adapter, present } = setupPresenter();
    await present([packageManagerQuestion]);
    // Second official ask for the same conversation: the channel declines,
    // the waterfall has no other answerer, the official service rejects.
    const { pending: second } = await present([{ id: 'other', question: '另一个问题？' }]);

    expect(adapter.sent).toHaveLength(1);
    expect(testLogger.warn).toHaveBeenCalledWith(
      '[channel-harness] channel question already pending',
      expect.anything(),
    );
    await expect(second).rejects.toMatchObject({ code: 'NO_PROVIDER' });
  });

  it('removes stale controls and unswallows replies when the owning ask aborts', async () => {
    const { adapter, presenter, present } = setupPresenter();
    const controller = new AbortController();
    const { pending } = await present([packageManagerQuestion], { signal: controller.signal });
    const npmAction = actionId(adapter, 'npm (推荐)');

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    expect(adapter.edited).toContainEqual({ actions: [] });
    // The aborted question no longer swallows channel replies.
    await expect(presenter.handleChannelEvent(interaction(npmAction))).resolves.toBe(false);
  });

  it('does not submit an in-flight channel answer that races an ask abort', async () => {
    const { adapter, presenter, present } = setupPresenter();
    const controller = new AbortController();
    const { pending } = await present([packageManagerQuestion], { signal: controller.signal });
    let releaseEdit!: () => void;
    adapter.editGate = new Promise<void>((resolve) => { releaseEdit = resolve; });

    const channelAnswer = presenter.handleChannelEvent(message('1'));
    await vi.waitFor(() => expect(adapter.edited.length).toBeGreaterThan(0));
    controller.abort();
    await Promise.resolve();

    releaseEdit();
    await channelAnswer;
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    expect(adapter.sent).toHaveLength(1);
    await expect(presenter.handleChannelEvent(message('2'))).resolves.toBe(false);
  });

  it('declines questions without an active channel reply context', async () => {
    const { adapter, present } = setupPresenter({ active: false });
    const { pending } = await present([packageManagerQuestion]);
    expect(adapter.sent).toHaveLength(0);
    // Declined -> delegated -> no other answerer -> the official fallback.
    await expect(pending).rejects.toMatchObject({ code: 'NO_PROVIDER' });
  });

  it('cancels timed-out questions and clears their buttons', async () => {
    vi.useFakeTimers();
    const { adapter, present } = setupPresenter({ timeoutMs: 1_000 });
    const { pending } = await present([packageManagerQuestion]);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).rejects.toMatchObject({
      code: 'ASK_ABORTED',
      message: '问题已超时，请重新发起。',
    });
    expect(adapter.edited).toContainEqual({ actions: [] });
    expect(adapter.sent.at(-1)?.text).toContain('问题已超时');
  });

  it('cancels the question instead of throwing when the channel send fails', async () => {
    const { adapter, present } = setupPresenter();
    adapter.failSend = true;
    const { pending } = await present([packageManagerQuestion]);
    await expect(pending).rejects.toMatchObject({
      code: 'ASK_ABORTED',
      message: '无法在当前渠道展示问题，已取消。',
    });
  });

  it('degrades a failed native-actions presentation to numbered text instead of cancelling', async () => {
    // Real case: DingTalk declares `interactiveActions` from a configured card
    // template, but the template is not published in this org -> the card send
    // throws. The question must survive as text, not be cancelled.
    const { adapter, presenter, present } = setupPresenter({ interactiveActions: true });
    adapter.failSendOnce = true;
    const { pending } = await present([packageManagerQuestion]);

    // The failed actions attempt recorded nothing; one degraded text send landed.
    expect(adapter.sent).toHaveLength(1);
    const text = adapter.sent.at(-1)!;
    expect(text.actions).toBeUndefined();
    expect(text.text).toContain('1. npm (推荐)');
    expect(text.text).toContain('回复 1 / 2 / 3');
    expect(testLogger.warn).toHaveBeenCalledWith(
      '[channel-harness] interactive actions failed to present; falling back to numbered text',
      expect.objectContaining({ error: 'actions send failed' }),
    );

    // The downgraded batch is answerable by plain text.
    await expect(presenter.handleChannelEvent(message('2'))).resolves.toBe(true);
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'pkg_mgr', selected: ['pnpm'] }],
    });
  });

  it('still cancels when the degraded text presentation also fails', async () => {
    const { adapter, present } = setupPresenter({ interactiveActions: true });
    adapter.failSend = true;
    adapter.failSendOnce = true;
    const { pending } = await present([packageManagerQuestion]);
    await expect(pending).rejects.toMatchObject({
      code: 'ASK_ABORTED',
      message: '无法在当前渠道展示问题，已取消。',
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
    const { adapter, present } = setupPresenter({ interactiveActions: false });
    await present([packageManagerQuestion]);

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.actions).toBeUndefined();
    expect(adapter.sent[0]?.text).toContain('1. npm (推荐)');
    expect(adapter.sent[0]?.text).toContain('2. pnpm');
    expect(adapter.sent[0]?.text).toContain('3. yarn');
    expect(adapter.sent[0]?.text).toContain('回复 1 / 2 / 3，或直接回复选项文字。');
  });

  it('T2: options without description still render numbered in text mode', async () => {
    const { adapter, present } = setupPresenter({ interactiveActions: false });
    await present([planReviewQuestion]);

    expect(adapter.sent[0]?.text).toContain('1. 执行');
    expect(adapter.sent[0]?.text).toContain('2. 需要修改');
    expect(adapter.sent[0]?.text).toContain('3. 放弃');
  });

  it('T3: a DM numeric reply selects the matching option', async () => {
    const { presenter, present } = setupPresenter({ interactiveActions: false });
    const { pending } = await present([packageManagerQuestion]);

    await expect(presenter.handleChannelEvent(message('2'))).resolves.toBe(true);
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'pkg_mgr', selected: ['pnpm'] }],
    });
  });

  it('T4: an exact option label reply selects that option', async () => {
    const { presenter, present } = setupPresenter({ interactiveActions: false });
    const { pending } = await present([packageManagerQuestion]);

    await expect(presenter.handleChannelEvent(message('pnpm'))).resolves.toBe(true);
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'pkg_mgr', selected: ['pnpm'] }],
    });
  });

  it('T5: unmatched text becomes a custom answer', async () => {
    const { presenter, present } = setupPresenter({ interactiveActions: false });
    const { pending } = await present([packageManagerQuestion]);

    await expect(presenter.handleChannelEvent(message('bun'))).resolves.toBe(true);
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'pkg_mgr', selected: [], custom: 'bun' }],
    });
  });

  it('T6: multi-select text reply selects options in options order', async () => {
    const { presenter, present } = setupPresenter({ interactiveActions: false });
    const { pending } = await present([{ ...packageManagerQuestion, multiSelect: true }]);

    await expect(presenter.handleChannelEvent(message('1,3'))).resolves.toBe(true);
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'pkg_mgr', selected: ['npm (推荐)', 'yarn'] }],
    });
  });

  it('T7: an out-of-range multi-select reply stays pending and can be retried', async () => {
    const { adapter, presenter, present } = setupPresenter({ interactiveActions: false });
    const { pending } = await present([{ ...packageManagerQuestion, multiSelect: true }]);

    await expect(presenter.handleChannelEvent(message('1,9'))).resolves.toBe(true);
    expect(adapter.sent.at(-1)?.text).toBe('选项无效，请回复 1-3；多选可回复 1,3。');

    await expect(presenter.handleChannelEvent(message('1,2'))).resolves.toBe(true);
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'pkg_mgr', selected: ['npm (推荐)', 'pnpm'] }],
    });
  });

  it('T8: batched questions collect a numeric then a custom text answer', async () => {
    const { presenter, present } = setupPresenter({ interactiveActions: false });
    const { pending } = await present([
      packageManagerQuestion,
      { id: 'location', header: '位置', question: '项目放在哪里？' },
    ]);

    await expect(presenter.handleChannelEvent(message('2'))).resolves.toBe(true);
    await expect(presenter.handleChannelEvent(message('D:/workspace/demo'))).resolves.toBe(true);
    await expect(pending).resolves.toEqual({
      answers: [
        { id: 'pkg_mgr', selected: ['pnpm'] },
        { id: 'location', selected: [], custom: 'D:/workspace/demo' },
      ],
    });
  });

  it('T9: plan-review text fallback keeps intent/detail/header and the protocol label', async () => {
    const { adapter, presenter, present } = setupPresenter({ interactiveActions: false });
    const { pending } = await present([planReviewQuestion]);

    expect(adapter.sent[0]?.text).toContain('计划评审');
    expect(adapter.sent[0]?.text).toContain('1. 重构问题后端');
    expect(adapter.sent[0]?.text).toContain('1. 执行');
    expect(adapter.sent[0]?.actions).toBeUndefined();

    await expect(presenter.handleChannelEvent(message('1'))).resolves.toBe(true);
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'plan_review', selected: ['执行'] }],
    });
  });

  it('T10: a slash command while a question is pending is not consumed', async () => {
    const { presenter, present } = setupPresenter({ interactiveActions: false });
    await present([packageManagerQuestion]);

    await expect(presenter.handleChannelEvent(message('/stop'))).resolves.toBe(false);
  });

  it('T11: group replies correlating via replyTo are still accepted in text mode', async () => {
    const { adapter, presenter, present } = setupPresenter({
      interactiveActions: false,
      conversationType: 'group',
    });
    // A free-text question renders with a replyPrompt, so the presenter keeps
    // the sent messageId as promptMessageId — replyTo correlation applies.
    const { pending } = await present([{ id: 'location', question: '项目放在哪里？' }]);
    const promptId = '1';

    await expect(presenter.handleChannelEvent(message('unrelated', 'owner', 'chat-1', { type: 'group' })))
      .resolves.toBe(false);
    await expect(presenter.handleChannelEvent(message('D:/workspace/demo', 'owner', 'chat-1', {
      type: 'group',
      replyTo: promptId,
    }))).resolves.toBe(true);
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'location', selected: [], custom: 'D:/workspace/demo' }],
    });
    expect(adapter.sent[0]?.replyPrompt).toBeDefined();
  });

  it('T12: group replies carrying the replyToken are accepted and stripped', async () => {
    const { adapter, presenter, present } = setupPresenter({
      interactiveActions: false,
      conversationType: 'group',
    });
    const { pending } = await present([packageManagerQuestion]);

    const token = replyTokenOf(adapter);
    expect(token).toMatch(/^Q-[0-9A-F]{6}$/);
    expect(adapter.sent[0]?.text).toContain(`如果当前渠道无法关联回复，请发送：${token} 2`);

    // Unrelated group message without the token is not consumed.
    await expect(presenter.handleChannelEvent(message('unrelated', 'owner', 'chat-1', { type: 'group' })))
      .resolves.toBe(false);

    // Token-prefixed answers are accepted; the token is stripped before parsing.
    await expect(presenter.handleChannelEvent(message(`${token} 2`, 'owner', 'chat-1', { type: 'group' })))
      .resolves.toBe(true);
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'pkg_mgr', selected: ['pnpm'] }],
    });
  });

  it('T12b: token correlation also accepts colon and @-mention forms', async () => {
    const { adapter, presenter, present } = setupPresenter({
      interactiveActions: false,
      conversationType: 'group',
    });
    const { pending: first } = await present([packageManagerQuestion]);
    const tokenColon = replyTokenOf(adapter);
    await expect(presenter.handleChannelEvent(message(
      `${tokenColon}: 1`, 'owner', 'chat-1', { type: 'group' },
    ))).resolves.toBe(true);

    const { pending: second } = await present([packageManagerQuestion]);
    const tokenMention = replyTokenOf(adapter);
    await expect(presenter.handleChannelEvent(message(
      `@bot ${tokenMention} 3`, 'owner', 'chat-1', { type: 'group' },
    ))).resolves.toBe(true);

    await expect(first).resolves.toEqual({
      answers: [{ id: 'pkg_mgr', selected: ['npm (推荐)'] }],
    });
    await expect(second).resolves.toEqual({
      answers: [{ id: 'pkg_mgr', selected: ['yarn'] }],
    });
  });

  it('T13: a wrong sender cannot answer a pending question', async () => {
    const { presenter, present } = setupPresenter({ interactiveActions: false });
    const { pending } = await present([packageManagerQuestion]);

    await expect(presenter.handleChannelEvent(message('2', 'other-user'))).resolves.toBe(false);
    await expect(presenter.handleChannelEvent(message('2'))).resolves.toBe(true);
    await expect(pending).resolves.toEqual({
      answers: [{ id: 'pkg_mgr', selected: ['pnpm'] }],
    });
  });
});

