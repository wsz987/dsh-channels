import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AskUserQuestionRequest, UserQuestionProvider } from '@deepseek-ai/dsh-user-questions';
import { DirectQuestionBackend } from '../src/interactions/question-direct-backend.ts';
import type {
  QuestionInteractionRequest,
  QuestionInteractionSink,
} from '../src/interactions/question-backend.ts';
import {
  planReviewQuestion,
  testLogger,
} from './question-test-utils.ts';

afterEach(() => {
  vi.clearAllMocks();
});

interface SinkRecord {
  requests: QuestionInteractionRequest[];
  settled: string[];
  accepted: boolean;
}

function makeSink(accepted = true): { sink: QuestionInteractionSink } & SinkRecord {
  const record: SinkRecord = { requests: [], settled: [], accepted };
  const sink: QuestionInteractionSink = {
    async questionRequested(request) {
      record.requests.push(request);
      return record.accepted;
    },
    async questionSettledExternally(key) {
      record.settled.push(key);
    },
  };
  return { sink, ...record };
}

function makeUserQuestions() {
  let registered: UserQuestionProvider | undefined;
  let disposed = false;
  const registerProvider = vi.fn((provider: UserQuestionProvider) => {
    registered = provider;
    return () => {
      disposed = true;
      registered = undefined;
    };
  });
  return {
    service: { registerProvider },
    registerProvider,
    getRegistered: () => (disposed ? undefined : registered),
    get disposed() {
      return disposed;
    },
  };
}

const fakeAgent = { id: 'session-1' } as AskUserQuestionRequest['agent'];

function setup(accepted = true) {
  const userQuestions = makeUserQuestions();
  const backend = new DirectQuestionBackend({ userQuestions: userQuestions.service, logger: testLogger });
  const sink = makeSink(accepted);
  backend.start(sink.sink);
  return { backend, sink, userQuestions };
}

describe('DirectQuestionBackend (official UserQuestionProvider, headless)', () => {
  it('registers itself as the single official provider on start', () => {
    const { backend, userQuestions } = setup();
    expect(userQuestions.registerProvider).toHaveBeenCalledTimes(1);
    expect(userQuestions.registerProvider).toHaveBeenCalledWith(backend);
    expect(userQuestions.getRegistered()).toBe(backend);
  });

  it('routes an official ask() through the sink and resolves it with the channel answer', async () => {
    const { backend, sink, userQuestions } = setup();
    const provider = userQuestions.getRegistered()!;
    const ask = provider.ask({ questions: [planReviewQuestion], agent: fakeAgent });

    await vi.waitFor(() => expect(sink.requests).toHaveLength(1));
    const request = sink.requests[0]!;
    expect(request.sessionId).toBe('session-1');
    // Full official field set survives the provider hop (incl. intent).
    expect(request.questions[0]).toEqual(planReviewQuestion);
    expect(request.questions[0]?.intent).toEqual({ kind: 'plan-review', approve: '执行' });

    await backend.resolve({
      key: request.key,
      sessionId: 'session-1',
      answer: { answers: [{ id: 'plan_review', selected: ['执行'] }] },
    });
    await expect(ask).resolves.toEqual({
      answers: [{ id: 'plan_review', selected: ['执行'] }],
    });
  });

  it('rejects an ask without an agent (no session to bind) with the official error shape', async () => {
    const { backend, userQuestions } = setup();
    const provider = userQuestions.getRegistered()!;
    await expect(provider.ask({ questions: [planReviewQuestion] })).rejects.toMatchObject({
      code: 'ASK_MISSING_AGENT',
    });
  });

  it('fails the ask immediately when the channel declines ownership (no silent hang)', async () => {
    const { backend, userQuestions } = setup(false);
    const provider = userQuestions.getRegistered()!;
    const ask = provider.ask({ questions: [planReviewQuestion], agent: fakeAgent });
    await expect(ask).rejects.toMatchObject({ code: 'ASK_ABORTED' });
  });

  it('rejects the ask with ASK_ABORTED and drops channel controls when the tool signal aborts', async () => {
    const { backend, sink, userQuestions } = setup();
    const provider = userQuestions.getRegistered()!;
    const controller = new AbortController();
    const ask = provider.ask({ questions: [planReviewQuestion], agent: fakeAgent, signal: controller.signal });
    await vi.waitFor(() => expect(sink.requests).toHaveLength(1));

    controller.abort();
    await expect(ask).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    expect(sink.settled).toEqual([sink.requests[0]!.key]);
    // A racing channel answer after abort is a backend no-op.
    await expect(backend.resolve({
      key: sink.requests[0]!.key,
      sessionId: 'session-1',
      answer: { answers: [] },
    })).resolves.toBeUndefined();
  });

  it('rejects the ask with the human-readable reason when the channel cancels (timeout path)', async () => {
    const { backend, sink, userQuestions } = setup();
    const provider = userQuestions.getRegistered()!;
    const ask = provider.ask({ questions: [planReviewQuestion], agent: fakeAgent });
    await vi.waitFor(() => expect(sink.requests).toHaveLength(1));

    await backend.cancel({ key: sink.requests[0]!.key, reason: '问题已超时，请重新发起。' });
    await expect(ask).rejects.toMatchObject({
      code: 'ASK_ABORTED',
      message: '问题已超时，请重新发起。',
    });
  });

  it('disposes the provider and rejects every open ask on stop()', async () => {
    const { backend, sink, userQuestions } = setup();
    const provider = userQuestions.getRegistered()!;
    const asks = [
      provider.ask({ questions: [planReviewQuestion], agent: fakeAgent }),
      provider.ask({ questions: [planReviewQuestion], agent: fakeAgent }),
    ];
    await vi.waitFor(() => expect(sink.requests).toHaveLength(2));

    await backend.stop();
    for (const ask of asks) {
      await expect(ask).rejects.toMatchObject({ code: 'ASK_ABORTED' });
    }
    expect(userQuestions.disposed).toBe(true);
    // After stop, a late ask hits the not-started guard instead of hanging.
    await expect(provider.ask({ questions: [planReviewQuestion], agent: fakeAgent }))
      .rejects.toMatchObject({ code: 'ASK_ABORTED' });
  });

  it('never mints ApiProxy wire frames — settlement is promise-based only', async () => {
    const { backend, sink, userQuestions } = setup();
    const provider = userQuestions.getRegistered()!;
    const ask = provider.ask({ questions: [planReviewQuestion], agent: fakeAgent });
    await vi.waitFor(() => expect(sink.requests).toHaveLength(1));
    await backend.resolve({
      key: sink.requests[0]!.key,
      sessionId: 'session-1',
      answer: { answers: [{ id: 'plan_review', selected: ['放弃'] }] },
    });
    await expect(ask).resolves.toEqual({ answers: [{ id: 'plan_review', selected: ['放弃'] }] });
  });
});
