/**
 * SDK upstream driver tests (offline, fake WS client + fake OpenAPI outbound).
 *
 * Covers the `LarkSdkUpstream` inbound path: event registration, v1 message
 * event → canonical raw mapping, the full inbound pipeline to a
 * MessageReceived (dm + group + thread reply), start/stop connect/disconnect,
 * abort-driven teardown, outbound delegation to the OpenAPI driver, and the
 * credentials-never-leak guarantee. Events flow through a REAL SDK
 * `EventDispatcher` (pure logic, no network) driven by a fake WS client, so
 * the SDK's v1 parse/merge path is exercised offline. No real WebSocket or
 * Lark credentials are involved.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, ChannelError, type InteractionReceived, type MessageReceived } from '@wsz987/channel-core';
import { createTestContext } from '@wsz987/channel-testkit';
import {
  LarkSdkUpstream,
  LarkOpenApiOutbound,
  InboundProcessor,
  CARD_ACTION_EVENT_KEY,
  mapSdkCardAction,
  mapSdkMessageEvent,
  MESSAGE_EVENT_KEY,
} from '../src/index.ts';
import type {
  LarkSdkClient,
  LarkSdkDispatcher,
  LarkMessageEventData,
  LarkOpenApiClient,
  LarkUpstream,
  LarkOutbound,
} from '../src/index.ts';

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

  sendFile(): Promise<unknown> {
    return Promise.resolve({});
  }

  sendInteractive(): Promise<unknown> {
    return Promise.resolve({});
  }

  updateInteractive(): Promise<unknown> {
    return Promise.resolve({});
  }

  createCardEntity(): Promise<{ cardId: string }> {
    return Promise.resolve({ cardId: 'cc-fake' });
  }

  sendCardEntity(): Promise<{ messageId: string }> {
    return Promise.resolve({ messageId: 'om-fake' });
  }

  updateCardElementContent(): Promise<unknown> {
    return Promise.resolve({});
  }

  finishStreamingCard(): Promise<unknown> {
    return Promise.resolve({});
  }
}

/** Fake OpenAPI client used by outbound-delegation tests. */
class FakeOpenApiClient implements LarkOpenApiClient {
  calls: { method: string; payload?: unknown }[] = [];
  createResult: { code?: number; data?: { message_id?: string } } = {
    code: 0,
    data: { message_id: 'om_out_1' },
  };

  im = {
    v1: {
      message: {
        create: async (payload: unknown) => {
          this.calls.push({ method: 'message.create', payload });
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
      file: {
        create: async (payload: unknown) => {
          this.calls.push({ method: 'file.create', payload });
          return { file_key: 'file_v2_out' };
        },
      },
    },
  };

  cardkit = {
    v1: {
      card: {
        create: async (payload: unknown) => {
          this.calls.push({ method: 'cardkit.card.create', payload });
          return { code: 0, data: { card_id: 'cc_out_1' } };
        },
        settings: async (payload: unknown) => {
          this.calls.push({ method: 'cardkit.card.settings', payload });
          return { code: 0 };
        },
      },
      cardElement: {
        content: async (payload: unknown) => {
          this.calls.push({ method: 'cardkit.cardElement.content', payload });
          return { code: 0 };
        },
      },
    },
  };
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

function cardActionEvent(): Record<string, unknown> {
  return {
    schema: '2.0',
    header: { event_id: 'evt_card_1', event_type: CARD_ACTION_EVENT_KEY, create_time: '1700000000000' },
    event: {
      context: { open_message_id: 'om_card_1', open_chat_id: 'oc_group_1' },
      operator: { open_id: 'ou_user_1' },
      action: { tag: 'button', value: { actionId: 'question:option:1' } },
    },
  };
}

function sdkUpstream(client: LarkSdkClient, outbound: LarkOutbound): LarkSdkUpstream {
  return new LarkSdkUpstream({ client, outbound });
}

describe('mapSdkMessageEvent (v1 message event → canonical raw)', () => {
  it('accepts null optional identity fields from live Feishu events', () => {
    const raw = mapSdkMessageEvent(flatEvent({
      sender: {
        sender_id: { open_id: 'ou_user123', union_id: null, user_id: null },
        sender_type: 'user',
        tenant_key: null,
      },
      message: {
        message_id: 'om_dm_nulls',
        chat_id: 'oc_dm_chat',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hi' }),
        create_time: '1700000000000',
        root_id: null,
        parent_id: null,
        thread_id: null,
      },
    }));

    expect(raw).toMatchObject({
      msgId: 'om_dm_nulls',
      senderId: 'ou_user123',
      conversationId: 'oc_dm_chat',
      chatType: 'p2p',
    });
  });

  it('maps a text dm event to the canonical raw', () => {
    const raw = mapSdkMessageEvent(flatEvent({
      message: {
        message_id: 'om_dm1',
        chat_id: 'oc_dm_chat',
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
      conversationId: 'oc_dm_chat',
      chatType: 'p2p',
      content: 'hi',
    });
  });

  it('maps a group thread reply with parent_id into threadId', () => {
    const raw = mapSdkMessageEvent(flatEvent({
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
    const raw = mapSdkMessageEvent(flatEvent({
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
    const image = mapSdkMessageEvent(flatEvent({
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

    const audio = mapSdkMessageEvent(flatEvent({
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

    const video = mapSdkMessageEvent(flatEvent({
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

    const file = mapSdkMessageEvent(flatEvent({
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
    const raw = mapSdkMessageEvent(flatEvent({
      sender: { sender_id: { union_id: 'on_only' }, sender_type: 'user' },
    }));
    expect(raw).toMatchObject({ senderId: 'on_only' });
  });

  it('returns undefined when the event carries no message body', () => {
    expect(mapSdkMessageEvent({ event_id: 'evt-x' })).toBeUndefined();
    expect(mapSdkMessageEvent({ event_id: 'evt-x', message: undefined })).toBeUndefined();
  });
});

describe('LarkSdkUpstream.receive', () => {
  it('uses the official SDK normalizer for card actions and emits an interaction envelope', async () => {
    const client = new FakeWsClient();
    const upstream = new LarkSdkUpstream({
      client,
      outbound: new FakeOutbound(),
      resolveChatType: async (chatId) => chatId === 'oc_group_1' ? 'group' : undefined,
    });
    const controller = new AbortController();
    const received: unknown[] = [];
    const loop = upstream.receive(controller.signal, (raw) => received.push(raw));

    await vi.waitFor(() => expect(client.starts).toBe(1), { timeout: 2000 });
    expect(registeredKeys(client)).toContain(CARD_ACTION_EVENT_KEY);
    await client.emit(cardActionEvent());
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 2000 });
    expect(received[0]).toEqual({
      type: 'interaction',
      msgId: 'om_card_1',
      eventId: 'evt_card_1',
      senderId: 'ou_user_1',
      conversationId: 'oc_group_1',
      chatType: 'group',
      interactionId: 'om_card_1',
      action: 'question:option:1',
      value: { actionId: 'question:option:1' },
    });
    controller.abort();
    await loop;
  });

  it('fails closed when the official chat mode cannot be resolved for a card action', async () => {
    const raw = cardActionEvent();
    await expect(mapSdkCardAction(raw.event, async () => undefined)).resolves.toBeUndefined();
  });

  it('routes an SDK-normalized action through InboundProcessor as interaction.received', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeWsClient();
    const upstream = new LarkSdkUpstream({
      client,
      outbound: new FakeOutbound(),
      resolveChatType: async () => 'group',
    });
    const processor = new InboundProcessor({
      ctx,
      meta: { channel: 'lark' as never, accountId: 'main' as never },
      dedupEnabled: true,
      dedupWindowMs: 5000,
    });
    const listener = vi.fn();
    service.on(listener);
    const controller = new AbortController();
    const loop = upstream.receive(controller.signal, (raw) => {
      void processor.handle(raw).catch(() => undefined);
    });

    await vi.waitFor(() => expect(client.starts).toBe(1), { timeout: 2000 });
    await client.emit(cardActionEvent());
    await vi.waitFor(() => {
      expect(listener.mock.calls.some((call) => call[0]?.type === 'interaction.received')).toBe(true);
    }, { timeout: 2000 });
    const event = listener.mock.calls
      .map((call) => call[0] as InteractionReceived)
      .find((candidate) => candidate.type === 'interaction.received')!;
    expect(event).toMatchObject({
      conversation: { id: 'oc_group_1', type: 'group' },
      sender: { id: 'ou_user_1' },
      action: 'question:option:1',
    });
    controller.abort();
    await loop;
  });

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
        chat_id: 'oc_dm_chat',
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
    expect(event.conversation.id).toBe('oc_dm_chat');
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

describe('LarkSdkUpstream outbound (delegated to the OpenAPI driver)', () => {
  it('delegates sendText/sendMedia/sendFile to the OpenAPI outbound', async () => {
    const openApi = new FakeOpenApiClient();
    const outbound = new LarkOpenApiOutbound({ client: openApi });
    const upstream = sdkUpstream(new FakeWsClient(), outbound);

    await expect(upstream.sendText('oc_456', 'hello')).resolves.toMatchObject({ code: 0 });
    await expect(
      upstream.sendMedia('oc_456', { type: 'image', dataUri: 'data:image/png;base64,aGVsbG8=' }),
    ).resolves.toMatchObject({ code: 0 });
    await expect(
      upstream.sendFile('oc_456', { type: 'file', localData: new Uint8Array([1, 2]), name: 'a.bin' }),
    ).resolves.toMatchObject({ code: 0 });
    expect(openApi.calls.map((c) => c.method)).toEqual([
      'message.create',
      'image.create',
      'message.create',
      'file.create',
      'message.create',
    ]);
  });

  it('delegates CardKit entity + streaming operations to the OpenAPI outbound', async () => {
    const openApi = new FakeOpenApiClient();
    const outbound = new LarkOpenApiOutbound({ client: openApi });
    const upstream = sdkUpstream(new FakeWsClient(), outbound);

    await expect(upstream.createCardEntity('{"schema":"2.0"}')).resolves.toEqual({ cardId: 'cc_out_1' });
    await expect(upstream.sendCardEntity('oc_456', 'cc_out_1')).resolves.toEqual({ messageId: 'om_out_1' });
    await upstream.updateCardElementContent('cc_out_1', 'stream_md', 'hi', 1, 'c_cc_out_1_1');
    await upstream.finishStreamingCard('cc_out_1', 2, 'hi');
    expect(openApi.calls.map((c) => c.method)).toEqual([
      'cardkit.card.create',
      'message.create',
      'cardkit.cardElement.content',
      'cardkit.card.settings',
    ]);
  });
});
