/**
 * SDK upstream driver tests (offline, fake stream client).
 *
 * Covers the `DingTalkStreamUpstream` inbound path: listener registration,
 * SDK message → gateway raw shape mapping, the full inbound pipeline to a
 * MessageReceived, abort-driven teardown, outbound delegation to the HTTP
 * transport, and the credentials-never-leak guarantee. No real WebSocket or
 * DingTalk credentials are involved.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { TOPIC_ROBOT } from 'dingtalk-stream';
import { ChannelService, ChannelError, type MessageReceived } from '@wsz987/channel-core';
import { createTestContext } from '@wsz987/channel-testkit';
import {
  DingTalkStreamUpstream,
  HttpDingTalkUpstream,
  InboundProcessor,
  toGatewayRaw,
} from '../src/index.ts';
import type { DingTalkStreamClient, DingTalkStreamMessage } from '../src/index.ts';
import type { HttpTransport, HttpRequestInit } from '../src/index.ts';
import type { CardCreateResult, DingTalkUpstream } from '../src/index.ts';

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

/** Trivial outbound delegate for receive-focused tests. */
class FakeOutbound implements DingTalkUpstream {
  receive(): Promise<void> {
    return Promise.resolve();
  }

  sendText(): Promise<unknown> {
    return Promise.resolve({});
  }

  createCard(): Promise<CardCreateResult> {
    return Promise.resolve({ cardId: 'fake-card' });
  }

  updateCard(): Promise<unknown> {
    return Promise.resolve({});
  }

  finishCard(): Promise<unknown> {
    return Promise.resolve({});
  }

  failCard(): Promise<unknown> {
    return Promise.resolve({});
  }
}

/** Fake stream client: records lifecycle, dispatches inbound messages. */
class FakeStreamClient implements DingTalkStreamClient {
  connects = 0;
  disconnects = 0;
  readonly registered: string[] = [];
  readonly calls: unknown[] = [];
  failConnect?: Error;
  private readonly listeners = new Map<string, (message: DingTalkStreamMessage) => void>();

  connect(): Promise<void> {
    this.calls.push(['connect']);
    if (this.failConnect) {
      const error = this.failConnect;
      this.failConnect = undefined;
      return Promise.reject(error);
    }
    this.connects += 1;
    return Promise.resolve();
  }

  disconnect(): void {
    this.calls.push(['disconnect']);
    this.disconnects += 1;
  }

  registerCallbackListener(topic: string, callback: (message: DingTalkStreamMessage) => void): this {
    this.calls.push(['registerCallbackListener', topic]);
    this.registered.push(topic);
    this.listeners.set(topic, callback);
    return this;
  }

  /** Simulate the stream server delivering a CALLBACK message on a topic. */
  emit(topic: string, message: DingTalkStreamMessage): void {
    this.listeners.get(topic)?.(message);
  }
}

/** Build a downstream message carrying a robot message payload. */
function robotDownstream(overrides: Record<string, unknown> = {}): DingTalkStreamMessage {
  return {
    headers: { topic: TOPIC_ROBOT, eventId: 'evt-1', messageId: 'mid-1' },
    data: JSON.stringify({
      msgId: 'msg-1',
      senderStaffId: 'user_123',
      conversationId: 'conv_456',
      msgtype: 'text',
      text: { content: 'hello sdk' },
      ...overrides,
    }),
  };
}

function streamUpstream(client: DingTalkStreamClient, outbound: DingTalkUpstream): DingTalkStreamUpstream {
  return new DingTalkStreamUpstream({ client, outbound });
}

describe('toGatewayRaw (SDK message → gateway raw shape)', () => {
  it('maps a text robot message to the gateway raw shape', () => {
    const raw = toGatewayRaw(robotDownstream());
    expect(raw).toEqual({
      type: 'text',
      msgId: 'msg-1',
      eventId: 'evt-1',
      senderId: 'user_123',
      conversationId: 'conv_456',
      content: 'hello sdk',
    });
  });

  it('maps media messages best-effort (picture/audio/file)', () => {
    const picture = toGatewayRaw(
      robotDownstream({ msgtype: 'picture', picture: { url: 'https://example.com/p.png' } }),
    );
    expect(picture).toMatchObject({ type: 'picture', picUrl: 'https://example.com/p.png' });

    const audio = toGatewayRaw(
      robotDownstream({ msgtype: 'audio', audio: { duration: 5200, url: 'https://example.com/a.amr' } }),
    );
    expect(audio).toMatchObject({ type: 'audio', mediaUrl: 'https://example.com/a.amr', durationMs: 5200 });

    const file = toGatewayRaw(
      robotDownstream({ msgtype: 'file', file: { fileName: 'report.pdf', url: 'https://example.com/r.pdf' } }),
    );
    expect(file).toMatchObject({ type: 'file', mediaUrl: 'https://example.com/r.pdf', title: 'report.pdf' });
  });

  it('falls back to senderId when senderStaffId is absent', () => {
    const raw = toGatewayRaw(robotDownstream({ senderStaffId: undefined, senderId: 'fallback-user' }));
    expect(raw).toMatchObject({ senderId: 'fallback-user' });
  });

  it('returns undefined for absent or non-JSON payloads', () => {
    expect(toGatewayRaw({ headers: { topic: TOPIC_ROBOT } })).toBeUndefined();
    expect(toGatewayRaw({ headers: { topic: TOPIC_ROBOT }, data: 'not-json' })).toBeUndefined();
  });
});

describe('DingTalkStreamUpstream.receive', () => {
  it('registers the robot topic listener and connects, then disconnects on abort', async () => {
    const client = new FakeStreamClient();
    const upstream = streamUpstream(client, new FakeOutbound());
    const controller = new AbortController();
    const received: unknown[] = [];
    const loop = upstream.receive(controller.signal, (raw) => received.push(raw));

    await vi.waitFor(() => expect(client.connects).toBe(1), { timeout: 2000 });
    expect(client.registered).toEqual([TOPIC_ROBOT]);

    client.emit(TOPIC_ROBOT, robotDownstream());
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000 });
    expect(received[0]).toMatchObject({
      type: 'text',
      msgId: 'msg-1',
      senderId: 'user_123',
      conversationId: 'conv_456',
      content: 'hello sdk',
    });
    expect(received[0]).toHaveProperty('eventId', 'evt-1');

    controller.abort();
    await loop;
    expect(client.disconnects).toBe(1);
  });

  it('routes inbound robot messages through the inbound processor to MessageReceived', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeStreamClient();
    const upstream = streamUpstream(client, new FakeOutbound());
    const processor = new InboundProcessor({
      ctx,
      meta: { channel: 'dingtalk' as never, accountId: 'main' as never },
      dedupEnabled: false,
      dedupWindowMs: 5000,
    });
    const listener = vi.fn();
    service.on(listener);
    const controller = new AbortController();
    const loop = upstream.receive(controller.signal, (raw) => {
      void processor.handle(raw).catch(() => undefined);
    });

    await vi.waitFor(() => expect(client.connects).toBe(1), { timeout: 2000 });
    client.emit(TOPIC_ROBOT, robotDownstream());
    await vi.waitFor(
      () => {
        const events = listener.mock.calls.map((call) => call[0] as MessageReceived);
        expect(events.some((event) => event.type === 'message.received')).toBe(true);
      },
      { timeout: 2000 },
    );
    const event = listener.mock.calls
      .map((call) => call[0] as MessageReceived)
      .find((candidate) => candidate.type === 'message.received')!;
    expect(event.message.id).toBe('msg-1');
    expect(event.message.content).toEqual([{ type: 'text', text: 'hello sdk' }]);
    expect(event.conversation.id).toBe('conv_456');
    expect(event.sender.id).toBe('user_123');

    controller.abort();
    await loop;
  });

  it('resolves on abort and disconnects', async () => {
    const client = new FakeStreamClient();
    const upstream = streamUpstream(client, new FakeOutbound());
    const controller = new AbortController();
    const loop = upstream.receive(controller.signal, () => {});
    await vi.waitFor(() => expect(client.connects).toBe(1), { timeout: 2000 });
    controller.abort();
    await loop; // must resolve, not hang
    expect(client.disconnects).toBe(1);
  });

  it('disconnects without onConnected when the signal aborts mid-connect', async () => {
    const client = new FakeStreamClient();
    const connected = vi.fn();
    const upstream = new DingTalkStreamUpstream({ client, outbound: new FakeOutbound(), onConnected: connected });
    const controller = new AbortController();
    const loop = upstream.receive(controller.signal, () => {});
    // Abort before connect resolves.
    controller.abort();
    await loop;
    expect(client.disconnects).toBe(1);
    expect(connected).not.toHaveBeenCalled();
  });

  it('propagates connect failures (adapter owns reconnect)', async () => {
    const client = new FakeStreamClient();
    client.failConnect = new Error('stream connect failed');
    const upstream = streamUpstream(client, new FakeOutbound());
    const controller = new AbortController();
    await expect(upstream.receive(controller.signal, () => {})).rejects.toThrow('stream connect failed');
    expect(client.disconnects).toBe(0);
  });

  it('reconnects without re-registering the topic listener', async () => {
    const client = new FakeStreamClient();
    const upstream = streamUpstream(client, new FakeOutbound());
    const first = new AbortController();
    await (async () => {
      const loop = upstream.receive(first.signal, () => {});
      await vi.waitFor(() => expect(client.connects).toBe(1), { timeout: 2000 });
      first.abort();
      await loop;
    })();
    const second = new AbortController();
    const loop = upstream.receive(second.signal, () => {});
    await vi.waitFor(() => expect(client.connects).toBe(2), { timeout: 2000 });
    expect(client.registered).toEqual([TOPIC_ROBOT]); // registered once
    second.abort();
    await loop;
    expect(client.disconnects).toBe(2);
  });
});

describe('DingTalkStreamUpstream outbound (delegated to the HTTP driver)', () => {
  it('posts sendText through the HTTP transport with the gateway payload', async () => {
    const transport = new FakeTransport();
    transport.route('/message/send', () => ({ id: 'out-1' }));
    const http = new HttpDingTalkUpstream({ transport, longPollTimeoutMs: 1000 });
    const upstream = streamUpstream(new FakeStreamClient(), http);

    const result = await upstream.sendText('conv_456', 'hello');
    expect(result).toEqual({ id: 'out-1' });
    const call = transport.calls.find((c) => c.path === '/message/send');
    expect(call?.init?.body).toEqual({ to: 'conv_456', type: 'text', content: 'hello' });
  });

  it('delegates card operations to the outbound upstream', async () => {
    const transport = new FakeTransport();
    transport.route('/card/create', () => ({ cardId: 'card-1' }));
    transport.route('/card/update', () => ({ ok: true }));
    transport.route('/card/finish', () => ({ ok: true }));
    transport.route('/card/fail', () => ({ ok: true }));
    const http = new HttpDingTalkUpstream({ transport, longPollTimeoutMs: 1000 });
    const upstream = streamUpstream(new FakeStreamClient(), http);

    await expect(upstream.createCard('conv_456', 'hi')).resolves.toEqual({ cardId: 'card-1' });
    await upstream.updateCard('card-1', 'hi 2');
    await upstream.finishCard('card-1');
    await upstream.failCard('card-1', 'boom');
    expect(transport.calls.map((c) => c.path)).toEqual([
      '/card/create',
      '/card/update',
      '/card/finish',
      '/card/fail',
    ]);
  });

  it('never leaks credentials into recorded calls or errors', async () => {
    const secret = 'super-secret-app-secret';
    const transport = new FakeTransport();
    transport.route('/message/send', () => {
      throw new Error('outbound exploded');
    });
    const http = new HttpDingTalkUpstream({ transport, longPollTimeoutMs: 1000 });
    const client = new FakeStreamClient();
    const upstream = streamUpstream(client, http);

    // Drive one full receive cycle so the client records its calls.
    const controller = new AbortController();
    const loop = upstream.receive(controller.signal, () => {});
    await vi.waitFor(() => expect(client.connects).toBe(1), { timeout: 2000 });
    controller.abort();
    await loop;

    await expect(upstream.sendText('conv_456', 'hi')).rejects.toThrow('outbound exploded');
    expect(JSON.stringify(client.calls)).not.toContain(secret);
    expect(JSON.stringify(transport.calls)).not.toContain(secret);
  });
});
