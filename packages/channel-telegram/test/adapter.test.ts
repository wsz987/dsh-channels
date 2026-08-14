import { describe, expect, it, vi, beforeEach } from 'vitest';
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
  TelegramAdapter,
  InboundProcessor,
  HttpTelegramUpstream,
  FetchTransport,
  mapInbound,
  dedupKey,
  apply,
  name,
  inject,
  manifest,
} from '../src/index.ts';
import type { HttpTransport, HttpRequestInit } from '../src/index.ts';
import type { TelegramConfig } from '../src/config.ts';

/** Anonymous placeholder token — never a real credential (fixture rule). */
const TOKEN = 'TEST_BOT_TOKEN_123';
/** Bot API paths embed the token: /bot<token>/<endpoint>. */
const tgPath = (endpoint: string): string => `/bot${TOKEN}/${endpoint}`;

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

function makeConfig(overrides: Partial<TelegramConfig> = {}): TelegramConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    baseUrl: 'http://fake',
    token: undefined,
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

describe('mapper (fixture-driven)', () => {
  it('maps inbound text fixture', async () => {
    const fixture = await loadFixture('telegram', 'inbound-text');
    const event = mapInbound(fixture.payload, { channel: 'telegram' as never, accountId: 'main' as never });
    const expected = fixture.expected as MessageReceived;
    expect(event.conversation).toEqual(expected.conversation);
    expect(event.sender).toEqual(expected.sender);
    expect(event.message.content).toEqual(expected.message.content);
    expect(event.message.id).toBe(expected.message.id);
    expect(event.raw).toBe(fixture.payload);
  });

  it('maps inbound image fixture (largest photo size + caption)', async () => {
    const fixture = await loadFixture('telegram', 'inbound-image');
    const event = mapInbound(fixture.payload, { channel: 'telegram' as never, accountId: 'main' as never });
    const expected = fixture.expected as MessageReceived;
    expect(event.conversation).toEqual(expected.conversation);
    expect(event.message.content).toEqual(expected.message.content);
  });

  it('maps inbound voice fixture to an audio part and a group conversation', async () => {
    const fixture = await loadFixture('telegram', 'inbound-audio');
    const event = mapInbound(fixture.payload, { channel: 'telegram' as never, accountId: 'main' as never });
    const expected = fixture.expected as MessageReceived;
    expect(event.conversation).toEqual(expected.conversation);
    // A supergroup chat maps to a group conversation keyed by the chat id.
    expect(event.conversation.type).toBe('group');
    expect(event.conversation.id).toBe('200300400');
    expect(event.message.content).toEqual(expected.message.content);
  });

  it('maps unknown content to an unsupported part', async () => {
    const fixture = await loadFixture('telegram', 'inbound-unknown');
    const event = mapInbound(fixture.payload, { channel: 'telegram' as never, accountId: 'main' as never });
    expect(event.message.content).toEqual((fixture.expected as MessageReceived).message.content);
  });

  it('defaults chat types other than group/supergroup to a dm conversation', () => {
    const event = mapInbound(
      {
        update_id: 1,
        message: { message_id: 2, chat: { id: 7, type: 'channel' }, from: { id: 3 }, text: 'hi' },
      },
      { channel: 'telegram' as never, accountId: 'main' as never },
    );
    expect(event.conversation.type).toBe('dm');
    expect(event.conversation.id).toBe('7');
  });

  it('dedupKey is stable per update_id and falls back to message_id', () => {
    const update = { update_id: 99, message: { message_id: 5 } };
    expect(dedupKey(update)).toBe('update-99');
    expect(dedupKey({ ...update })).toBe('update-99');
    expect(dedupKey({ message: { message_id: 5 } })).toBe('message-5');
  });
});

describe('HttpTelegramUpstream (fake transport)', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  function upstream(): HttpTelegramUpstream {
    return new HttpTelegramUpstream({ transport, token: TOKEN, longPollTimeoutMs: 500 });
  }

  it('getMe resolves the bot user', async () => {
    transport.route(tgPath('getMe'), () => ({
      ok: true,
      result: { id: 1, is_bot: true, first_name: 'ProofBot', username: 'proof_bot' },
    }));
    const user = await upstream().getMe();
    expect(user.id).toBe(1);
    expect(user.username).toBe('proof_bot');
    expect(transport.calls[0]?.path).toBe(tgPath('getMe'));
  });

  it('getMe throws a channel auth error on 401', async () => {
    transport.route(tgPath('getMe'), () => ({ ok: false, error_code: 401, description: 'Unauthorized' }));
    await expect(upstream().getMe()).rejects.toMatchObject({ code: 'CHANNEL_AUTH_FAILED' });
  });

  it('getUpdates forwards updates and acks the offset on the next poll', async () => {
    const controller = new AbortController();
    let calls = 0;
    transport.route(tgPath('getUpdates'), (init) => {
      calls += 1;
      const body = init?.body as { offset?: number };
      if (calls === 1) {
        expect(body.offset).toBe(0);
        return {
          ok: true,
          result: [
            { update_id: 10, message: { message_id: 1, chat: { id: 1, type: 'private' }, from: { id: 5 }, text: 'a' } },
            { update_id: 11, message: { message_id: 2, chat: { id: 1, type: 'private' }, from: { id: 5 }, text: 'b' } },
          ],
        };
      }
      // The acknowledged offset is the highest update_id + 1.
      expect(body.offset).toBe(12);
      controller.abort();
      throw new ChannelError('CHANNEL_ERROR', 'stop loop');
    });

    const received: unknown[] = [];
    await upstream().getUpdates(0, controller.signal, (update) => received.push(update));
    expect(received).toHaveLength(2);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('getUpdates exits gracefully when the signal aborts', async () => {
    const controller = new AbortController();
    // Simulate the long-poll hang: each poll takes a few ms so the loop does
    // not microtask-spin while the test observes it.
    transport.route(tgPath('getUpdates'), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, result: [] };
    });
    const promise = upstream().getUpdates(0, controller.signal, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(promise).resolves.toBeUndefined();
  });

  it('sendMessage posts the correct path/body; the token never appears in init/body', async () => {
    transport.route(tgPath('sendMessage'), () => ({ ok: true, result: { message_id: 42 } }));
    const result = await upstream().sendText('123', 'hello');
    expect(result).toMatchObject({ ok: true });
    const call = transport.calls[0];
    expect(call?.path).toBe(tgPath('sendMessage'));
    expect(call?.init?.body).toEqual({ chat_id: '123', text: 'hello' });
    expect(JSON.stringify(call?.init)).not.toContain(TOKEN);
  });

  it('sendMedia posts to the right endpoint with the url and caption', async () => {
    transport.route(tgPath('sendPhoto'), () => ({ ok: true, result: { message_id: 7 } }));
    await upstream().sendMedia('123', { type: 'image', url: 'https://example.com/pic.png', caption: 'look' });
    const call = transport.calls[0];
    expect(call?.path).toBe(tgPath('sendPhoto'));
    expect(call?.init?.body).toEqual({
      chat_id: '123',
      photo: 'https://example.com/pic.png',
      caption: 'look',
    });
    expect(JSON.stringify(call?.init)).not.toContain(TOKEN);
  });

  it('FetchTransport redacts bearer-path credentials from error messages', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    })) as unknown as typeof fetch;
    const real = new FetchTransport('https://api.telegram.org', { timeoutMs: 1000, fetchImpl });
    let caught: unknown;
    try {
      await real.request(`/bot${TOKEN}/getMe`);
    } catch (error) {
      caught = error;
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain(TOKEN);
    expect(message).toContain('/bot<redacted>/getMe');
  });
});

describe('InboundProcessor dedup', () => {
  it('forwards a repeated update_id only once within the window', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const processor = new InboundProcessor({
      ctx,
      meta: { channel: 'telegram' as never, accountId: 'main' as never },
      dedupEnabled: true,
      dedupWindowMs: 5000,
      now: () => 1000,
    });
    const listener = vi.fn();
    service.on(listener);

    const raw = {
      update_id: 500,
      message: { message_id: 3, chat: { id: 1, type: 'private' }, from: { id: 2 }, text: 'hi' },
    };
    await processor.handle(raw);
    await processor.handle(raw);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]?.[0] as MessageReceived).message.id).toBe('3');
  });

  it('forwards distinct updates', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const processor = new InboundProcessor({
      ctx,
      meta: { channel: 'telegram' as never, accountId: 'main' as never },
      dedupEnabled: true,
      dedupWindowMs: 5000,
    });
    const listener = vi.fn();
    service.on(listener);
    await processor.handle({
      update_id: 1,
      message: { message_id: 1, chat: { id: 1, type: 'private' }, text: '1' },
    });
    await processor.handle({
      update_id: 2,
      message: { message_id: 2, chat: { id: 1, type: 'private' }, text: '2' },
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('TelegramAdapter lifecycle', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  function adapter(overrides: Partial<TelegramConfig> = {}): TelegramAdapter {
    return new TelegramAdapter(makeConfig(overrides), { transport, now: () => 1000 });
  }

  function routeAuth(): void {
    transport.route(tgPath('getMe'), () => ({
      ok: true,
      result: { id: 1, is_bot: true, first_name: 'ProofBot', username: 'proof_bot' },
    }));
  }

  it('reports down health without a token and never starts a receive loop', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const a = adapter(); // no token
    await a.start(ctx);
    const health = await a.getHealth();
    expect(health.status).toBe('down');
    expect(health.authenticated).toBe(false);
    expect(transport.calls.some((c) => c.path.endsWith('/getUpdates'))).toBe(false);
    await a.stop();
  });

  it('with a token: getMe ok → receive loop forwards a message → stop is idempotent', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    routeAuth();
    let calls = 0;
    transport.route(tgPath('getUpdates'), async () => {
      // Simulate the long-poll hang (a real getUpdates holds the connection
      // for the poll window); without it the loop would microtask-spin.
      await new Promise((resolve) => setTimeout(resolve, 5));
      calls += 1;
      if (calls === 2) {
        return {
          ok: true,
          result: [
            {
              update_id: 100,
              message: {
                message_id: 7,
                date: 1700000000,
                chat: { id: 123, type: 'private', first_name: 'Alice' },
                from: { id: 321, first_name: 'Alice' },
                text: 'hello from telegram',
              },
            },
          ],
        };
      }
      return { ok: true, result: [] };
    });

    const listener = vi.fn();
    service.on(listener);
    const a = adapter({ token: TOKEN });
    await a.start(ctx);
    expect((await a.getHealth()).status).toBe('ok');
    expect((await a.getHealth()).authenticated).toBe(true);

    // Wait for the actual message — auth/connection events also reach the
    // listener during start, so a bare call-count check is not enough.
    await vi.waitFor(() => {
      expect(
        listener.mock.calls.some(
          (call) => (call[0] as MessageReceived).type === 'message.received',
        ),
      ).toBe(true);
    }, { timeout: 2000 });
    const event = listener.mock.calls.find(
      (call) => (call[0] as MessageReceived).type === 'message.received',
    )?.[0] as MessageReceived;
    expect(event.message.id).toBe('7');
    expect(event.message.content).toEqual([{ type: 'text', text: 'hello from telegram' }]);
    expect(event.conversation).toEqual({ id: '123', type: 'dm' });
    expect(event.sender).toEqual({ id: '321', name: 'Alice' });

    // Teardown mirrors apply(): the owning fiber aborts the context signal
    // first (unwinding the long-poll), then stop() cleans up. stop() alone
    // cannot unwind a poll that is still awaiting the transport.
    await ctx.dispose();
    await a.stop();
    await a.stop(); // idempotent
  });

  it('with an invalid token: getMe fails → health down, no receive loop', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    transport.route(tgPath('getMe'), () => ({ ok: false, error_code: 401, description: 'Unauthorized' }));
    const a = adapter({ token: TOKEN });
    await a.start(ctx);
    const health = await a.getHealth();
    expect(health.status).toBe('down');
    expect(health.authenticated).toBe(false);
    expect(transport.calls.some((c) => c.path.endsWith('/getUpdates'))).toBe(false);
    await a.stop();
  });

  it('send resolves a SendResult through the driver', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    routeAuth();
    transport.route(tgPath('sendMessage'), () => ({ ok: true, result: { message_id: 9 } }));
    const a = adapter({ token: TOKEN });
    await a.start(ctx);
    const result = await a.send(makeChannelTarget(), makeOutboundMessage());
    expect(result.delivered).toBe(true);
    const call = transport.calls.find((c) => c.path === tgPath('sendMessage'));
    expect(call?.init?.body).toEqual({ chat_id: 'conv-1', text: 'hi there' });
    await a.stop();
  });

  it('send with a media part goes through sendPhoto with the text as caption', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    routeAuth();
    transport.route(tgPath('sendPhoto'), () => ({ ok: true, result: { message_id: 10 } }));
    const a = adapter({ token: TOKEN });
    await a.start(ctx);
    const result = await a.send(makeChannelTarget(), {
      text: 'caption here',
      parts: [{ type: 'image', url: 'https://example.com/pic.png' }],
    });
    expect(result.delivered).toBe(true);
    const call = transport.calls.find((c) => c.path === tgPath('sendPhoto'));
    expect(call?.init?.body).toEqual({
      chat_id: 'conv-1',
      photo: 'https://example.com/pic.png',
      caption: 'caption here',
    });
    expect(transport.calls.some((c) => c.path === tgPath('sendMessage'))).toBe(false);
    await a.stop();
  });

  it('maps a failing send to a ChannelError without leaking the token', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    routeAuth();
    transport.route(tgPath('sendMessage'), () => {
      throw new Error('upstream exploded');
    });
    const a = adapter({ token: TOKEN });
    await a.start(ctx);
    let caught: unknown;
    try {
      await a.send(makeChannelTarget(), makeOutboundMessage());
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'CHANNEL_SEND_FAILED' });
    // The token never reaches request init/body or the surfaced error.
    expect(JSON.stringify(transport.calls.map((c) => c.init))).not.toContain(TOKEN);
    expect(String((caught as Error).message)).not.toContain(TOKEN);
    await a.stop();
  });

  it('rejects send before start', async () => {
    const a = adapter({ token: TOKEN });
    await expect(a.send(makeChannelTarget(), makeOutboundMessage())).rejects.toMatchObject({
      code: 'CHANNEL_NOT_STARTED',
    });
  });
});

describe('channel-telegram plugin', () => {
  it('exports the cordis plugin shape', () => {
    expect(name).toBe('channel-telegram');
    expect(inject).toEqual(['channels']);
    expect(apply).toBeTypeOf('function');
  });

  it('exposes an upstream compatibility manifest', () => {
    expect(manifest).toMatchObject({ id: 'telegram', adapterVersion: '0.1.0', status: 'tested' });
    expect(manifest.upstream.strategy).toBe('source');
    expect(manifest.upstream.reference).toContain('core.telegram.org');
  });

  it('adapter contract suite passes', () => {
    const transport = new FakeTransport();
    transport.route(tgPath('getMe'), () => ({
      ok: true,
      result: { id: 1, is_bot: true, first_name: 'ProofBot', username: 'proof_bot' },
    }));
    transport.route(tgPath('sendMessage'), () => ({ ok: true, result: { message_id: 1 } }));
    transport.route(tgPath('sendPhoto'), () => ({ ok: true, result: { message_id: 2 } }));
    transport.route(tgPath('sendDocument'), () => ({ ok: true, result: { message_id: 3 } }));
    transport.route(tgPath('sendAudio'), () => ({ ok: true, result: { message_id: 4 } }));
    transport.route(tgPath('sendVideo'), () => ({ ok: true, result: { message_id: 5 } }));
    runChannelAdapterContract(new TelegramAdapter(makeConfig({ token: TOKEN }), { transport }));
  });
});
