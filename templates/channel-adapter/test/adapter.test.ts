import { describe, expect, it, vi } from 'vitest';
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
  ChannelNameAdapter,
  InboundProcessor,
  HttpChannelUpstream,
  mapInbound,
  toTextPayload,
  dedupKey,
  apply,
} from '../src/index.ts';
import type { HttpTransport, HttpRequestInit } from '../src/index.ts';
import type { ChannelUpstream } from '../src/index.ts';
import type { ChannelConfig } from '../src/config.ts';

/**
 * The template ships with the sample channel id `example` used by
 * `fixtures/example/`. Replace it (and the fixtures directory name) with
 * your real channel id when scaffolding.
 */
const SAMPLE_CHANNEL = 'example';

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

function makeConfig(overrides: Partial<ChannelConfig> = {}): ChannelConfig {
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
    ...overrides,
  });
}

/** Minimal upstream stub for isolated tests. */
class StubUpstream implements ChannelUpstream {
  receiveCalls = 0;

  async start() {}
  async stop() {}
  async receive() {
    this.receiveCalls += 1;
  }
  async sendText() {
    return { ok: true };
  }
  async sendMedia() {
    return { ok: true };
  }
}

describe('mapper (fixture-driven)', () => {
  it('maps inbound text fixture', async () => {
    const fixture = await loadFixture(SAMPLE_CHANNEL, 'inbound-text');
    const event = mapInbound(fixture.payload, { channel: SAMPLE_CHANNEL as never, accountId: 'main' as never });
    const expected = fixture.expected as MessageReceived;
    expect(event.conversation).toEqual(expected.conversation);
    expect(event.sender).toEqual(expected.sender);
    expect(event.message.content).toEqual(expected.message.content);
    expect(event.message.id).toBe(expected.message.id);
    expect(event.raw).toBe(fixture.payload);
  });

  it('maps inbound image fixture', async () => {
    const fixture = await loadFixture(SAMPLE_CHANNEL, 'inbound-image');
    const event = mapInbound(fixture.payload, { channel: SAMPLE_CHANNEL as never, accountId: 'main' as never });
    expect(event.message.content).toEqual((fixture.expected as MessageReceived).message.content);
  });

  it('maps unknown types to unsupported parts', async () => {
    const fixture = await loadFixture(SAMPLE_CHANNEL, 'inbound-unknown');
    const event = mapInbound(fixture.payload, { channel: SAMPLE_CHANNEL as never, accountId: 'main' as never });
    expect(event.message.content).toEqual((fixture.expected as MessageReceived).message.content);
    expect(event.message.id).toBe('msg_unk_1');
  });

  it('dedupKey is stable per msgId, falls back to eventId, then a content hash', () => {
    const raw = { type: 'text', senderId: 'u1', msgId: 'm1', content: 'x' };
    expect(dedupKey(raw)).toBe('m1');
    const noId = { type: 'text', senderId: 'u1', content: 'x' };
    expect(dedupKey(noId)).toBe(dedupKey({ ...noId }));
    const eventIdOnly = { type: 'text', senderId: 'u1', eventId: 'e9', content: 'x' };
    expect(dedupKey(eventIdOnly)).toBe('e9');
  });

  it('toTextPayload joins text and non-text placeholders', () => {
    const payload = toTextPayload(
      { conversationId: 'conv_456' },
      {
        text: 'look ',
        parts: [
          { type: 'image', alt: 'chart' },
          { type: 'audio' },
        ],
      },
    );
    expect(payload).toEqual({
      to: 'conv_456',
      type: 'text',
      content: 'look [image: chart][audio]',
    });
  });
});

describe('HttpChannelUpstream (fake transport)', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  function upstream(): HttpChannelUpstream {
    return new HttpChannelUpstream({ transport, longPollTimeoutMs: 500 });
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
    const result = await upstream().sendText('c1', 'hello');
    expect(result).toEqual({ id: 'out-1' });
    const call = transport.calls[0];
    expect(call?.path).toBe('/message/send');
    expect(call?.init?.body).toEqual({ to: 'c1', type: 'text', content: 'hello' });
  });

  it('sendMedia posts to /message/media with the media payload', async () => {
    transport.route('/message/media', (_init, _signal) => ({ id: 'out-2' }));
    const result = await upstream().sendMedia('c1', { type: 'image', url: 'https://example.com/x.png' });
    expect(result).toEqual({ id: 'out-2' });
    const call = transport.calls[0];
    expect(call?.path).toBe('/message/media');
    expect(call?.init?.body).toEqual({
      to: 'c1',
      type: 'image',
      url: 'https://example.com/x.png',
    });
  });
});

describe('InboundProcessor dedup', () => {
  it('forwards a repeated msgId only once within the window', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const processor = new InboundProcessor();
    processor.configure({
      ctx,
      meta: { channel: SAMPLE_CHANNEL as never, accountId: 'main' as never },
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
});

describe('ChannelNameAdapter lifecycle', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  function adapter(overrides: Partial<ChannelConfig> = {}): ChannelNameAdapter {
    return new ChannelNameAdapter(makeConfig(overrides), { transport, now: () => 1000 });
  }

  it('reports health and forwards inbound messages', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const a = adapter();
    await a.start(ctx);
    expect((await a.getHealth()).status).toBe('ok');

    const controller = new AbortController();
    let calls = 0;
    transport.route('/stream', (_init, signal) => {
      calls += 1;
      if (calls === 1) {
        return { type: 'text', msgId: 'm1', senderId: 'user_123', conversationId: 'conv_1', content: 'hi' };
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

    await a.stop();
    await a.stop(); // idempotent
  }, 8000);

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

  it('rejects send before start', async () => {
    const a = adapter();
    await expect(a.send(makeChannelTarget(), makeOutboundMessage())).rejects.toMatchObject({
      code: 'CHANNEL_NOT_STARTED',
    });
  });
});

describe('channel-<channel> plugin', () => {
  it('exports the cordis plugin shape', () => {
    expect(apply).toBeTypeOf('function');
  });

  it('adapter contract suite passes', () => {
    const transport = new FakeTransport();
    transport.route('/message/send', () => ({ id: 'out-x' }));
    runChannelAdapterContract(new ChannelNameAdapter(makeConfig(), { transport }));
  });
});
