/**
 * M3 acceptance: QQ buffered streaming driven by the generic ReplyRouter.
 *
 * Wires a real `QQAdapter` (over a FakeTransport) and a real `ReplyRouter`
 * imported from channel-harness source, then drives `assistant/chunk` and
 * `turn/end` records through it. QQ streams as `buffered` (no native
 * streaming, no editable cards) and the adapter has no `createReply`, so the
 * router must accumulate deltas and deliver exactly ONE `/message/send` with
 * the full concatenated text at `turn/end`. All assertions run on the generic
 * pipeline with capability negotiation only (`streaming: 'buffered'`) — the
 * harness module is never special-cased and the channel id `'qq'` appears
 * only as binding data.
 */
import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, ChannelError } from '@dsh/channel-core';
import { createTestContext } from '@dsh/channel-testkit';
import { ReplyRouter } from '../../channel-harness/src/reply-router.ts';
import type { SessionBinding } from '../../channel-harness/src/session-router.ts';
import { Config, QQAdapter } from '../src/index.ts';
import type { HttpTransport, HttpRequestInit } from '../src/index.ts';
import type { QQConfig } from '../src/config.ts';

/** Deterministic fake transport: routes keyed by path, records calls. */
class FakeTransport implements HttpTransport {
  routes = new Map<string, (init?: HttpRequestInit, signal?: AbortSignal) => unknown>();
  calls: { path: string; init?: HttpRequestInit }[] = [];

  route(path: string, handler: (init?: HttpRequestInit, signal?: AbortSignal) => unknown): this {
    this.routes.set(path, handler);
    return this;
  }

  request(path: string, init: HttpRequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    this.calls.push({ path, init });
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }
    const handler = this.routes.get(path);
    if (!handler) return Promise.reject(new ChannelError('CHANNEL_ERROR', `no route for ${path}`));
    try {
      return Promise.resolve(handler(init, signal));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

function makeConfig(overrides: Partial<QQConfig> = {}): QQConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    baseUrl: 'http://fake',
    timeoutMs: 1000,
    longPollTimeoutMs: 1000,
    upstream: { mode: 'gateway' },
    auth: {
      statePath: undefined,
      qrPollIntervalMs: 100,
      qrExpireMs: 10000,
    },
    reconnect: {
      enabled: true,
      baseDelayMs: 1,
      maxDelayMs: 10,
      maxRetries: 0,
    },
    dedup: {
      enabled: true,
      windowMs: 5000,
    },
    ...overrides,
  });
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeAdapter(transport: FakeTransport): QQAdapter {
  return new QQAdapter(makeConfig(), { transport, now: () => Date.now() });
}

function makeBinding(): SessionBinding {
  return {
    channelId: 'qq',
    accountId: 'main',
    conversationId: 'conv_1',
    sessionId: 's1',
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeRouter(adapter: QQAdapter, binding: SessionBinding): ReplyRouter {
  return new ReplyRouter({
    config: {
      updateIntervalMs: 50,
      maxTextLength: undefined,
      splitParagraphs: true,
      splitCodeBlocks: true,
      finalFlush: true,
    },
    getAdapter: () => adapter,
    getBinding: () => binding,
    logger: silentLogger,
  });
}

function fakeSession(id: string): never {
  return { id } as never;
}

function chunkEvent(turn: number, text: string): never {
  return {
    type: 'assistant/chunk',
    seq: 1,
    time: Date.now(),
    data: { turn, step: 0, chunk: { type: 'text-delta', index: 0, text } },
  } as never;
}

function turnEndEvent(turn: number): never {
  return {
    type: 'turn/end',
    seq: 3,
    time: Date.now(),
    data: { turn, reason: { kind: 'completed' } },
  } as never;
}

describe('M3 acceptance: QQ buffered streaming through the generic ReplyRouter', () => {
  it('accumulates chunks and delivers exactly ONE /message/send with the full text at turn/end', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const transport = new FakeTransport();
    transport.route('/message/send', () => ({ id: 'out-1' }));
    const adapter = makeAdapter(transport);
    await adapter.start(ctx);

    const router = makeRouter(adapter, makeBinding());
    const session = fakeSession('s1');

    // Three chunks across a throttle window; buffered strategy must never
    // send during the turn.
    router.onSessionEvent(session, chunkEvent(0, 'Hello '));
    await sleep(20);
    router.onSessionEvent(session, chunkEvent(0, 'world, '));
    await sleep(20);
    router.onSessionEvent(session, chunkEvent(0, 'from QQ!'));

    await sleep(120);
    expect(transport.calls.filter((c) => c.path === '/message/send')).toHaveLength(0);

    // turn/end flushes the buffered reply through adapter.send → exactly one send.
    router.onSessionEvent(session, turnEndEvent(0));
    await sleep(50);

    const sends = transport.calls.filter((c) => c.path === '/message/send');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.init?.body).toEqual({
      to: 'conv_1',
      type: 'text',
      content: 'Hello world, from QQ!',
    });

    await adapter.stop();
  }, 8000);

  it('delivers a single assistant/message (no deltas) as one send at turn/end', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const transport = new FakeTransport();
    transport.route('/message/send', () => ({ id: 'out-2' }));
    const adapter = makeAdapter(transport);
    await adapter.start(ctx);

    const router = makeRouter(adapter, makeBinding());
    const session = fakeSession('s1');

    router.onSessionEvent(session, {
      type: 'assistant/message',
      seq: 2,
      time: Date.now(),
      data: {
        turn: 0,
        message: { role: 'assistant', content: [{ type: 'text', text: 'final only' }] },
      },
    } as never);
    router.onSessionEvent(session, turnEndEvent(0));
    await sleep(50);

    const sends = transport.calls.filter((c) => c.path === '/message/send');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.init?.body).toEqual({ to: 'conv_1', type: 'text', content: 'final only' });

    await adapter.stop();
  }, 8000);

  it('an empty turn performs no send', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const transport = new FakeTransport();
    transport.route('/message/send', () => ({ id: 'out-3' }));
    const adapter = makeAdapter(transport);
    await adapter.start(ctx);

    const router = makeRouter(adapter, makeBinding());
    const session = fakeSession('s1');

    // No chunks and no assistant/message — nothing to deliver.
    router.onSessionEvent(session, turnEndEvent(0));
    await sleep(50);

    expect(transport.calls.filter((c) => c.path === '/message/send')).toHaveLength(0);

    await adapter.stop();
  }, 8000);

  it('never uses createReply (buffered capability, no editable cards)', () => {
    const adapter = makeAdapter(new FakeTransport());
    expect(adapter.capabilities.streaming).toBe('buffered');
    expect(typeof (adapter as unknown as { createReply?: unknown }).createReply).toBe('undefined');
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
