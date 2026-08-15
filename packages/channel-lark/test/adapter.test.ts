/**
 * M3 adapter tests: fixture-driven mapper (incl. thread isolation fixture),
 * dedup, upstream over a fake transport, the editable-card reply handle, the
 * adapter lifecycle (connection/auth/health/send/error mapping), the plugin
 * shape, and the generic channel adapter contract suite.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, ChannelError, type MessageReceived } from '@wsz987/channel-core';
import {
  runChannelAdapterContract,
  createTestContext,
  loadFixture,
  makeChannelTarget,
  makeOutboundMessage,
} from '@wsz987/channel-testkit';
import {
  Config,
  LarkAdapter,
  InboundProcessor,
  HttpLarkUpstream,
  LarkCardReply,
  mapInbound,
  mapInteraction,
  toTextPayload,
  dedupKey,
  MESSAGE_EVENT_KEY,
  apply,
} from '../src/index.ts';
import type { HttpTransport, HttpRequestInit } from '../src/index.ts';
import type { LarkUpstream } from '../src/index.ts';
import type {
  LarkSdkClient,
  LarkSdkDispatcher,
  LarkMessageEventData,
} from '../src/index.ts';
import type { LarkOpenApiClient } from '../src/index.ts';
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
    reconnect: {
      enabled: false, // tests must not spin backoff retries
      baseDelayMs: 1,
      maxDelayMs: 10,
      maxRetries: 2,
    },
    dedup: {
      enabled: true,
      windowMs: 5000,
    },
    card: {
      createOnFirstDelta: true,
    },
    // These tests exercise the legacy HTTP gateway driver over the fake
    // transport; SDK-mode tests override this to 'sdk' with a fake client.
    upstream: {
      mode: 'gateway',
    },
    ...overrides,
  });
}

/**
 * Fake WS long-connection client for SDK mode: records lifecycle, captures
 * the dispatcher handed to start(), and can simulate the WS server delivering
 * v1 event envelopes (through the real SDK EventDispatcher — pure logic).
 */
class FakeWsClient implements LarkSdkClient {
  starts = 0;
  closes = 0;
  readonly calls: unknown[] = [];
  failStart?: Error;
  dispatcher?: LarkSdkDispatcher;

  async start(params: { eventDispatcher: LarkSdkDispatcher }): Promise<void> {
    this.calls.push(['start']);
    this.dispatcher = params.eventDispatcher;
    if (this.failStart) {
      const error = this.failStart;
      this.failStart = undefined;
      return Promise.reject(error);
    }
    this.starts += 1;
  }

  close(params?: { force?: boolean }): void {
    this.calls.push(['close', params ?? {}]);
    this.closes += 1;
  }

  /** Simulate the WS server delivering one v1 event envelope. */
  async emit(payload: unknown): Promise<unknown> {
    if (!this.dispatcher) throw new Error('client not started');
    return this.dispatcher.invoke(payload, { needCheck: false });
  }
}

/**
 * Fake official OpenAPI client for SDK-mode outbound (R7B): records calls,
 * returns deterministic message/image ids, and can be made to fail `create`.
 */
class FakeOpenApiClient implements LarkOpenApiClient {
  calls: { method: string; payload?: unknown }[] = [];
  createError?: Error;
  createResult: { code?: number; data?: { message_id?: string } } = {
    code: 0,
    data: { message_id: 'om_out_1' },
  };

  im = {
    v1: {
      message: {
        create: async (payload: unknown) => {
          this.calls.push({ method: 'message.create', payload });
          if (this.createError) throw this.createError;
          return this.createResult;
        },
        patch: async (payload: unknown) => {
          this.calls.push({ method: 'message.patch', payload });
          return { code: 0 };
        },
      },
      image: {
        create: async (payload: unknown) => {
          this.calls.push({ method: 'image.create', payload });
          return { image_key: 'img_v2_out' };
        },
      },
    },
  };
}

/** Build a flat parsed v1 payload (header + event merged, per the SDK). */
function flatEvent(overrides: Record<string, unknown> = {}): LarkMessageEventData {
  return {
    event_id: 'evt-1',
    event_type: MESSAGE_EVENT_KEY,
    token: 'tok-1',
    create_time: '1700000000000',
    sender: {
      sender_id: { open_id: 'ou_sdk_user', union_id: 'on_1', user_id: 'u_1' },
      sender_type: 'user',
    },
    message: {
      message_id: 'om_sdk_1',
      chat_id: 'oc_sdk_conv',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello from sdk' }),
      create_time: '1700000000000',
    },
    ...overrides,
  } as LarkMessageEventData;
}

/** Wrap a flat payload in the v1 envelope shape the WS delivers. */
function v1Event(data: LarkMessageEventData = flatEvent()): Record<string, unknown> {
  const { event_id, token, create_time, event_type, ...rest } = data;
  return {
    schema: '2.0',
    header: { event_id, event_type: event_type ?? MESSAGE_EVENT_KEY, token, create_time },
    event: rest,
  };
}

const meta = { channel: 'lark' as never, accountId: 'main' as never };

describe('mapper (fixture-driven)', () => {
  it('maps inbound text fixture', async () => {
    const fixture = await loadFixture('lark', 'inbound-text');
    const event = mapInbound(fixture.payload, meta);
    const expected = fixture.expected as MessageReceived;
    expect(event.conversation).toEqual(expected.conversation);
    expect(event.sender).toEqual(expected.sender);
    expect(event.message.content).toEqual(expected.message.content);
    expect(event.message.id).toBe(expected.message.id);
    expect(event.raw).toBe(fixture.payload);
  });

  it('maps inbound image fixture', async () => {
    const fixture = await loadFixture('lark', 'inbound-image');
    const event = mapInbound(fixture.payload, meta);
    const expected = fixture.expected as MessageReceived;
    expect(event.conversation).toEqual(expected.conversation);
    expect(event.message.content).toEqual(expected.message.content);
  });

  it('maps inbound audio fixture', async () => {
    const fixture = await loadFixture('lark', 'inbound-audio');
    const event = mapInbound(fixture.payload, meta);
    expect(event.message.content).toEqual((fixture.expected as MessageReceived).message.content);
  });

  it('maps unknown types to unsupported parts', async () => {
    const fixture = await loadFixture('lark', 'inbound-unknown');
    const event = mapInbound(fixture.payload, meta);
    expect(event.message.content).toEqual((fixture.expected as MessageReceived).message.content);
    expect(event.message.id).toBe('msg_unk_1');
  });

  it('maps a thread payload and preserves conversation.threadId (Task 12.2)', async () => {
    const fixture = await loadFixture('lark', 'inbound-thread');
    const event = mapInbound(fixture.payload, meta);
    const expected = fixture.expected as MessageReceived;
    expect(event.conversation.threadId).toBe('om_789');
    expect(event.conversation).toEqual(expected.conversation);
    // Threads exist: the session key resolves to the thread-scoped binding.
    const key = `${event.channel}:${event.accountId}:${event.conversation.id}:${event.conversation.threadId}`;
    expect(key).toBe('lark:main:oc_456:om_789');
  });

  it('drops threadId from the conversation when the payload has none', () => {
    const event = mapInbound(
      { type: 'text', msgId: 'm1', senderId: 'ou_1', conversationId: 'oc_2', content: 'hi' },
      meta,
    );
    expect(event.conversation.threadId).toBeUndefined();
  });

  it('falls back to the sender id as conversation id when conversationId is missing', () => {
    const event = mapInbound(
      { type: 'text', senderId: 'ou_7', content: 'hi' },
      meta,
    );
    expect(event.conversation.id).toBe('ou_7');
    expect(event.message.id).toMatch(/^lk-/);
  });

  it('maps an interaction callback to interaction.received (Task 12.3)', async () => {
    const fixture = await loadFixture('lark', 'interaction');
    const event = mapInteraction(fixture.payload, meta);
    const expected = fixture.expected;
    expect(event.type).toBe('interaction.received');
    expect(event.interactionId).toBe(expected.interactionId);
    expect(event.action).toBe(expected.action);
    expect(event.value).toBe(expected.value);
    expect(event.conversation).toEqual(expected.conversation);
    expect(event.raw).toBe(fixture.payload);
  });

  it('toTextPayload joins text and non-text placeholders', () => {
    const payload = toTextPayload(
      { conversationId: 'oc_456' },
      {
        text: 'look ',
        parts: [
          { type: 'image', alt: 'chart' },
          { type: 'audio' },
          { type: 'location', latitude: 1, longitude: 2 },
        ],
      },
    );
    expect(payload).toEqual({
      to: 'oc_456',
      type: 'text',
      content: 'look [image: chart][audio][location: 1,2]',
    });
  });

  it('dedupKey is stable per msgId, falls back to eventId, then a content hash', () => {
    const raw = { type: 'text', senderId: 'u1', msgId: 'm1', content: 'x' };
    expect(dedupKey(raw)).toBe('m1');
    const noId = { type: 'text', senderId: 'u1', content: 'x' };
    expect(dedupKey(noId)).toBe(dedupKey({ ...noId }));
    const eventIdOnly = { type: 'text', senderId: 'u1', eventId: 'e9', content: 'x' };
    expect(dedupKey(eventIdOnly)).toBe('e9');
  });
});

describe('HttpLarkUpstream (fake transport)', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  function upstream(): HttpLarkUpstream {
    return new HttpLarkUpstream({ transport, longPollTimeoutMs: 500 });
  }

  it('receive loops, forwards messages, and exits on abort', async () => {
    const controller = new AbortController();
    let calls = 0;
    transport.route('/stream', (_init, signal) => {
      calls += 1;
      if (calls === 1) {
        return { type: 'text', msgId: 'm1', senderId: 'u1', conversationId: 'c1', content: 'hi' };
      }
      controller.abort();
      throw new ChannelError('CHANNEL_ERROR', 'abort loop');
    });

    const received: unknown[] = [];
    await upstream().receive(controller.signal, (raw) => received.push(raw));
    expect(received).toEqual([
      { type: 'text', msgId: 'm1', senderId: 'u1', conversationId: 'c1', content: 'hi' },
    ]);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('sendText posts to /message/send with the text payload', async () => {
    transport.route('/message/send', (_init, _signal) => ({ id: 'out-1' }));
    const result = await upstream().sendText('oc_1', 'hello');
    expect(result).toEqual({ id: 'out-1' });
    const call = transport.calls[0];
    expect(call?.path).toBe('/message/send');
    expect(call?.init?.body).toEqual({ to: 'oc_1', type: 'text', content: 'hello' });
  });

  it('sendMedia posts an image payload to /message/send', async () => {
    transport.route('/message/send', (_init, _signal) => ({ id: 'out-2' }));
    await upstream().sendMedia('oc_1', { type: 'image', url: 'https://x/p.png', name: 'pic' });
    const call = transport.calls[0];
    expect(call?.path).toBe('/message/send');
    expect(call?.init?.body).toEqual({ to: 'oc_1', type: 'image', url: 'https://x/p.png', name: 'pic' });
  });

  it('createCard returns a cardId from /card/create', async () => {
    transport.route('/card/create', (_init, _signal) => ({ cardId: 'card-1' }));
    const result = await upstream().createCard('oc_1', 'hi');
    expect(result).toEqual({ cardId: 'card-1' });
    const call = transport.calls[0];
    expect(call?.path).toBe('/card/create');
    expect(call?.init?.body).toEqual({ conversationId: 'oc_1', text: 'hi' });
  });

  it('update/finish/fail card hit their endpoints', async () => {
    transport.route('/card/update', () => ({ ok: true }));
    transport.route('/card/finish', () => ({ ok: true }));
    transport.route('/card/fail', () => ({ ok: true }));
    const up = upstream();
    await up.updateCard('card-1', 'new text');
    await up.finishCard('card-1');
    await up.failCard('card-1', 'boom');
    expect(transport.calls.map((c) => c.path)).toEqual([
      '/card/update',
      '/card/finish',
      '/card/fail',
    ]);
    expect(transport.calls[0]?.init?.body).toEqual({ cardId: 'card-1', text: 'new text' });
    expect(transport.calls[1]?.init?.body).toEqual({ cardId: 'card-1' });
    expect(transport.calls[2]?.init?.body).toEqual({ cardId: 'card-1', reason: 'boom' });
  });
});

describe('InboundProcessor dedup + interaction routing', () => {
  function makeProcessor(opts: { dedupEnabled?: boolean } = {}) {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const processor = new InboundProcessor({
      ctx,
      meta,
      dedupEnabled: opts.dedupEnabled ?? true,
      dedupWindowMs: 5000,
      now: () => 1000,
    });
    return { service, ctx, processor };
  }

  it('forwards a repeated msgId only once within the window', async () => {
    const { service, processor } = makeProcessor();
    const listener = vi.fn();
    service.on(listener);

    const raw = { type: 'text', senderId: 'ou_1', conversationId: 'oc_1', msgId: 'dup-1', content: 'hi' };
    await processor.handle(raw);
    await processor.handle(raw);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]?.[0] as MessageReceived).message.id).toBe('dup-1');
  });

  it('forwards distinct messages', async () => {
    const { service, processor } = makeProcessor();
    const listener = vi.fn();
    service.on(listener);
    await processor.handle({ type: 'text', senderId: 'ou_1', msgId: 'a', content: '1' });
    await processor.handle({ type: 'text', senderId: 'ou_1', msgId: 'b', content: '2' });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('routes interaction payloads to interaction.received', async () => {
    const { service, processor } = makeProcessor();
    const listener = vi.fn();
    service.on(listener);

    const raw = {
      type: 'interaction',
      eventId: 'evt-1',
      senderId: 'ou_1',
      conversationId: 'oc_1',
      interactionId: 'card_1',
      action: 'button_click',
      value: 'approve',
    };
    await processor.handle(raw);
    const event = listener.mock.calls[0]?.[0] as { type: string; interactionId: string; action: string };
    expect(event.type).toBe('interaction.received');
    expect(event.interactionId).toBe('card_1');
    expect(event.action).toBe('button_click');
  });
});

describe('LarkCardReply (editable card reply handle)', () => {
  let transport: FakeTransport;
  let now: () => number;
  let clock: number;

  beforeEach(() => {
    transport = new FakeTransport();
    clock = 1000;
    now = () => clock;
  });

  function reply(overrides: { createOnFirstDelta?: boolean } = {}): LarkCardReply {
    return new LarkCardReply({
      upstream: new HttpLarkUpstream({ transport, longPollTimeoutMs: 500 }),
      target: makeChannelTarget(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      createOnFirstDelta: overrides.createOnFirstDelta ?? true,
      now,
    });
  }

  it('append creates the card and updates it, then finish finalizes', async () => {
    transport.route('/card/create', () => ({ cardId: 'card-1' }));
    transport.route('/card/update', () => ({ ok: true }));
    transport.route('/card/finish', () => ({ ok: true }));
    transport.route('/card/fail', () => ({ ok: true }));

    const handle = reply();
    await handle.append('hello');
    await handle.append(' world');
    expect(handle.status).toBe('active');
    expect(handle.cardId).toBe('card-1');
    expect(handle.text).toBe('hello world');

    await handle.finish();
    expect(handle.status).toBe('finished');
    expect(handle.updates.map((u) => u.kind)).toEqual(['created', 'update', 'update', 'finished']);
    expect(transport.calls.some((c) => c.path === '/card/create')).toBe(true);
    expect(transport.calls.some((c) => c.path === '/card/finish')).toBe(true);
    // No plain message fallback for the streamed reply.
    expect(transport.calls.some((c) => c.path === '/message/send')).toBe(false);
  });

  it('guards no-op updates: replace with unchanged text skips the network', async () => {
    transport.route('/card/create', () => ({ cardId: 'card-1' }));
    transport.route('/card/update', () => ({ ok: true }));
    transport.route('/card/finish', () => ({ ok: true }));

    const handle = reply();
    await handle.replace({ text: 'hello' });
    await handle.replace({ text: 'hello' });
    expect(handle.text).toBe('hello');
    const updates = transport.calls.filter((c) => c.path === '/card/update');
    expect(updates).toHaveLength(1);
  });

  it('append with an empty delta performs no update', async () => {
    transport.route('/card/create', () => ({ cardId: 'card-1' }));
    transport.route('/card/update', () => ({ ok: true }));
    transport.route('/card/finish', () => ({ ok: true }));

    const handle = reply();
    await handle.append('');
    await handle.append('');
    expect(transport.calls.filter((c) => c.path === '/card/update')).toHaveLength(0);
  });

  it('finish without streamed chunks falls back to creating the card once', async () => {
    transport.route('/card/create', () => ({ cardId: 'card-2' }));
    transport.route('/card/finish', () => ({ ok: true }));
    transport.route('/card/update', () => ({ ok: true }));

    const handle = reply();
    await handle.finish({ text: 'final text' });
    expect(handle.status).toBe('finished');
    expect(handle.text).toBe('final text');
    const creates = transport.calls.filter((c) => c.path === '/card/create');
    expect(creates).toHaveLength(1);
    expect(transport.calls.some((c) => c.path === '/card/finish')).toBe(true);
    // No /message/send fallback — the card path is used.
    expect(transport.calls.some((c) => c.path === '/message/send')).toBe(false);
  });

  it('fail marks the card failed and records the error', async () => {
    transport.route('/card/create', () => ({ cardId: 'card-1' }));
    transport.route('/card/update', () => ({ ok: true }));
    transport.route('/card/fail', () => ({ ok: true }));

    const handle = reply();
    await handle.append('partial');
    const error = new Error('boom');
    await handle.fail(error);
    expect(handle.status).toBe('failed');
    expect(handle.error).toBe(error);
    expect(handle.updates.at(-1)?.kind).toBe('failed');
    expect(transport.calls.some((c) => c.path === '/card/fail')).toBe(true);
  });

  it('fail without a created card still records the failed state', async () => {
    const handle = reply();
    await handle.fail(new Error('early'));
    expect(handle.status).toBe('failed');
    expect(handle.updates).toEqual([
      { kind: 'failed', text: '', at: 1000, error: undefined },
    ]);
  });

  it('createOnFirstDelta: false buffers deltas and creates the card at finish', async () => {
    transport.route('/card/create', () => ({ cardId: 'card-3' }));
    transport.route('/card/update', () => ({ ok: true }));
    transport.route('/card/finish', () => ({ ok: true }));

    const handle = reply({ createOnFirstDelta: false });
    await handle.append('hello');
    expect(handle.status).toBe('idle');
    expect(handle.cardId).toBeUndefined();
    expect(transport.calls.some((c) => c.path === '/card/create')).toBe(false);

    await handle.finish();
    expect(handle.status).toBe('finished');
    expect(handle.cardId).toBe('card-3');
    const creates = transport.calls.filter((c) => c.path === '/card/create');
    expect(creates).toHaveLength(1);
  });

  it('finish is idempotent and no-ops after completion', async () => {
    transport.route('/card/create', () => ({ cardId: 'card-1' }));
    transport.route('/card/update', () => ({ ok: true }));
    transport.route('/card/finish', () => ({ ok: true }));

    const handle = reply();
    await handle.append('x');
    await handle.finish();
    await handle.finish();
    await handle.append('ignored');
    expect(handle.status).toBe('finished');
    expect(handle.text).toBe('x');
    expect(transport.calls.filter((c) => c.path === '/card/finish')).toHaveLength(1);
  });
});

describe('LarkAdapter lifecycle', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  function adapter(overrides: Partial<LarkConfig> = {}): LarkAdapter {
    return new LarkAdapter(makeConfig(overrides), { transport, now: () => 1000 });
  }

  it('reports down health until the receive loop connects', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const a = adapter();
    await a.start(ctx);
    const health = await a.getHealth();
    expect(health.status).toBe('degraded');
    expect(health.authenticated).toBe(false);
    await a.stop();
  });

  it('drives connection → receive and forwards inbound messages', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const a = adapter();
    const connectionStates: string[] = [];
    service.on((event) => {
      if (event.type === 'connection.changed') connectionStates.push(event.state);
    });
    await a.start(ctx);

    // First long-poll returns a message, then the loop is aborted by the test.
    const controller = new AbortController();
    let calls = 0;
    transport.route('/stream', (_init, signal) => {
      calls += 1;
      if (calls === 1) {
        return { type: 'text', msgId: 'm1', senderId: 'ou_123', conversationId: 'oc_1', content: 'hi' };
      }
      controller.abort();
      void ctx.dispose();
      throw new ChannelError('CHANNEL_ERROR', 'stop loop');
    });

    const listener = vi.fn();
    service.on(listener);
    await vi.waitFor(() => {
      expect(listener.mock.calls.length).toBeGreaterThan(0);
    }, { timeout: 2000 });
    const event = listener.mock.calls.find(
      (call) => (call[0] as MessageReceived).type === 'message.received',
    )?.[0] as MessageReceived;
    expect(event.message.id).toBe('m1');
    expect(event.message.content).toEqual([{ type: 'text', text: 'hi' }]);

    // The successful long-poll flipped the connection to connected (the loop
    // then exits on the aborted signal, so assert the emitted event).
    await vi.waitFor(() => {
      expect(connectionStates).toContain('connected');
    }, { timeout: 2000 });

    await a.stop();
    await a.stop(); // idempotent
  }, 8000);

  it('emits connection.changed and auth.changed events', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const a = adapter();
    const states: string[] = [];
    service.on((event) => {
      if (event.type === 'connection.changed' || event.type === 'auth.changed') {
        states.push(`${event.type}:${event.state}`);
      }
    });
    await a.start(ctx);
    await vi.waitFor(() => {
      expect(states).toContain('connection.changed:connecting');
    }, { timeout: 2000 });
    await a.stop();
    expect(states).toContain('connection.changed:closed');
  });

  it('send resolves a SendResult through the driver', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const a = adapter();
    await a.start(ctx);
    transport.route('/message/send', (_init, _signal) => ({ id: 'out-9' }));
    const result = await a.send(makeChannelTarget(), makeOutboundMessage());
    expect(result.delivered).toBe(true);
    const call = transport.calls.find((c) => c.path === '/message/send');
    expect(call?.init?.body).toMatchObject({ type: 'text', content: 'hi there' });
    await a.stop();
  });

  it('sendMedia path: a pure image message routes to /message/send as image', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const a = adapter();
    await a.start(ctx);
    transport.route('/message/send', (_init, _signal) => ({ id: 'out-img' }));
    const result = await a.send(makeChannelTarget(), {
      parts: [{ type: 'image', url: 'https://x/p.png', alt: 'pic' }],
    });
    expect(result.delivered).toBe(true);
    const call = transport.calls.find((c) => c.path === '/message/send');
    expect(call?.init?.body).toMatchObject({ type: 'image', url: 'https://x/p.png', name: 'pic' });
    await a.stop();
  });

  it('createReply returns a working card handle', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const a = adapter();
    await a.start(ctx);
    transport.route('/card/create', () => ({ cardId: 'card-x' }));
    transport.route('/card/update', () => ({ ok: true }));
    transport.route('/card/finish', () => ({ ok: true }));
    const handle = await a.createReply(makeChannelTarget());
    await handle.append('hi');
    await handle.finish();
    expect(handle.status).toBe('finished');
    await a.stop();
  });

  it('maps a failing send to a ChannelError', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const a = adapter();
    await a.start(ctx);
    transport.route('/message/send', () => {
      throw new Error('gateway down');
    });
    await expect(a.send(makeChannelTarget(), makeOutboundMessage())).rejects.toMatchObject({
      code: 'CHANNEL_SEND_FAILED',
    });
    await a.stop();
  });

  it('rejects send before start', async () => {
    const a = adapter();
    await expect(a.send(makeChannelTarget(), makeOutboundMessage())).rejects.toMatchObject({
      code: 'CHANNEL_NOT_STARTED',
    });
  });
});

describe('LarkAdapter SDK mode (fake WS client)', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  function sdkAdapter(client: FakeWsClient, openApiClient: FakeOpenApiClient = new FakeOpenApiClient()): LarkAdapter {
    return new LarkAdapter(
      makeConfig({ upstream: { mode: 'sdk' } }),
      { transport, sdkClient: client, openApiClient, now: () => 1000 },
    );
  }

  it('connects the SDK client on start and disconnects on stop', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeWsClient();
    const a = sdkAdapter(client);
    await a.start(ctx);
    await vi.waitFor(() => expect(client.starts).toBe(1), { timeout: 2000 });
    await a.stop();
    expect(client.closes).toBe(1);
    expect(JSON.stringify(client.calls)).toContain('start');
  });

  it('delivers SDK inbound message events to MessageReceived', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeWsClient();
    const a = sdkAdapter(client);
    const received: MessageReceived[] = [];
    service.on((event) => {
      if (event.type === 'message.received') received.push(event as MessageReceived);
    });
    await a.start(ctx);
    await vi.waitFor(() => expect(client.starts).toBe(1), { timeout: 2000 });
    await client.emit(v1Event());
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000 });
    expect(received[0]?.message.id).toBe('om_sdk_1');
    expect(received[0]?.message.content).toEqual([{ type: 'text', text: 'hello from sdk' }]);
    expect(received[0]?.conversation.id).toBe('oc_sdk_conv');
    expect(received[0]?.conversation.type).toBe('group');
    expect(received[0]?.sender.id).toBe('ou_sdk_user');
    await a.stop();
  });

  it('preserves a thread reply (parent_id → conversation.threadId) end to end', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeWsClient();
    const a = sdkAdapter(client);
    const received: MessageReceived[] = [];
    service.on((event) => {
      if (event.type === 'message.received') received.push(event as MessageReceived);
    });
    await a.start(ctx);
    await vi.waitFor(() => expect(client.starts).toBe(1), { timeout: 2000 });
    await client.emit(
      v1Event(
        flatEvent({
          message: {
            message_id: 'om_reply_sdk',
            chat_id: 'oc_sdk_conv',
            chat_type: 'group',
            message_type: 'text',
            content: JSON.stringify({ text: 'thread reply' }),
            parent_id: 'om_thread_root',
            create_time: '1700000000000',
          },
        }),
      ),
    );
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000 });
    expect(received[0]?.conversation.id).toBe('oc_sdk_conv');
    expect(received[0]?.conversation.threadId).toBe('om_thread_root');
    await a.stop();
  });

  it('flips health to ok once the WS connects', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeWsClient();
    const a = sdkAdapter(client);
    // Not started: down.
    expect((await a.getHealth()).status).toBe('down');
    await a.start(ctx);
    // The instant fake connect flips health to ok within the same tick.
    await vi.waitFor(async () => {
      expect((await a.getHealth()).status).toBe('ok');
    }, { timeout: 2000 });
    expect((await a.getHealth()).authenticated).toBe(true);
    await a.stop();
  });

  it('fails start loudly when sdk credentials are missing', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const a = new LarkAdapter(makeConfig({ upstream: { mode: 'sdk' } }), { transport, now: () => 1000 });
    await expect(a.start(ctx)).rejects.toThrow(/appId.*appSecret/);
  });

  it('uses the injected client factory when no concrete client is given', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeWsClient();
    const factory = vi.fn(() => client);
    const a = new LarkAdapter(
      makeConfig({ upstream: { mode: 'sdk' } }),
      { transport, sdkClientFactory: factory, openApiClient: new FakeOpenApiClient(), now: () => 1000 },
    );
    await a.start(ctx);
    expect(factory).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(client.starts).toBe(1), { timeout: 2000 });
    await a.stop();
  });

  it('routes SDK-mode outbound through the OpenAPI client, not the gateway transport', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeWsClient();
    const openApiClient = new FakeOpenApiClient();
    const a = sdkAdapter(client, openApiClient);
    await a.start(ctx);
    await vi.waitFor(() => expect(client.starts).toBe(1), { timeout: 2000 });

    const result = await a.send(makeChannelTarget(), makeOutboundMessage());
    expect(result.delivered).toBe(true);
    expect(openApiClient.calls.some((call) => call.method === 'message.create')).toBe(true);
    // R7B acceptance: SDK mode performs no gateway HTTP calls.
    expect(transport.calls).toHaveLength(0);
    await a.stop();
  });

  it('never leaks credentials into WS client or OpenAPI client calls', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeWsClient();
    const openApiClient = new FakeOpenApiClient();
    const secret = 'super-secret-app-secret';
    const a = new LarkAdapter(
      makeConfig({ upstream: { mode: 'sdk' } }),
      { transport, sdkClient: client, openApiClient, appId: 'cli_appid', appSecret: secret, now: () => 1000 },
    );
    await a.start(ctx);
    await vi.waitFor(() => expect(client.starts).toBe(1), { timeout: 2000 });

    // Outbound errors must not echo credentials either.
    openApiClient.createError = new Error('outbound exploded');
    await expect(a.send(makeChannelTarget(), makeOutboundMessage())).rejects.toThrow('outbound exploded');

    await a.stop();
    expect(JSON.stringify(client.calls)).not.toContain(secret);
    expect(JSON.stringify(client.calls)).not.toContain('cli_appid');
    expect(JSON.stringify(openApiClient.calls)).not.toContain(secret);
    expect(JSON.stringify(openApiClient.calls)).not.toContain('cli_appid');
  });
});

describe('channel-lark plugin', () => {
  it('exports the cordis plugin shape', () => {
    expect(apply).toBeTypeOf('function');
  });

  it('adapter contract suite passes', () => {
    const transport = new FakeTransport();
    transport.route('/message/send', () => ({ id: 'out-x' }));
    runChannelAdapterContract(new LarkAdapter(makeConfig(), { transport }));
  });
});
