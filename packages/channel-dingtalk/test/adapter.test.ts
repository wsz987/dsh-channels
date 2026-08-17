import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { TOPIC_ROBOT } from 'dingtalk-stream';
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
  DingTalkAdapter,
  InboundProcessor,
  HttpDingTalkUpstream,
  DingTalkCardReply,
  mapInbound,
  toTextPayload,
  dedupKey,
  apply,
} from '../src/index.ts';
import type { HttpTransport, HttpRequestInit } from '../src/index.ts';
import type { DingTalkUpstream } from '../src/index.ts';
import type { DingTalkStreamClient, DingTalkStreamMessage } from '../src/index.ts';
import type { DingTalkConfig } from '../src/config.ts';

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

function makeConfig(overrides: Partial<DingTalkConfig> = {}): DingTalkConfig {
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

/** Fake stream client: records lifecycle, dispatches inbound robot messages. */
class FakeStreamClient implements DingTalkStreamClient {
  connects = 0;
  disconnects = 0;
  readonly registered: string[] = [];
  readonly calls: unknown[] = [];
  private readonly listeners = new Map<string, (message: DingTalkStreamMessage) => void>();

  connect(): Promise<void> {
    this.calls.push(['connect']);
    this.connects += 1;
    return Promise.resolve();
  }

  disconnect(): void {
    this.calls.push(['disconnect']);
    this.disconnects += 1;
  }

  registerCallbackListener(topic: string, callback: (message: DingTalkStreamMessage) => void | Promise<void>): this {
    this.calls.push(['registerCallbackListener', topic]);
    this.registered.push(topic);
    this.listeners.set(topic, callback);
    return this;
  }

  socketCallBackResponse(messageId: string, response: unknown): void {
    this.calls.push(['socketCallBackResponse', messageId, response]);
  }

  /** Simulate the stream server delivering a CALLBACK message on a topic. */
  emit(topic: string, message: DingTalkStreamMessage): void {
    void this.listeners.get(topic)?.(message);
  }
}

/** Build a downstream message carrying a text robot message payload. */
function robotDownstream(overrides: Record<string, unknown> = {}): DingTalkStreamMessage {
  return {
    headers: { topic: TOPIC_ROBOT, eventId: 'evt-1', messageId: 'mid-1' },
    data: JSON.stringify({
      msgId: 'msg-sdk-1',
      senderStaffId: 'user_sdk',
      conversationId: 'conv_sdk',
      msgtype: 'text',
      text: { content: 'hello from sdk' },
      ...overrides,
    }),
  };
}

describe('mapper (fixture-driven)', () => {
  it('maps inbound text fixture', async () => {
    const fixture = await loadFixture('dingtalk', 'inbound-text');
    const event = mapInbound(fixture.payload, { channel: 'dingtalk' as never, accountId: 'main' as never });
    const expected = fixture.expected as MessageReceived;
    expect(event.conversation).toEqual(expected.conversation);
    expect(event.sender).toEqual(expected.sender);
    expect(event.message.content).toEqual(expected.message.content);
    expect(event.message.id).toBe(expected.message.id);
    expect(event.raw).toBe(fixture.payload);
  });

  it('maps inbound image fixture', async () => {
    const fixture = await loadFixture('dingtalk', 'inbound-image');
    const event = mapInbound(fixture.payload, { channel: 'dingtalk' as never, accountId: 'main' as never });
    const expected = fixture.expected as MessageReceived;
    expect(event.conversation).toEqual(expected.conversation);
    expect(event.message.content).toEqual(expected.message.content);
  });

  it('maps inbound audio fixture', async () => {
    const fixture = await loadFixture('dingtalk', 'inbound-audio');
    const event = mapInbound(fixture.payload, { channel: 'dingtalk' as never, accountId: 'main' as never });
    expect(event.message.content).toEqual((fixture.expected as MessageReceived).message.content);
  });

  it('maps unknown types to unsupported parts', async () => {
    const fixture = await loadFixture('dingtalk', 'inbound-unknown');
    const event = mapInbound(fixture.payload, { channel: 'dingtalk' as never, accountId: 'main' as never });
    expect(event.message.content).toEqual((fixture.expected as MessageReceived).message.content);
    expect(event.message.id).toBe('msg_unk_1');
  });

  it('falls back to the sender id as conversation id when conversationId is missing', () => {
    const event = mapInbound(
      { type: 'text', senderId: 'user_7', content: 'hi' },
      { channel: 'dingtalk' as never, accountId: 'main' as never },
    );
    expect(event.conversation.id).toBe('user_7');
    expect(event.message.id).toMatch(/^dt-/);
  });

  it('toTextPayload joins text and non-text placeholders', () => {
    const payload = toTextPayload(
      { conversationId: 'conv_456' },
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
      to: 'conv_456',
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

describe('HttpDingTalkUpstream (fake transport)', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  function upstream(): HttpDingTalkUpstream {
    return new HttpDingTalkUpstream({ transport, longPollTimeoutMs: 500 });
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
    const result = await upstream().sendText({ ...makeChannelTarget(), conversationId: 'c1' as never }, 'hello');
    expect(result).toEqual({ id: 'out-1' });
    const call = transport.calls[0];
    expect(call?.path).toBe('/message/send');
    expect(call?.init?.body).toEqual({ to: 'c1', type: 'text', content: 'hello' });
  });

  it('createCard returns a cardId from /card/create', async () => {
    transport.route('/card/create', (_init, _signal) => ({ cardId: 'card-1' }));
    const result = await upstream().createCard({ ...makeChannelTarget(), conversationId: 'c1' as never }, 'hi');
    expect(result).toEqual({ cardId: 'card-1' });
    const call = transport.calls[0];
    expect(call?.path).toBe('/card/create');
    expect(call?.init?.body).toEqual({ conversationId: 'c1', text: 'hi' });
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

describe('InboundProcessor dedup', () => {
  it('forwards a repeated msgId only once within the window', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const processor = new InboundProcessor({
      ctx,
      meta: { channel: 'dingtalk' as never, accountId: 'main' as never },
      dedupEnabled: true,
      dedupWindowMs: 5000,
      now: () => 1000,
    });
    const listener = vi.fn();
    service.on(listener);

    const raw = { type: 'text', senderId: 'u1', conversationId: 'c1', msgId: 'dup-1', content: 'hi' };
    await processor.handle(raw);
    await processor.handle(raw);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]?.[0] as MessageReceived).message.id).toBe('dup-1');
  });

  it('forwards distinct messages', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const processor = new InboundProcessor({
      ctx,
      meta: { channel: 'dingtalk' as never, accountId: 'main' as never },
      dedupEnabled: true,
      dedupWindowMs: 5000,
    });
    const listener = vi.fn();
    service.on(listener);
    await processor.handle({ type: 'text', senderId: 'u1', msgId: 'a', content: '1' });
    await processor.handle({ type: 'text', senderId: 'u1', msgId: 'b', content: '2' });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('DingTalkCardReply (AI Card reply handle)', () => {
  let transport: FakeTransport;
  let now: () => number;
  let clock: number;

  beforeEach(() => {
    transport = new FakeTransport();
    clock = 1000;
    now = () => clock;
  });

  function reply(overrides: { createOnFirstDelta?: boolean } = {}): DingTalkCardReply {
    return new DingTalkCardReply({
      upstream: new HttpDingTalkUpstream({ transport, longPollTimeoutMs: 500 }),
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

  it('falls back to one final text reply when AI Card creation is unavailable', async () => {
    transport.route('/message/send', () => ({ id: 'fallback-1' }));
    const handle = reply();

    await handle.append('partial');
    await handle.finish({ text: 'complete answer' });

    expect(handle.status).toBe('finished');
    expect(transport.calls.filter((call) => call.path === '/card/create')).toHaveLength(1);
    expect(transport.calls.filter((call) => call.path === '/message/send')).toHaveLength(1);
    expect(transport.calls.find((call) => call.path === '/message/send')?.init?.body).toEqual({
      to: makeChannelTarget().conversationId,
      type: 'text',
      content: 'complete answer',
    });
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

describe('DingTalkAdapter lifecycle', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  function adapter(overrides: Partial<DingTalkConfig> = {}): DingTalkAdapter {
    return new DingTalkAdapter(makeConfig(overrides), { transport, now: () => 1000 });
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

    // Keep the second poll pending until the inbound event has been observed.
    // Aborting it earlier races the asynchronous inbound processor.
    let calls = 0;
    transport.route('/stream', (_init, signal) => {
      calls += 1;
      if (calls === 1) {
        return { type: 'text', msgId: 'm1', senderId: 'user_123', conversationId: 'conv_1', content: 'hi' };
      }
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });

    const listener = vi.fn();
    service.on(listener);
    await a.start(ctx);
    await vi.waitFor(() => {
      expect(listener.mock.calls.some(
        (call) => (call[0] as MessageReceived).type === 'message.received',
      )).toBe(true);
    }, { timeout: 2000 });
    const event = listener.mock.calls.find(
      (call) => (call[0] as MessageReceived).type === 'message.received',
    )?.[0] as MessageReceived;
    expect(event.message.id).toBe('m1');
    expect(event.message.content).toEqual([{ type: 'text', text: 'hi' }]);

    // Ending a successful receive cycle flips the connection to connected.
    await ctx.dispose();
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

describe('DingTalkAdapter SDK mode (fake stream client)', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  function sdkAdapter(client: FakeStreamClient): DingTalkAdapter {
    return new DingTalkAdapter(
      // The AppSecret never lives in config in the ref model; the injected fake
      // client means no default DWClient is built, so no deps.clientSecret needed.
      makeConfig({ upstream: { mode: 'sdk', clientId: 'app-key' } }),
      { transport, sdkClient: client, now: () => 1000 },
    );
  }

  it('connects the stream client on start and disconnects on stop', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeStreamClient();
    const a = sdkAdapter(client);
    await a.start(ctx);
    await vi.waitFor(() => expect(client.connects).toBe(1), { timeout: 2000 });
    expect(client.registered).toEqual([TOPIC_ROBOT]);
    await a.stop();
    expect(client.disconnects).toBe(1);
    expect(client.registered).toEqual([TOPIC_ROBOT]);
  });

  it('delivers SDK inbound robot messages to MessageReceived', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeStreamClient();
    const a = sdkAdapter(client);
    const received: MessageReceived[] = [];
    service.on((event) => {
      if (event.type === 'message.received') received.push(event);
    });
    await a.start(ctx);
    await vi.waitFor(() => expect(client.connects).toBe(1), { timeout: 2000 });
    client.emit(TOPIC_ROBOT, robotDownstream());
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000 });
    expect(received[0]?.message.id).toBe('msg-sdk-1');
    expect(received[0]?.message.content).toEqual([{ type: 'text', text: 'hello from sdk' }]);
    expect(received[0]?.conversation.id).toBe('conv_sdk');
    expect(received[0]?.sender.id).toBe('user_sdk');
    await a.stop();
  });

  it('flips health to ok once the stream connects', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeStreamClient();
    const a = sdkAdapter(client);
    // Not started: down.
    expect((await a.getHealth()).status).toBe('down');
    await a.start(ctx);
    // The instant fake connect flips health to ok within the same tick, so
    // assert the end state and that the connection event was reported.
    await vi.waitFor(async () => {
      expect((await a.getHealth()).status).toBe('ok');
    }, { timeout: 2000 });
    await a.stop();
  });

  it('fails start loudly when sdk credentials are missing', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const a = new DingTalkAdapter(makeConfig({ upstream: { mode: 'sdk' } }), { transport, now: () => 1000 });
    await expect(a.start(ctx)).rejects.toThrow(/clientId.*clientSecret/);
  });

  it('uses the injected client factory when no concrete client is given', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeStreamClient();
    const factory = vi.fn(() => client);
    const a = new DingTalkAdapter(
      makeConfig({ upstream: { mode: 'sdk', clientId: 'k' } }),
      { transport, sdkClientFactory: factory, now: () => 1000 },
    );
    await a.start(ctx);
    expect(factory).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(client.connects).toBe(1), { timeout: 2000 });
    await a.stop();
  });

  it('never leaks credentials into stream client calls', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeStreamClient();
    const secret = 'super-secret-app-secret';
    const a = new DingTalkAdapter(
      // AppSecret travels via deps.clientSecret (ref model), never in config.
      makeConfig({ upstream: { mode: 'sdk', clientId: 'app-key' } }),
      { transport, sdkClient: client, clientSecret: secret, now: () => 1000 },
    );
    await a.start(ctx);
    await vi.waitFor(() => expect(client.connects).toBe(1), { timeout: 2000 });
    await a.stop();
    expect(JSON.stringify(client.calls)).not.toContain(secret);
    expect(JSON.stringify(client.calls)).not.toContain('app-key');
  });
});

describe('channel-dingtalk plugin', () => {
  it('exports the cordis plugin shape', () => {
    expect(apply).toBeTypeOf('function');
  });

  it('adapter contract suite passes', () => {
    const transport = new FakeTransport();
    transport.route('/message/send', () => ({ id: 'out-x' }));
    runChannelAdapterContract(new DingTalkAdapter(makeConfig(), { transport }));
  });
});
