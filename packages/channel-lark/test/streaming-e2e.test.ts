/**
 * M3 acceptance: Lark editable-card streaming driven by the generic ReplyRouter.
 *
 * Wires a real `LarkAdapter` (over a FakeTransport), a real `ReplyRouter`
 * imported from channel-harness source, and a SessionBinding, then drives
 * `assistant/chunk`, `assistant/message` and `turn/end` records through it.
 * All assertions run on the generic pipeline with capability negotiation
 * only (`streaming: 'edit'`) — the harness module is never special-cased and
 * the channel id `'lark'` appears only as binding data.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, ChannelError, type MessageReceived } from '@dsh/channel-core';
import { createTestContext } from '@dsh/channel-testkit';
import { ReplyRouter } from '../../channel-harness/src/reply-router.ts';
import type { SessionBinding } from '../../channel-harness/src/session-router.ts';
import {
  Config,
  LarkAdapter,
  type LarkCardReply,
} from '../src/index.ts';
import type { HttpTransport, HttpRequestInit } from '../src/index.ts';
import type { LarkConfig } from '../src/config.ts';

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

function makeConfig(overrides: Partial<LarkConfig> = {}): LarkConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    baseUrl: 'http://fake',
    timeoutMs: 1000,
    longPollTimeoutMs: 1000,
    // The receive loop must exit fast in router-driven tests: an unregistered
    // /stream route fails immediately and maxRetries 0 ends the loop.
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
    card: {
      createOnFirstDelta: true,
    },
    // The e2e suite drives the HTTP gateway driver over the fake transport.
    upstream: {
      mode: 'gateway',
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

function makeAdapter(transport: FakeTransport): LarkAdapter {
  return new LarkAdapter(makeConfig(), { transport, now: () => Date.now() });
}

function makeBinding(): SessionBinding {
  return {
    channelId: 'lark',
    accountId: 'main',
    conversationId: 'oc_1',
    sessionId: 's1',
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeRouter(
  adapter: LarkAdapter,
  binding: SessionBinding,
  updateIntervalMs: number,
): ReplyRouter {
  return new ReplyRouter({
    config: {
      updateIntervalMs,
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

/** Capture the card handle created inside the router via createReply. */
function captureHandle(
  adapter: LarkAdapter,
): { handle: () => LarkCardReply | undefined } {
  const captured = { handle: undefined as LarkCardReply | undefined };
  const createReply = adapter.createReply.bind(adapter);
  vi.spyOn(adapter, 'createReply').mockImplementation(async (target, options) => {
    const handle = await createReply(target, options);
    captured.handle = handle;
    return handle;
  });
  return captured;
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

function assistantMessageEvent(turn: number, text: string): never {
  return {
    type: 'assistant/message',
    seq: 2,
    time: Date.now(),
    data: { turn, message: { role: 'assistant', content: [{ type: 'text', text }] } },
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

describe('M3 acceptance: editable-card streaming through the generic ReplyRouter', () => {
  it('throttles card updates below chunk count and finalizes with full text (throttle/finalize)', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const transport = new FakeTransport();
    transport.route('/card/create', () => ({ cardId: 'card-t' }));
    transport.route('/card/update', () => ({ ok: true }));
    transport.route('/card/finish', () => ({ ok: true }));
    const adapter = makeAdapter(transport);
    await adapter.start(ctx);

    const captured = captureHandle(adapter);
    const binding = makeBinding();
    // Chunks arrive every 8ms while the throttle window is 50ms, so the router
    // coalesces bursts and flushes only on interval boundaries.
    const router = makeRouter(adapter, binding, 50);
    const session = fakeSession('s1');

    const chunkCount = 20;
    for (let i = 0; i < chunkCount; i += 1) {
      router.onSessionEvent(session, chunkEvent(0, 'a'));
      await sleep(8);
    }

    // Acceptance (a): the throttled router made strictly fewer card update
    // calls than chunks (multiple flushed previews, not one per delta).
    await vi.waitFor(() => {
      const updates = transport.calls.filter((c) => c.path === '/card/update');
      expect(updates.length).toBeGreaterThan(1);
    }, { timeout: 3000 });
    // Wait for the final throttle flush so the handle holds the whole stream.
    await vi.waitFor(() => {
      expect(captured.handle?.text).toBe('a'.repeat(chunkCount));
    }, { timeout: 3000 });

    const updateCount = transport.calls.filter((c) => c.path === '/card/update').length;
    expect(updateCount).toBeGreaterThan(0);
    expect(updateCount).toBeLessThan(chunkCount);
    expect(captured.handle?.status).toBe('active');

    // Acceptance (b): turn/end finalizes the card via /card/finish.
    router.onSessionEvent(session, turnEndEvent(0));
    await vi.waitFor(() => {
      expect(captured.handle?.status).toBe('finished');
      expect(transport.calls.some((c) => c.path === '/card/finish')).toBe(true);
    }, { timeout: 3000 });
    expect(captured.handle?.text).toBe('a'.repeat(chunkCount));

    // The streamed reply used createReply (edit), never send.
    expect(transport.calls.some((c) => c.path === '/message/send')).toBe(false);
    expect(transport.calls.some((c) => c.path === '/card/create')).toBe(true);

    await adapter.stop();
  }, 8000);

  it('delivers via the card path even when only an assistant/message (no deltas) flows', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const transport = new FakeTransport();
    transport.route('/card/create', () => ({ cardId: 'card-m' }));
    transport.route('/card/update', () => ({ ok: true }));
    transport.route('/card/finish', () => ({ ok: true }));
    const adapter = makeAdapter(transport);
    await adapter.start(ctx);

    const captured = captureHandle(adapter);
    const router = makeRouter(adapter, makeBinding(), 0);
    const session = fakeSession('s1');

    router.onSessionEvent(session, assistantMessageEvent(0, 'final only'));
    router.onSessionEvent(session, turnEndEvent(0));

    await vi.waitFor(() => {
      expect(captured.handle?.status).toBe('finished');
      expect(transport.calls.some((c) => c.path === '/card/create')).toBe(true);
      expect(transport.calls.some((c) => c.path === '/card/finish')).toBe(true);
    }, { timeout: 3000 });
    expect(captured.handle?.text).toBe('final only');
    expect(transport.calls.some((c) => c.path === '/message/send')).toBe(false);

    await adapter.stop();
  }, 8000);

  it('marks the card failed when a mid-stream card update throws (failure)', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const transport = new FakeTransport();
    transport.route('/card/create', () => ({ cardId: 'card-f' }));
    let updateCalls = 0;
    transport.route('/card/update', () => {
      updateCalls += 1;
      if (updateCalls >= 2) throw new Error('card update exploded');
      return { ok: true };
    });
    transport.route('/card/fail', () => ({ ok: true }));
    const adapter = makeAdapter(transport);
    await adapter.start(ctx);

    const captured = captureHandle(adapter);
    const router = makeRouter(adapter, makeBinding(), 20);
    const session = fakeSession('s1');

    // Chunk 'a' flushes immediately (update #1 succeeds); after 30ms (> the
    // 20ms interval) chunk 'b' triggers a second flush whose update throws.
    router.onSessionEvent(session, chunkEvent(0, 'a'));
    await sleep(30);
    router.onSessionEvent(session, chunkEvent(0, 'b'));

    // Acceptance (c): the router calls handle.fail -> card enters 'failed'.
    await vi.waitFor(() => {
      expect(captured.handle).toBeDefined();
      expect(captured.handle?.status).toBe('failed');
      expect(transport.calls.some((c) => c.path === '/card/fail')).toBe(true);
    }, { timeout: 3000 });
    expect(captured.handle?.error).toBeInstanceOf(Error);
    expect((captured.handle?.error as Error).message).toContain('card update exploded');

    // A later turn/end must not finalize a failed card.
    router.onSessionEvent(session, turnEndEvent(0));
    await vi.waitFor(() => {
      expect(transport.calls.filter((c) => c.path === '/card/finish')).toHaveLength(0);
    }, { timeout: 1000 });
    expect(captured.handle?.status).toBe('failed');

    await adapter.stop();
  }, 8000);

  it('deduplicates identical inbound payloads before forwarding (dedup)', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const transport = new FakeTransport();
    // Two long-polls deliver the same raw payload (webhook retry), then the
    // test aborts the loop. The route must be registered before start: the
    // receive loop begins polling immediately.
    const controller = new AbortController();
    let calls = 0;
    const dupRaw = {
      type: 'text',
      msgId: 'dup-m1',
      senderId: 'ou_1',
      conversationId: 'oc_1',
      content: 'hello',
    };
    transport.route('/stream', (_init, signal) => {
      calls += 1;
      if (calls <= 2) return dupRaw;
      controller.abort();
      void ctx.dispose();
      throw new ChannelError('CHANNEL_ERROR', 'stop loop');
    });

    const adapter = makeAdapter(transport);
    // The adapter also emits connection/auth events; only count inbound user
    // messages for the dedup assertion. Listen before start: the receive loop
    // fires synchronously on the fake transport.
    const received: MessageReceived[] = [];
    service.on((event) => {
      if (event.type === 'message.received') received.push(event);
    });
    await adapter.start(ctx);

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    }, { timeout: 2000 });
    // Let the second identical payload flow through the loop as well.
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Acceptance (d): identical payload handled twice -> forwarded once.
    expect(received).toHaveLength(1);
    expect(received[0]?.message.id).toBe('dup-m1');
    expect(received[0]?.conversation.id).toBe('oc_1');

    await adapter.stop();
  }, 8000);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
