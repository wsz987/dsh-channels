import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  QQAdapter,
  QQAuthManager,
  InboundProcessor,
  HttpQQUpstream,
  mapInbound,
  toTextPayload,
  dedupKey,
  apply,
} from '../src/index.ts';
import type { HttpTransport, HttpRequestInit } from '../src/index.ts';
import type { QQUpstream } from '../src/index.ts';
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
class StubUpstream implements QQUpstream {
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
  async sendMedia() {
    return { ok: true };
  }
}

describe('mapper (fixture-driven)', () => {
  it('maps inbound text fixture', async () => {
    const fixture = await loadFixture('qq', 'inbound-text');
    const event = mapInbound(fixture.payload, { channel: 'qq' as never, accountId: 'main' as never });
    const expected = fixture.expected as MessageReceived;
    expect(event.conversation).toEqual(expected.conversation);
    expect(event.sender).toEqual(expected.sender);
    expect(event.message.content).toEqual(expected.message.content);
    expect(event.message.id).toBe(expected.message.id);
    expect(event.raw).toBe(fixture.payload);
  });

  it('maps inbound image fixture', async () => {
    const fixture = await loadFixture('qq', 'inbound-image');
    const event = mapInbound(fixture.payload, { channel: 'qq' as never, accountId: 'main' as never });
    const expected = fixture.expected as MessageReceived;
    expect(event.conversation).toEqual(expected.conversation);
    expect(event.message.content).toEqual(expected.message.content);
  });

  it('maps inbound audio fixture', async () => {
    const fixture = await loadFixture('qq', 'inbound-audio');
    const event = mapInbound(fixture.payload, { channel: 'qq' as never, accountId: 'main' as never });
    expect(event.message.content).toEqual((fixture.expected as MessageReceived).message.content);
  });

  it('maps a group-chat fixture to a group conversation keyed by the group id', async () => {
    const fixture = await loadFixture('qq', 'inbound-group');
    const event = mapInbound(fixture.payload, { channel: 'qq' as never, accountId: 'main' as never });
    const expected = fixture.expected as MessageReceived;
    expect(event.conversation).toEqual(expected.conversation);
    // The group conversation carries type 'group' and the group id.
    expect(event.conversation.type).toBe('group');
    expect(event.conversation.id).toBe('group_789');
    expect(event.sender.id).toBe('user_321');
    expect(event.message.content).toEqual(expected.message.content);
    expect(event.message.id).toBe('msg_grp_1');
  });

  it('maps unknown types to unsupported parts', async () => {
    const fixture = await loadFixture('qq', 'inbound-unknown');
    const event = mapInbound(fixture.payload, { channel: 'qq' as never, accountId: 'main' as never });
    expect(event.message.content).toEqual((fixture.expected as MessageReceived).message.content);
    expect(event.message.id).toBe('msg_unk_1');
  });

  it('defaults missing conversationType to a dm conversation', () => {
    const event = mapInbound(
      { type: 'text', senderId: 'user_7', conversationId: 'conv_7', content: 'hi' },
      { channel: 'qq' as never, accountId: 'main' as never },
    );
    expect(event.conversation.type).toBe('dm');
    expect(event.conversation.id).toBe('conv_7');
  });

  it('falls back to the sender id as conversation id when conversationId is missing', () => {
    const event = mapInbound(
      { type: 'text', senderId: 'user_7', content: 'hi' },
      { channel: 'qq' as never, accountId: 'main' as never },
    );
    expect(event.conversation.id).toBe('user_7');
    expect(event.conversation.type).toBe('dm');
    expect(event.message.id).toMatch(/^qq-/);
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

describe('QQAuthManager', () => {
  let upstream: StubUpstream;
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    upstream = new StubUpstream();
    onChange = vi.fn();
  });

  function manager(statePath?: string): QQAuthManager {
    return new QQAuthManager({
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
    upstream.pollResult = { state: 'authenticated', userId: 'qqid_main' };
    const challenge = await auth.beginAuth();
    const result = await auth.pollAuth(challenge);
    expect(result.state).toBe('authenticated');
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.getState().userId).toBe('qqid_main');
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

  it('persists and restores authenticated state without credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qq-auth-'));
    try {
      const file = join(dir, 'state.json');
      const auth = manager(file);
      upstream.pollResult = { state: 'authenticated', userId: 'qqid_main' };
      const challenge = await auth.beginAuth();
      await auth.pollAuth(challenge);
      await auth.save();

      const stored = JSON.parse(await readFile(file, 'utf8'));
      // Only opaque auth state + user id; never a QR/token/credential.
      expect(stored.userId).toBe('qqid_main');
      expect(JSON.stringify(stored)).not.toMatch(/token|qr|secret/i);

      const restored = new QQAuthManager({
        upstream,
        statePath: file,
        onAuthChange: vi.fn(),
      });
      await restored.load();
      expect(restored.isAuthenticated).toBe(true);
      expect(restored.getState().userId).toBe('qqid_main');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('HttpQQUpstream (fake transport)', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  function upstream(): HttpQQUpstream {
    return new HttpQQUpstream({ transport, longPollTimeoutMs: 500 });
  }

  it('login hits /qrcode', async () => {
    transport.route('/qrcode', () => ({ qrUrl: 'q', expiresAt: 123 }));
    const result = await upstream().login();
    expect(result).toEqual({ qrUrl: 'q', expiresAt: 123 });
    expect(transport.calls[0]?.path).toBe('/qrcode');
  });

  it('pollAuth reads /auth/status', async () => {
    transport.route('/auth/status', () => ({ state: 'authenticated', userId: 'u1' }));
    const result = await upstream().pollAuth();
    expect(result).toEqual({ state: 'authenticated', userId: 'u1' });
    expect(transport.calls[0]?.path).toBe('/auth/status');
  });

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
    const processor = new InboundProcessor({
      ctx,
      meta: { channel: 'qq' as never, accountId: 'main' as never },
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
      meta: { channel: 'qq' as never, accountId: 'main' as never },
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

describe('QQAdapter lifecycle', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  function adapter(overrides: Partial<QQConfig> = {}): QQAdapter {
    return new QQAdapter(makeConfig(overrides), { transport, now: () => 1000 });
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
    transport.route('/auth/status', () => ({ state: 'authenticated', userId: 'qqid_main' }));

    const challenge = await a.beginAuth();
    const poll = await a.pollAuth(challenge);
    expect(poll.state).toBe('authenticated');
    expect((await a.getHealth()).status).toBe('ok');

    // Receive loop is live: first long-poll returns a message, then abort.
    const controller = new AbortController();
    let calls = 0;
    transport.route('/stream', (_init, signal) => {
      calls += 1;
      if (calls === 1) {
        return { type: 'text', msgId: 'm1', senderId: 'user_123', conversationId: 'conv_1', content: 'hi' };
      }
      controller.abort();
      // ctx dispose aborts the loop signal as well.
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

  it('send with a media part goes through /message/media', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const a = adapter();
    await a.start(ctx);
    transport.route('/message/media', (_init, _signal) => ({ id: 'out-m' }));
    const result = await a.send(makeChannelTarget(), {
      parts: [{ type: 'image', url: 'https://example.com/pic.png', alt: 'chart' }],
    });
    expect(result.delivered).toBe(true);
    const call = transport.calls.find((c) => c.path === '/message/media');
    expect(call?.init?.body).toMatchObject({
      type: 'image',
      url: 'https://example.com/pic.png',
    });
    expect(transport.calls.some((c) => c.path === '/message/send')).toBe(false);
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

  it('rejects beginAuth/pollAuth before start', async () => {
    const a = adapter();
    await expect(a.beginAuth()).rejects.toMatchObject({ code: 'CHANNEL_NOT_STARTED' });
    await expect(a.pollAuth({ id: 'c', instruction: 'scan' })).rejects.toMatchObject({
      code: 'CHANNEL_NOT_STARTED',
    });
  });
});

describe('channel-qq plugin', () => {
  it('exports the cordis plugin shape', () => {
    expect(apply).toBeTypeOf('function');
  });

  it('adapter contract suite passes', () => {
    const transport = new FakeTransport();
    transport.route('/message/send', () => ({ id: 'out-x' }));
    runChannelAdapterContract(new QQAdapter(makeConfig(), { transport }));
  });
});
