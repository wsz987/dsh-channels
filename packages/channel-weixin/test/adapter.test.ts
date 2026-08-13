import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, ChannelError, type MessageReceived } from '@dsh/channel-core';
import {
  runChannelAdapterContract,
  createTestContext,
  loadFixture,
  makeChannelTarget,
  makeOutboundMessage,
} from '@dsh/channel-testkit';
import {
  Config,
  WeixinAdapter,
  WeixinAuthManager,
  InboundProcessor,
  HttpWeixinUpstream,
  mapInbound,
  toTextPayload,
  dedupKey,
  apply,
} from '../src/index.ts';
import type { HttpTransport, HttpRequestInit } from '../src/index.ts';
import type { WeixinUpstream } from '../src/index.ts';
import type { WeixinConfig } from '../src/config.ts';

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

function makeConfig(overrides: Partial<WeixinConfig> = {}): WeixinConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    baseUrl: 'http://fake',
    timeoutMs: 1000,
    longPollTimeoutMs: 1000,
    auth: {
      statePath: undefined,
      qrPollIntervalMs: 100,
      qrExpireMs: 10000,
    },
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

/** Minimal upstream stub for auth-manager tests. */
class StubUpstream implements WeixinUpstream {
  loginResult = { qrUrl: 'https://qr.example/1', expiresAt: Date.now() + 60000 };
  pollResult = { state: 'pending' as const };
  pollError: Error | undefined;
  receiveCalls = 0;

  async login() {
    return this.loginResult;
  }
  async pollAuth() {
    if (this.pollError) throw this.pollError;
    return this.pollResult;
  }
  async receive() {
    this.receiveCalls += 1;
  }
  async sendText() {
    return { ok: true };
  }
}

describe('mapper (fixture-driven)', () => {
  it('maps inbound text fixture', async () => {
    const fixture = await loadFixture('weixin', 'inbound-text');
    const event = mapInbound(fixture.payload, { channel: 'weixin' as never, accountId: 'main' as never });
    const expected = fixture.expected as MessageReceived;
    expect(event.conversation).toEqual(expected.conversation);
    expect(event.sender).toEqual(expected.sender);
    expect(event.message.content).toEqual(expected.message.content);
    // The text fixture carries no msgId, so the adapter synthesizes one.
    expect(event.message.id).toMatch(/^wx-/);
    expect(event.raw).toBe(fixture.payload);
  });

  it('maps inbound image fixture', async () => {
    const fixture = await loadFixture('weixin', 'inbound-image');
    const event = mapInbound(fixture.payload, { channel: 'weixin' as never, accountId: 'main' as never });
    const expected = fixture.expected as MessageReceived;
    expect(event.conversation).toEqual(expected.conversation);
    expect(event.message.content).toEqual(expected.message.content);
  });

  it('maps inbound audio fixture', async () => {
    const fixture = await loadFixture('weixin', 'inbound-audio');
    const event = mapInbound(fixture.payload, { channel: 'weixin' as never, accountId: 'main' as never });
    expect(event.message.content).toEqual((fixture.expected as MessageReceived).message.content);
  });

  it('maps unknown types to unsupported parts', async () => {
    const fixture = await loadFixture('weixin', 'inbound-unknown');
    const event = mapInbound(fixture.payload, { channel: 'weixin' as never, accountId: 'main' as never });
    expect(event.message.content).toEqual((fixture.expected as MessageReceived).message.content);
    expect(event.message.id).toMatch(/^wx-/);
  });

  it('toTextPayload joins text and non-text placeholders', () => {
    const payload = toTextPayload(
      { conversationId: 'u1' },
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
      to: 'u1',
      type: 'text',
      content: 'look [image: chart][audio][location: 1,2]',
    });
  });

  it('dedupKey is stable per msgId and falls back to a content hash', () => {
    const raw = { type: 'text', fromUserName: 'u1', msgId: 'm1', content: 'x' };
    expect(dedupKey(raw)).toBe('m1');
    const noId = { type: 'text', fromUserName: 'u1', content: 'x' };
    expect(dedupKey(noId)).toBe(dedupKey({ ...noId }));
  });
});

describe('WeixinAuthManager', () => {
  let upstream: StubUpstream;
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    upstream = new StubUpstream();
    onChange = vi.fn();
  });

  function manager(statePath?: string): WeixinAuthManager {
    return new WeixinAuthManager({
      upstream,
      statePath,
      now: () => 1000,
      onAuthChange: onChange,
    });
  }

  it('beginAuth moves to pending and exposes a challenge', async () => {
    const auth = manager();
    const challenge = await auth.beginAuth();
    expect(challenge.qrUrl).toBe('https://qr.example/1');
    expect(auth.getState().status).toBe('pending');
    expect(onChange).toHaveBeenCalled();
  });

  it('pollAuth transitions to authenticated and records the user', async () => {
    const auth = manager();
    upstream.pollResult = { state: 'authenticated', userId: 'wxid_main' };
    const challenge = await auth.beginAuth();
    const result = await auth.pollAuth(challenge);
    expect(result.state).toBe('authenticated');
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.getState().userId).toBe('wxid_main');
  });

  it('pollAuth failure maps to failed', async () => {
    const auth = manager();
    upstream.pollError = new Error('boom');
    const challenge = await auth.beginAuth();
    const result = await auth.pollAuth(challenge);
    expect(result.state).toBe('failed');
    expect(result.detail).toBe('boom');
  });

  it('honors challenge expiry', async () => {
    const auth = manager();
    const challenge = await auth.beginAuth();
    const expired = await auth.pollAuth({ ...challenge, expiresAt: 0 });
    expect(expired.state).toBe('expired');
  });

  it('persists and restores authenticated state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wx-auth-'));
    try {
      const file = join(dir, 'state.json');
      const auth = manager(file);
      upstream.pollResult = { state: 'authenticated', userId: 'wxid_main' };
      const challenge = await auth.beginAuth();
      await auth.pollAuth(challenge);
      await auth.save();

      const restored = new WeixinAuthManager({
        upstream,
        statePath: file,
        onAuthChange: vi.fn(),
      });
      await restored.load();
      expect(restored.isAuthenticated).toBe(true);
      expect(restored.getState().userId).toBe('wxid_main');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('HttpWeixinUpstream (fake transport)', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  function upstream(): HttpWeixinUpstream {
    return new HttpWeixinUpstream({ transport, longPollTimeoutMs: 500 });
  }

  it('login hits /qrcode', async () => {
    transport.route('/qrcode', () => ({ qrUrl: 'q', expiresAt: 123 }));
    const result = await upstream().login();
    expect(result).toEqual({ qrUrl: 'q', expiresAt: 123 });
    expect(transport.calls[0]?.path).toBe('/qrcode');
  });

  it('sendText posts to /message/send with the text payload', async () => {
    transport.route('/message/send', (_init, _signal) => ({ id: 'out-1' }));
    const result = await upstream().sendText('u1', 'hello');
    expect(result).toEqual({ id: 'out-1' });
    const call = transport.calls[0];
    expect(call?.path).toBe('/message/send');
    expect(call?.init?.body).toEqual({ to: 'u1', type: 'text', content: 'hello' });
  });

  it('receive loops, forwards messages, and exits on abort', async () => {
    const controller = new AbortController();
    let calls = 0;
    transport.route('/messages/long-poll', (_init, signal) => {
      calls += 1;
      if (calls === 1) {
        return { msgId: 'm1', fromUserName: 'u1', type: 'text', content: 'hi' };
      }
      controller.abort();
      throw new ChannelError('CHANNEL_ERROR', 'abort loop');
    });

    const received: unknown[] = [];
    await upstream().receive(controller.signal, (raw) => received.push(raw));
    expect(received).toEqual([{ msgId: 'm1', fromUserName: 'u1', type: 'text', content: 'hi' }]);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe('InboundProcessor dedup', () => {
  it('forwards a repeated msgId only once within the window', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const processor = new InboundProcessor({
      ctx,
      meta: { channel: 'weixin' as never, accountId: 'main' as never },
      dedupEnabled: true,
      dedupWindowMs: 5000,
      now: () => 1000,
    });
    const listener = vi.fn();
    service.on(listener);

    const raw = { type: 'text', fromUserName: 'u1', msgId: 'dup-1', content: 'hi' };
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
      meta: { channel: 'weixin' as never, accountId: 'main' as never },
      dedupEnabled: true,
      dedupWindowMs: 5000,
    });
    const listener = vi.fn();
    service.on(listener);
    await processor.handle({ type: 'text', fromUserName: 'u1', msgId: 'a', content: '1' });
    await processor.handle({ type: 'text', fromUserName: 'u1', msgId: 'b', content: '2' });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('WeixinAdapter lifecycle', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  function adapter(overrides: Partial<WeixinConfig> = {}): WeixinAdapter {
    return new WeixinAdapter(makeConfig(overrides), { transport, now: () => 1000 });
  }

  it('reports down health until authenticated', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const a = adapter();
    await a.start(ctx);
    const health = await a.getHealth();
    expect(health.status).toBe('down');
    expect(health.authenticated).toBe(false);
    await a.stop();
  });

  it('drives auth → connection → receive and forwards inbound messages', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const a = adapter();
    await a.start(ctx);

    transport.route('/qrcode', () => ({ qrUrl: 'q', expiresAt: Date.now() + 60000 }));
    transport.route('/auth/status', () => ({ state: 'authenticated', userId: 'wxid_main' }));

    const challenge = await a.beginAuth();
    const poll = await a.pollAuth(challenge);
    expect(poll.state).toBe('authenticated');
    expect((await a.getHealth()).status).toBe('ok');

    // Receive loop is live: first long-poll returns a message, then abort.
    const controller = new AbortController();
    let calls = 0;
    transport.route('/messages/long-poll', (_init, signal) => {
      calls += 1;
      if (calls === 1) {
        return { msgId: 'm1', fromUserName: 'user_123', type: 'text', content: 'hi' };
      }
      controller.abort();
      // ctx dispose aborts the loop signal as well.
      void ctx.dispose();
      throw new ChannelError('CHANNEL_ERROR', 'stop loop');
    });

    const listener = vi.fn();
    service.on(listener);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await vi.waitFor(() => {
      expect(listener.mock.calls.length).toBeGreaterThan(0);
    }, { timeout: 2000 });
    const event = listener.mock.calls.find(
      (call) => (call[0] as MessageReceived).type === 'message.received',
    )?.[0] as MessageReceived;
    expect(event.message.id).toBe('m1');
    expect(event.message.content).toEqual([{ type: 'text', text: 'hi' }]);

    // Loop exits on abort without hanging.
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

describe('channel-weixin plugin', () => {
  it('exports the cordis plugin shape', () => {
    expect(apply).toBeTypeOf('function');
  });

  it('adapter contract suite passes', () => {
    const transport = new FakeTransport();
    transport.route('/message/send', () => ({ id: 'out-x' }));
    runChannelAdapterContract(new WeixinAdapter(makeConfig(), { transport }));
  });
});
