import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  UserQuestionService,
  type AskUserQuestionAnswer,
} from '@deepseek-ai/dsh-user-questions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WaterfallQuestionBackend } from '../src/interactions/question-waterfall-backend.ts';
import type {
  QuestionInteractionRequest,
  QuestionInteractionSink,
} from '../src/interactions/question-backend.ts';
import { planReviewQuestion, testLogger } from './question-test-utils.ts';

afterEach(() => {
  vi.clearAllMocks();
});

interface SinkRecord {
  requests: QuestionInteractionRequest[];
  settled: Array<{ key: string; state?: 'aborted' | 'externally-settled' }>;
  accepted: boolean;
}

function makeSink(accepted = true): { sink: QuestionInteractionSink } & SinkRecord {
  const record: SinkRecord = { requests: [], settled: [], accepted };
  const sink: QuestionInteractionSink = {
    async questionRequested(request) {
      record.requests.push(request);
      return record.accepted;
    },
    async questionSettledExternally(key, state) {
      record.settled.push({ key, state });
    },
  };
  return { sink, ...record };
}

/**
 * Minimal waterfall harness: the OFFICIAL UserQuestionService dispatches on a
 * real Cordis Context; the fake `agents` registry satisfies the service's
 * live-agent validation, and the backend listens on the root context.
 */
function setup(accepted = true) {
  const rootCtx = new Context();
  const userQuestions = new UserQuestionService(rootCtx);
  const liveAgent = { id: SessionId('session-1') };
  rootCtx.provide('agents', {
    get: (id: unknown) => (String(id) === 'session-1' ? liveAgent : undefined),
    roots: (): unknown[] => [liveAgent],
  });
  const backend = new WaterfallQuestionBackend({ ctx: rootCtx, logger: testLogger });
  const { sink, ...record } = makeSink(accepted);
  backend.start(sink);
  function ask(options: { questions?: typeof planReviewQuestion[]; signal?: AbortSignal; withAgent?: boolean } = {}) {
    const { withAgent = true } = options;
    return userQuestions.ask({
      questions: options.questions ?? [planReviewQuestion],
      ...(withAgent ? { agent: liveAgent as never } : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
  return { backend, userQuestions, liveAgent, ask, ...record };
}

const ANSWER: AskUserQuestionAnswer = { answers: [{ id: 'plan_review', selected: ['执行'] }] };

describe('WaterfallQuestionBackend (official user-questions waterfall)', () => {
  it('claims an official ask, forwards every official field intact, and resolves with the channel answer', async () => {
    const { backend, ask, requests } = setup();
    const pending = ask();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const request = requests[0]!;
    expect(request.sessionId).toBe('session-1');
    // Full official field set survives the waterfall hop (incl. intent).
    expect(request.questions[0]).toEqual(planReviewQuestion);
    expect(request.questions[0]?.intent).toEqual({ kind: 'plan-review', approve: '执行' });

    await expect(backend.resolve({ key: request.key, sessionId: 'session-1', answer: ANSWER }))
      .resolves.toBeUndefined();
    await expect(pending).resolves.toEqual(ANSWER);
  });

  it('delegates to the next answerer when the channel declines ownership (headless: NO_PROVIDER)', async () => {
    const { ask, requests, settled } = setup(false);
    const pending = ask();
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    // No further answerer exists, so the official service's fallback rejects.
    await expect(pending).rejects.toMatchObject({ code: 'NO_PROVIDER' });
    expect(settled).toHaveLength(0);
  });

  /**
   * Regression: the shipped `web` profile composes the OFFICIAL Remote/Web
   * answerer (`@deepseek-ai/dsh-api-remotes`, whose fiber applies at boot,
   * before the bridge) on the same Agent-scoped waterfall. Cordis waterfalls
   * are sequential — the first listener that returns an answer vetoes the
   * rest — so an ordinary `ctx.on()` registration loses the ask to the Web
   * UI permanently. The channel answerer must therefore be PREPENDED.
   */
  it('claims an ask ahead of an already-registered Remote/Web answerer (boot-order race)', async () => {
    const rootCtx = new Context();
    const userQuestions = new UserQuestionService(rootCtx);
    const liveAgent = { id: SessionId('session-1') };
    rootCtx.provide('agents', {
      get: (id: unknown) => (String(id) === 'session-1' ? liveAgent : undefined),
      roots: (): unknown[] => [liveAgent],
    });
    // Stand-in for `dsh-api-remotes`: registered BEFORE the bridge, claims the
    // ask by returning the browser's answer.
    const WEB_ANSWER: AskUserQuestionAnswer = {
      answers: [{ id: 'plan_review', selected: ['（浏览器作答）'] }],
    };
    const webAsks: unknown[] = [];
    rootCtx.on('user-questions/request', async (request) => {
      webAsks.push(request);
      return WEB_ANSWER;
    });

    const backend = new WaterfallQuestionBackend({ ctx: rootCtx, logger: testLogger });
    const { sink, ...record } = makeSink(true);
    backend.start(sink);
    const pending = userQuestions.ask({ questions: [planReviewQuestion], agent: liveAgent as never });

    // The channel must own the ask, not the Web answerer.
    await vi.waitFor(() => expect(record.requests).toHaveLength(1));
    expect(webAsks).toHaveLength(0);
    const key = record.requests[0]!.key;
    await backend.resolve({ key, sessionId: 'session-1', answer: ANSWER });
    await expect(pending).resolves.toEqual(ANSWER);
  });

  it('still reaches a later Remote/Web answerer when the channel declines', async () => {
    const rootCtx = new Context();
    const userQuestions = new UserQuestionService(rootCtx);
    const liveAgent = { id: SessionId('session-1') };
    rootCtx.provide('agents', {
      get: (id: unknown) => (String(id) === 'session-1' ? liveAgent : undefined),
      roots: (): unknown[] => [liveAgent],
    });
    rootCtx.on('user-questions/request', async () => ({ answers: [{ id: 'plan_review', selected: ['（浏览器作答）'] }] }));

    const backend = new WaterfallQuestionBackend({ ctx: rootCtx, logger: testLogger });
    const { sink, ...record } = makeSink(false);
    backend.start(sink);
    await expect(
      userQuestions.ask({ questions: [planReviewQuestion], agent: liveAgent as never }),
    ).resolves.toEqual({ answers: [{ id: 'plan_review', selected: ['（浏览器作答）'] }] });
    expect(record.requests).toHaveLength(1);
  });

  it('delegates asks without an owning agent (no session to bind to a channel conversation)', async () => {
    const { ask } = setup();
    // The official service accepts agent-less asks; the channel cannot route
    // them, so the backend must delegate — NO_PROVIDER with no other listener.
    await expect(ask({ withAgent: false })).rejects.toMatchObject({ code: 'NO_PROVIDER' });
  });

  it('rejects the ask with ASK_ABORTED and drops channel controls when the tool signal aborts', async () => {
    const { backend, ask, requests, settled } = setup();
    const controller = new AbortController();
    const pending = ask({ signal: controller.signal });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const key = requests[0]!.key;

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    expect(settled).toEqual([{ key, state: 'aborted' }]);
    // A racing channel answer after abort is a backend no-op.
    await expect(backend.resolve({ key, sessionId: 'session-1', answer: ANSWER }))
      .resolves.toBeUndefined();
  });

  it('rejects the ask with the human-readable reason when the channel cancels (timeout path)', async () => {
    const { backend, ask, requests } = setup();
    const pending = ask();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const key = requests[0]!.key;

    await backend.cancel({ key, reason: '问题已超时，请重新发起。' });
    await expect(pending).rejects.toMatchObject({
      code: 'ASK_ABORTED',
      message: '问题已超时，请重新发起。',
    });
  });

  it('disposes the waterfall listener and rejects every open ask on stop()', async () => {
    const rootCtx = new Context();
    const userQuestions = new UserQuestionService(rootCtx);
    const liveAgent = { id: SessionId('session-1') };
    rootCtx.provide('agents', {
      get: (id: unknown) => (String(id) === 'session-1' ? liveAgent : undefined),
      roots: (): unknown[] => [liveAgent],
    });
    const backend = new WaterfallQuestionBackend({ ctx: rootCtx, logger: testLogger });
    const { sink, ...record } = makeSink(true);
    backend.start(sink);
    const first = userQuestions.ask({ questions: [planReviewQuestion], agent: liveAgent as never });
    const second = userQuestions.ask({ questions: [planReviewQuestion], agent: liveAgent as never });
    await vi.waitFor(() => expect(record.requests).toHaveLength(2));

    await backend.stop();
    await expect(first).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    await expect(second).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    // After stop the listener is disposed: a late ask falls through the empty
    // waterfall to the official NO_PROVIDER rejection instead of hanging.
    await expect(
      userQuestions.ask({ questions: [planReviewQuestion], agent: liveAgent as never }),
    ).rejects.toMatchObject({ code: 'NO_PROVIDER' });
  });

  it('start() is idempotent: a second start never double-registers or double-presents', async () => {
    const first = setup();
    // Re-start on the same backend with a different sink must be a no-op.
    const secondSink = makeSink(true).sink;
    first.backend.start(secondSink);
    const pending = first.ask();
    await vi.waitFor(() => expect(first.requests).toHaveLength(1));
    await first.backend.resolve({ key: first.requests[0]!.key, sessionId: 'session-1', answer: ANSWER });
    await expect(pending).resolves.toEqual(ANSWER);
  });
});
