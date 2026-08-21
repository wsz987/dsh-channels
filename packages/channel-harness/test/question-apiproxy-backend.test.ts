import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiProxyQuestionBackend } from '../src/interactions/question-apiproxy-backend.ts';
import type { QuestionInteractionSink } from '../src/interactions/question-backend.ts';
import {
  makeApiProxy,
  muxEnvelope,
  planReviewQuestion,
  requestedFrame,
  testLogger,
} from './question-test-utils.ts';

afterEach(() => {
  vi.clearAllMocks();
});

function makeSink() {
  const requests: unknown[] = [];
  const settled: string[] = [];
  const sink: QuestionInteractionSink = {
    questionRequested: vi.fn(async (request: unknown) => {
      requests.push(request);
      return true;
    }),
    questionSettledExternally: vi.fn(async (key: string) => {
      settled.push(key);
    }),
  };
  return { sink, requests, settled };
}

function setup() {
  const { apiProxy, responses } = makeApiProxy();
  const backend = new ApiProxyQuestionBackend({ apiProxy, logger: testLogger });
  const { sink, requests, settled } = makeSink();
  backend.start(sink);
  return { apiProxy, backend, requests, responses, settled };
}

describe('ApiProxyQuestionBackend', () => {
  it('forwards official question/requested frames with every official field intact', async () => {
    const { backend, requests } = setup();
    await backend.handleMuxEnvelope(muxEnvelope(requestedFrame([planReviewQuestion]), 'rpc-9'));

    expect(requests).toEqual([{
      key: 'rpc-9',
      sessionId: 'session-1',
      questions: [{
        id: 'plan_review',
        question: '是否按该计划执行？',
        detail: '1. 重构问题后端\n2. 跑全量测试',
        options: [{ label: '执行' }, { label: '需要修改' }, { label: '放弃' }],
        intent: { kind: 'plan-review', approve: '执行' },
      }],
    }]);
  });

  it('forwards question/resolved frames as external settlements keyed by rpcId', async () => {
    const { backend, settled } = setup();
    await backend.handleMuxEnvelope(muxEnvelope({
      type: 'question/resolved',
      sessionId: 'session-1',
      questionRpcId: 'rpc-7',
      outcome: 'answered',
    }, 'push-1'));
    expect(settled).toEqual(['rpc-7']);
  });

  it('ignores other official MuxFrame members silently (no warn, no sink call)', async () => {
    const { backend, requests, settled } = setup();
    await backend.handleMuxEnvelope(muxEnvelope({
      type: 'approval/requested',
      sessionId: 'session-1',
      approvalId: 'appr-1',
      toolName: 'shell',
    }, 'approval-rpc'));
    await backend.handleMuxEnvelope(muxEnvelope({
      type: 'session/subscribed',
      sessionId: 'session-1',
      lastSeq: 12,
    }, 'sub-rpc'));
    await backend.handleMuxEnvelope(muxEnvelope({ type: 'session/queue', sessionId: 'session-1', items: [] }, 'q'));

    expect(requests).toHaveLength(0);
    expect(settled).toHaveLength(0);
    expect(testLogger.warn).not.toHaveBeenCalled();
  });

  it('fails closed on malformed frames (warn, never reaching the sink)', async () => {
    const { backend, requests } = setup();
    await backend.handleMuxEnvelope({ nonsense: true });
    await backend.handleMuxEnvelope(muxEnvelope({
      type: 'question/requested',
      sessionId: 'session-1',
      questions: 'not-an-array',
    }, 'bad'));
    // The official intent schema is { kind: 'plan-review', approve: string } —
    // a non-string approve is a schema violation, rejected at this boundary.
    await backend.handleMuxEnvelope(muxEnvelope({
      type: 'question/requested',
      sessionId: 'session-1',
      questions: [{
        id: 'bad-intent',
        question: 'q',
        options: [{ label: 'A' }],
        intent: { kind: 'plan-review', approve: 42 as never },
      }],
    }, 'bad-intent'));
    await backend.handleMuxEnvelope(muxEnvelope({
      type: 'question/resolved',
      sessionId: 'session-1',
      questionRpcId: 'rpc-1',
      outcome: 'unknown' as never,
    }, 'bad-outcome'));

    expect(requests).toHaveLength(0);
    expect(testLogger.warn).toHaveBeenCalledWith('[channel-harness] invalid question mux envelope');
    expect(testLogger.warn).toHaveBeenCalledWith('[channel-harness] invalid question/requested frame');
    expect(testLogger.warn).toHaveBeenCalledWith('[channel-harness] invalid question/resolved frame');
  });

  it('resolves through the official client-response entry with a QuestionResponsePayload value', async () => {
    const { apiProxy, backend, responses } = setup();
    await backend.resolve({
      key: 'rpc-4',
      sessionId: 'session-1',
      answer: { answers: [{ id: 'pkg_mgr', selected: ['pnpm'] }] },
    });

    expect(apiProxy.respond).toHaveBeenCalledTimes(1);
    expect(responses).toEqual([{
      type: 'client-response',
      rpcId: 'rpc-4',
      result: {
        ok: true,
        value: {
          sessionId: 'session-1',
          answer: { answers: [{ id: 'pkg_mgr', selected: ['pnpm'] }] },
        },
      },
    }]);
  });

  it('warns (not throws) when the host rejects the answer receipt', async () => {
    const { apiProxy, backend } = setup();
    const respondMock = apiProxy.respond as unknown as ReturnType<typeof vi.fn>;
    respondMock.mockResolvedValueOnce({ accepted: false as const, reason: 'not-pending' as const });
    await expect(backend.resolve({
      key: 'rpc-late',
      sessionId: 'session-1',
      answer: { answers: [{ id: 'q', selected: [] }] },
    })).resolves.toBeUndefined();
    expect(testLogger.warn).toHaveBeenCalledWith(
      '[channel-harness] question answer was rejected',
      { sessionId: 'session-1', reason: 'not-pending' },
    );
  });

  it('cancels through a cancelled RpcError client-response', async () => {
    const { backend, responses } = setup();
    await backend.cancel({ key: 'rpc-x', reason: '问题已超时，请重新发起。' });

    expect(responses).toEqual([{
      type: 'client-response',
      rpcId: 'rpc-x',
      result: {
        ok: false,
        error: { code: 'cancelled', message: '问题已超时，请重新发起。', details: {} },
      },
    }]);
  });

  it('swallows transport failures when cancelling', async () => {
    const { apiProxy, backend } = setup();
    (apiProxy.respond as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('transport gone'));
    await expect(backend.cancel({ key: 'rpc-x', reason: '停止' }))
      .resolves.toBeUndefined();
  });

  it('opens one mux stream with an official RpcRequest open frame', async () => {
    const opens: unknown[] = [];
    const apiProxy = {
      events: {
        async *mux(request: unknown, signal: AbortSignal) {
          opens.push({ request, signal });
        },
      },
      respond: vi.fn(async () => ({ accepted: true as const })),
    };
    const backend = new ApiProxyQuestionBackend({
      apiProxy: apiProxy as never,
      logger: testLogger,
    });
    const { sink } = makeSink();
    backend.start(sink);
    await Promise.resolve();
    expect(opens).toHaveLength(1);
    const open = opens[0] as { request: { rpcId: string; payload: {} }; signal: AbortSignal };
    expect(open.request.rpcId).toMatch(/^[0-9a-f-]{36}$/);
    expect(open.request.payload).toEqual({});
    // One stream only, even across repeated start() calls.
    backend.start(sink);
    await Promise.resolve();
    expect(opens).toHaveLength(1);
    await backend.stop();
    expect(open.signal.aborted).toBe(true);
  });
});
