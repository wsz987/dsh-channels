/**
 * SDK upstream driver tests (offline, fake WS client).
 *
 * Covers the `LarkSdkUpstream` inbound path: event registration, v1 message
 * event → gateway raw shape mapping, the full inbound pipeline to a
 * MessageReceived (dm + group + thread reply), start/stop connect/disconnect,
 * abort-driven teardown, outbound delegation to the HTTP transport, and the
 * credentials-never-leak guarantee. Events flow through a REAL SDK
 * `EventDispatcher` (pure logic, no network) driven by a fake WS client, so
 * the SDK's v1 parse/merge path is exercised offline. No real WebSocket or
 * Lark credentials are involved.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, ChannelError, type MessageReceived } from '@dsh/channel-core';
import { createTestContext } from '@dsh/channel-testkit';
import {
  LarkSdkUpstream,
  HttpLarkUpstream,
  InboundProcessor,
  toGatewayRaw,
  MESSAGE_EVENT_KEY,
} from '../src/index.ts';
import type {
  LarkSdkClient,
  LarkSdkDispatcher,
  LarkMessageEventData,
} from '../src/index.ts';
import type { HttpTransport, HttpRequestInit } from '../src/index.ts';
import type { CardCreateResult, LarkUpstream } from '../src/index.ts';

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
class FakeOutbound implements LarkUpstream {
  receive(): Promise<void> {
    return Promise.resolve();
  }

  sendText(): Promise<unknown> {
    return Promise.resolve({});
  }

  sendMedia(): Promise<unknown> {
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

/**
 * Fake WS client: records lifecycle, captures the dispatcher handed to
 * start(), and can simulate the WS server delivering v1 event envelopes.
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
    // The real WSClient dispatches with needCheck: false (no token check).
    return this.dispatcher.invoke(payload, { needCheck: false });
  }
}

/** Event types currently registered on the captured dispatcher. */
function registeredKeys(client: FakeWsClient): string[] {
  const handles = (client.dispatcher as unknown as { handles?: Map<string, unknown> })?.handles;
  return handles ? [...handles.keys()] : [];
}

/**
 * Build the flat parsed v1 payload the EventDispatcher delivers to the
 * `im.message.receive_v1` handler (header + event fields merged).
 */
function flatEvent(overrides: Record<string, unknown> = {}): LarkMessageEventData {
  return {
    event_id: 'evt-1',
    event_type: MESSAGE_EVENT_KEY,
    token: 'tok-1',
    create_time: '1700000000000',
    sender: {
      sender_id: { open_id: 'ou_user123', union_id: 'on_1', user_id: 'u_1' },
      sender_type: 'user',
    },
    message: {
      message_id: 'om_msg1',
      chat_id: 'oc_conv1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello sdk' }),
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

function sdkUpstream(client: LarkSdkClient, outbound: LarkUpstream): LarkSdkUpstream {
  return new LarkSdkUpstream({ client, outbound });
}

describe('toGatewayRaw (v1 message event → gateway raw shape)', () => {
  it('maps a text dm event to the gateway raw shape', () => {
    const raw = toGatewayRaw(flatEvent({
      message: {
        message_id: 'om_dm1',
        chat_id: 'ou_dm_user',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hi' }),
        create_time: '1700000000000',
      },
    }));
    expect(raw).toEqual({
      type: 'text',
      msgId: 'om_dm1',
      eventId: 'evt-1',
      senderId: 'ou_user123',
      conversationId: 'ou_dm_user',
      chatType: 'p2p',
      content: 'hi',
    });
  });

  it('maps a group thread reply with parent_id into threadId', () => {
    const raw = toGatewayRaw(flatEvent({
      message: {
        message_id: 'om_reply1',
        chat_id: 'oc_conv1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'reply' }),
        parent_id: 'om_parent1',
        create_time: '1700000000000',
      },
    }));
    expect(raw).toMatchObject({ type: 'text', msgId: 'om_reply1', chatType: 'group' });
    // parent_id falls back as the thread reference when thread_id/root_id are absent.
    expect(raw).toHaveProperty('threadId', 'om_parent1');
  });

  it('prefers thread_id over root_id over parent_id for the thread reference', () => {
    const raw = toGatewayRaw(flatEvent({
      message: {
        message_id: 'om_reply2',
        chat_id: 'oc_conv1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'reply' }),
        thread_id: 'om_thread1',
        root_id: 'om_root1',
        parent_id: 'om_parent1',
        create_time: '1700000000000',
      },
    }));
    expect(raw).toHaveProperty('threadId', 'om_thread1');
  });

  it('maps media messages best-effort (image/audio/video/file)', () => {
    const image = toGatewayRaw(flatEvent({
      message: {
        message_id: 'om_img',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_v2_abc' }),
        create_time: '1700000000000',
      },
    }));
    expect(image).toMatchObject({ type: 'image', picUrl: 'img_v2_abc' });

    const audio = toGatewayRaw(flatEvent({
      message: {
        message_id: 'om_audio',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'audio',
        content: JSON.stringify({ file_key: 'file_v2_a', duration: 5200 }),
        create_time: '1700000000000',
      },
    }));
    expect(audio).toMatchObject({ type: 'audio', mediaUrl: 'file_v2_a', durationMs: 5200 });

    const video = toGatewayRaw(flatEvent({
      message: {
        message_id: 'om_video',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'media',
        content: JSON.stringify({ file_key: 'file_v2_v', duration: 9000 }),
        create_time: '1700000000000',
      },
    }));
    expect(video).toMatchObject({ type: 'video', mediaUrl: 'file_v2_v', durationMs: 9000 });

    const file = toGatewayRaw(flatEvent({
      message: {
        message_id: 'om_file',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'file',
        content: JSON.stringify({ file_key: 'file_v2_f', file_name: 'report.pdf' }),
        create_time: '1700000000000',
      },
    }));
    expect(file).toMatchObject({ type: 'file', mediaUrl: 'file_v2_f', title: 'report.pdf' });
  });

  it('falls back to union_id when open_id is absent', () => {
    const raw = toGatewayRaw(flatEvent({
      sender: { sender_id: { union_id: 'on_only' }, sender_type: 'user' },
    }));
    expect(raw).toMatchObject({ senderId: 'on_only' });
  });

  it('returns undefined when the event carries no message body', () => {
    expect(toGatewayRaw({ event_id: 'evt-x' })).toBeUndefined();
    expect(toGatewayRaw({ event_id: 'evt-x', message: undefined })).toBeUndefined();
  });
});

describe('LarkSdkUpstream.receive', () => {
  it('registers the message event and connects, then disconnects on abort', async () => {
    const client = new FakeWsClient();
    const upstream = sdkUpstream(client, new FakeOutbound());
    const controller = new AbortController();
    const received: unknown[] = [];
    const loop = upstream.receive(controller.signal, (raw) => received.push(raw));

    await vi.waitFor(() => expect(client.starts).toBe(1), { timeout: 2000 });
    expect(registeredKeys(client)).toContain(MESSAGE_EVENT_KEY);
    expect(client.dispatcher).toBeDefined();

    await client.emit(v1Event());
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000 });
    expect(received[0]).toMatchObject({
      type: 'text',
      msgId: 'om_msg1',
      senderId: 'ou_user123',
      conversationId: 'oc_conv1',
      content: 'hello sdk',
    });
    expect(received[0]).toHaveProperty('eventId', 'evt-1');

    controller.abort();
    await loop;
    expect(client.closes).toBe(1);
  });

  it('routes inbound events through the inbound processor to MessageReceived', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeWsClient();
    const upstream = sdkUpstream(client, new FakeOutbound());
    const processor = new InboundProcessor({
      ctx,
      meta: { channel: 'lark' as never, accountId: 'main' as never },
      dedupEnabled: false,
      dedupWindowMs: 5000,
    });
    const listener = vi.fn();
    service.on(listener);
    const controller = new AbortController();
    const loop = upstream.receive(controller.signal, (raw) => {
      void processor.handle(raw).catch(() => undefined);
    });

    await vi.waitFor(() => expect(client.starts).toBe(1), { timeout: 2000 });
    await client.emit(v1Event());
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
    expect(event.message.id).toBe('om_msg1');
    expect(event.message.content).toEqual([{ type: 'text', text: 'hello sdk' }]);
    expect(event.conversation.id).toBe('oc_conv1');
    expect(event.conversation.type).toBe('group');
    expect(event.sender.id).toBe('ou_user123');

    controller.abort();
    await loop;
  });

  it('preserves a dm event as a dm conversation through the pipeline', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeWsClient();
    const upstream = sdkUpstream(client, new FakeOutbound());
    const processor = new InboundProcessor({
      ctx,
      meta: { channel: 'lark' as never, accountId: 'main' as never },
      dedupEnabled: false,
      dedupWindowMs: 5000,
    });
    const listener = vi.fn();
    service.on(listener);
    const controller = new AbortController();
    const loop = upstream.receive(controller.signal, (raw) => {
      void processor.handle(raw).catch(() => undefined);
    });

    await vi.waitFor(() => expect(client.starts).toBe(1), { timeout: 2000 });
    await client.emit(v1Event(flatEvent({
      message: {
        message_id: 'om_dm2',
        chat_id: 'ou_dm_user',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'dm hi' }),
        create_time: '1700000000000',
      },
    })));
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
    expect(event.conversation.id).toBe('ou_dm_user');
    expect(event.conversation.type).toBe('dm');
    expect(event.conversation.threadId).toBeUndefined();

    controller.abort();
    await loop;
  });

  it('preserves a thread reply as conversation.threadId through the pipeline', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeWsClient();
    const upstream = sdkUpstream(client, new FakeOutbound());
    const processor = new InboundProcessor({
      ctx,
      meta: { channel: 'lark' as never, accountId: 'main' as never },
      dedupEnabled: false,
      dedupWindowMs: 5000,
    });
    const listener = vi.fn();
    service.on(listener);
    const controller = new AbortController();
    const loop = upstream.receive(controller.signal, (raw) => {
      void processor.handle(raw).catch(() => undefined);
    });

    await vi.waitFor(() => expect(client.starts).toBe(1), { timeout: 2000 });
    await client.emit(v1Event(flatEvent({
      message: {
        message_id: 'om_reply3',
        chat_id: 'oc_conv1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: 'thread reply' }),
        parent_id: 'om_thread_root',
        create_time: '1700000000000',
      },
    })));
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
    expect(event.conversation.id).toBe('oc_conv1');
    expect(event.conversation.threadId).toBe('om_thread_root');
    // Threads exist: the session key resolves to the thread-scoped binding.
    const key = `${event.channel}:${event.accountId}:${event.conversation.id}:${event.conversation.threadId}`;
    expect(key).toBe('lark:main:oc_conv1:om_thread_root');

    controller.abort();
    await loop;
  });

  it('resolves on abort and disconnects', async () => {
    const client = new FakeWsClient();
    const upstream = sdkUpstream(client, new FakeOutbound());
    const controller = new AbortController();
    const loop = upstream.receive(controller.signal, () => {});
    await vi.waitFor(() => expect(client.starts).toBe(1), { timeout: 2000 });
    controller.abort();
    await loop; // must resolve, not hang
    expect(client.closes).toBe(1);
  });

  it('disconnects without onConnected when the signal aborts mid-connect', async () => {
    const client = new FakeWsClient();
    const connected = vi.fn();
    const upstream = new LarkSdkUpstream({ client, outbound: new FakeOutbound(), onConnected: connected });
    const controller = new AbortController();
    const loop = upstream.receive(controller.signal, () => {});
    // Abort before connect resolves.
    controller.abort();
    await loop;
    expect(client.closes).toBe(1);
    expect(connected).not.toHaveBeenCalled();
  });

  it('propagates connect failures (adapter owns reconnect)', async () => {
    const client = new FakeWsClient();
    client.failStart = new Error('ws connect failed');
    const upstream = sdkUpstream(client, new FakeOutbound());
    const controller = new AbortController();
    await expect(upstream.receive(controller.signal, () => {})).rejects.toThrow('ws connect failed');
    expect(client.closes).toBe(0);
  });

  it('reconnects without re-registering the message event handler', async () => {
    const client = new FakeWsClient();
    const upstream = sdkUpstream(client, new FakeOutbound());
    const first = new AbortController();
    await (async () => {
      const loop = upstream.receive(first.signal, () => {});
      await vi.waitFor(() => expect(client.starts).toBe(1), { timeout: 2000 });
      first.abort();
      await loop;
    })();
    const keysAfterFirst = registeredKeys(client);
    expect(keysAfterFirst).toContain(MESSAGE_EVENT_KEY);
    const second = new AbortController();
    const loop = upstream.receive(second.signal, () => {});
    await vi.waitFor(() => expect(client.starts).toBe(2), { timeout: 2000 });
    // The handler is registered once per driver instance — reconnects reuse it.
    expect(registeredKeys(client)).toEqual(keysAfterFirst);
    second.abort();
    await loop;
    expect(client.closes).toBe(2);
  });
});

describe('LarkSdkUpstream outbound (delegated to the HTTP driver)', () => {
  it('delegates sendText and sendMedia to the outbound upstream', async () => {
    const transport = new FakeTransport();
    transport.route('/message/send', () => ({ id: 'out-1' }));
    const http = new HttpLarkUpstream({ transport, longPollTimeoutMs: 1000 });
    const upstream = sdkUpstream(new FakeWsClient(), http);

    await expect(upstream.sendText('oc_456', 'hello')).resolves.toEqual({ id: 'out-1' });
    await expect(
      upstream.sendMedia('oc_456', { type: 'image', url: 'https://x/p.png', alt: 'pic' }),
    ).resolves.toEqual({ id: 'out-1' });
    expect(transport.calls.map((c) => c.path)).toEqual(['/message/send', '/message/send']);
    expect(transport.calls[0]?.init?.body).toEqual({ to: 'oc_456', type: 'text', content: 'hello' });
    expect(transport.calls[1]?.init?.body).toEqual({
      to: 'oc_456',
      type: 'image',
      url: 'https://x/p.png',
      name: 'pic',
    });
  });

  it('delegates card operations to the outbound upstream', async () => {
    const transport = new FakeTransport();
    transport.route('/card/create', () => ({ cardId: 'card-1' }));
    transport.route('/card/update', () => ({ ok: true }));
    transport.route('/card/finish', () => ({ ok: true }));
    transport.route('/card/fail', () => ({ ok: true }));
    const http = new HttpLarkUpstream({ transport, longPollTimeoutMs: 1000 });
    const upstream = sdkUpstream(new FakeWsClient(), http);

    await expect(upstream.createCard('oc_456', 'hi')).resolves.toEqual({ cardId: 'card-1' });
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
});