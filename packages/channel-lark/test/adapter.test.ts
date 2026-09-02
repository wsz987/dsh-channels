/**
 * Adapter tests: fixture-driven mapper (incl. thread isolation fixture),
 * dedup, the official-SDK upstream driver over a fake WS client + fake
 * OpenAPI client, the adapter lifecycle (connection/auth/health/send/error
 * mapping), the plugin shape, and the generic channel adapter contract suite.
 *
 * The CardKit 2.0 native-streaming reply handle is covered by
 * `card.test.ts`; `streaming-e2e.test.ts` drives it through the generic
 * ReplyRouter.
 */
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
  LarkAdapter,
  InboundProcessor,
  mapInbound,
  mapInteraction,
  toTextPayload,
  dedupKey,
  MESSAGE_EVENT_KEY,
  apply,
} from '../src/index.ts';
import type {
  LarkSdkClient,
  LarkSdkDispatcher,
  LarkMessageEventData,
  LarkOpenApiClient,
} from '../src/index.ts';
import type { LarkConfig } from '../src/config.ts';

function makeConfig(overrides: Partial<LarkConfig> = {}): LarkConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    timeoutMs: 1000,
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
    upstream: {
      appId: 'cli_test',
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
 * Fake official OpenAPI client for SDK-mode outbound: records calls, returns
 * deterministic message/image/card ids, and can be made to fail `create`.
 */
class FakeOpenApiClient implements LarkOpenApiClient {
  calls: { method: string; payload?: unknown }[] = [];
  createError?: Error;
  createResult: { code?: number; data?: { message_id?: string } } = {
    code: 0,
    data: { message_id: 'om_out_1' },
  };
  cardCreateResult: { code?: number; data?: { card_id?: string } } = {
    code: 0,
    data: { card_id: 'cc_out_1' },
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
          return this.cardCreateResult;
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
  it('uses platform chatType for p2p conversations with oc_ chat ids', () => {
    const event = mapInbound({
      type: 'text',
      msgId: 'm_dm',
      senderId: 'ou_1',
      conversationId: 'oc_dm_chat',
      chatType: 'p2p',
      content: 'private',
    }, meta);

    expect(event.conversation).toEqual({ id: 'oc_dm_chat', type: 'dm' });
  });

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

  it('maps an opaque Lark image_key into resourceRef, not url', () => {
    // The SDK path sets picUrl = image_key (an opaque platform handle), so the
    // mapper must place it in resourceRef — never url, which is reserved for
    // genuine http(s) URLs.
    const raw = {
      type: 'image',
      msgId: 'm_img_key',
      senderId: 'ou_1',
      conversationId: 'oc_1',
      chatType: 'group',
      picUrl: 'img_v2_abcdef',
      title: 'opaque key image',
    };
    const event = mapInbound(raw, meta);
    const content = event.message.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({
      type: 'image',
      resourceRef: 'img_v2_abcdef',
      alt: 'opaque key image',
    });
    // url must not carry the opaque key.
    expect((content[0] as { url?: string }).url).toBeUndefined();
  });

  it('keeps audio/video/file mapped to url when mediaUrl is a genuine URL', () => {
    const audio = mapInbound(
      { type: 'audio', msgId: 'm1', senderId: 'ou_1', conversationId: 'oc_1', chatType: 'group', mediaUrl: 'https://x/a.ogg', durationMs: 1000 },
      meta,
    );
    expect((audio.message.content[0] as { url?: string }).url).toBe('https://x/a.ogg');

    const video = mapInbound(
      { type: 'video', msgId: 'm2', senderId: 'ou_1', conversationId: 'oc_1', chatType: 'group', mediaUrl: 'https://x/v.mp4' },
      meta,
    );
    expect((video.message.content[0] as { url?: string }).url).toBe('https://x/v.mp4');

    const file = mapInbound(
      { type: 'file', msgId: 'm3', senderId: 'ou_1', conversationId: 'oc_1', chatType: 'group', mediaUrl: 'https://x/doc.pdf', title: 'doc' },
      meta,
    );
    expect((file.message.content[0] as { url?: string }).url).toBe('https://x/doc.pdf');
  });

  it('maps an opaque Lark file_key into resourceRef, not url', () => {
    // The SDK path routes the file body's opaque file_key through
    // raw.mediaUrl (lark-sdk-upstream.ts). As with image_key, that opaque
    // handle must live in resourceRef — never url.
    const raw = {
      type: 'file',
      msgId: 'm_file_key',
      senderId: 'ou_1',
      conversationId: 'oc_1',
      chatType: 'group',
      mediaUrl: 'file_v2_abcdef',
      title: 'report.pdf',
    };
    const event = mapInbound(raw, meta);
    const content = event.message.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({
      type: 'file',
      resourceRef: 'file_v2_abcdef',
      name: 'report.pdf',
    });
    // url must not carry the opaque key.
    expect((content[0] as { url?: string }).url).toBeUndefined();
  });

  it('maps opaque audio/video file_keys into resourceRef, keeping genuine URLs in url', () => {
    // SDK audio/video bodies carry opaque file_keys; mirror the file rule.
    const audio = mapInbound(
      { type: 'audio', msgId: 'a1', senderId: 'ou_1', conversationId: 'oc_1', chatType: 'group', mediaUrl: 'file_v2_voice', durationMs: 1200 },
      meta,
    );
    expect(audio.message.content[0]).toEqual({ type: 'audio', resourceRef: 'file_v2_voice', durationMs: 1200 });

    const video = mapInbound(
      { type: 'video', msgId: 'v1', senderId: 'ou_1', conversationId: 'oc_1', chatType: 'group', mediaUrl: 'file_v2_movie' },
      meta,
    );
    expect(video.message.content[0]).toEqual({ type: 'video', resourceRef: 'file_v2_movie' });

    // A genuine URL for audio/video continues to use the url carrier.
    const audioUrl = mapInbound(
      { type: 'audio', msgId: 'a2', senderId: 'ou_1', conversationId: 'oc_1', chatType: 'group', mediaUrl: 'https://x/a.ogg' },
      meta,
    );
    expect((audioUrl.message.content[0] as { url?: string }).url).toBe('https://x/a.ogg');
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

  it('maps a thread payload and preserves conversation.threadId', async () => {
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
      { type: 'text', msgId: 'm1', senderId: 'ou_1', conversationId: 'oc_2', chatType: 'group', content: 'hi' },
      meta,
    );
    expect(event.conversation.threadId).toBeUndefined();
  });

  it('falls back to the sender id as conversation id when conversationId is missing', () => {
    const event = mapInbound(
      { type: 'text', senderId: 'ou_7', chatType: 'p2p', content: 'hi' },
      meta,
    );
    expect(event.conversation.id).toBe('ou_7');
    expect(event.message.id).toMatch(/^lk-/);
  });

  it('maps an interaction callback to interaction.received', async () => {
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
    const raw = { type: 'text', senderId: 'u1', chatType: 'p2p', msgId: 'm1', content: 'x' };
    expect(dedupKey(raw)).toBe('m1');
    const noId = { type: 'text', senderId: 'u1', chatType: 'p2p', content: 'x' };
    expect(dedupKey(noId)).toBe(dedupKey({ ...noId }));
    const eventIdOnly = { type: 'text', senderId: 'u1', chatType: 'p2p', eventId: 'e9', content: 'x' };
    expect(dedupKey(eventIdOnly)).toBe('e9');
  });

  it('rejects inbound payloads without an authoritative chatType', () => {
    expect(() => mapInbound({ type: 'text', senderId: 'ou_1', conversationId: 'oc_1' }, meta))
      .toThrow('lark inbound payload is invalid: chatType');
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

    const raw = { type: 'text', senderId: 'ou_1', conversationId: 'oc_1', chatType: 'group', msgId: 'dup-1', content: 'hi' };
    await processor.handle(raw);
    await processor.handle(raw);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]?.[0] as MessageReceived).message.id).toBe('dup-1');
  });

  it('forwards distinct messages', async () => {
    const { service, processor } = makeProcessor();
    const listener = vi.fn();
    service.on(listener);
    await processor.handle({ type: 'text', senderId: 'ou_1', chatType: 'p2p', msgId: 'a', content: '1' });
    await processor.handle({ type: 'text', senderId: 'ou_1', chatType: 'p2p', msgId: 'b', content: '2' });
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
      chatType: 'group',
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

describe('LarkAdapter lifecycle', () => {
  function adapter(overrides: Partial<LarkConfig> = {}): LarkAdapter {
    return new LarkAdapter(makeConfig(overrides), { now: () => 1000 });
  }

  it('rejects send before start', async () => {
    const a = adapter();
    await expect(a.send(makeChannelTarget(), makeOutboundMessage())).rejects.toMatchObject({
      code: 'CHANNEL_NOT_STARTED',
    });
  });

  it('fails start loudly when credentials are missing', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const a = new LarkAdapter(makeConfig({ upstream: { appId: undefined } }), { now: () => 1000 });
    await expect(a.start(ctx)).rejects.toThrow(/appId.*appSecret/);
  });
});

describe('LarkAdapter SDK mode (fake WS client)', () => {
  function sdkAdapter(client: FakeWsClient, openApiClient: FakeOpenApiClient = new FakeOpenApiClient()): LarkAdapter {
    return new LarkAdapter(
      makeConfig({ upstream: { appId: 'cli_appid' } }),
      { sdkClient: client, openApiClient, now: () => 1000 },
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

  it('uses the injected client factory when no concrete client is given', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeWsClient();
    const factory = vi.fn(() => client);
    const a = new LarkAdapter(
      makeConfig({ upstream: { appId: 'cli_appid' } }),
      { sdkClientFactory: factory, openApiClient: new FakeOpenApiClient(), now: () => 1000 },
    );
    await a.start(ctx);
    expect(factory).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(client.starts).toBe(1), { timeout: 2000 });
    await a.stop();
  });

  it('routes SDK-mode outbound through the OpenAPI client (message.create)', async () => {
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
    await a.stop();
  });

  it('never leaks credentials into WS client or OpenAPI client calls', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeWsClient();
    const openApiClient = new FakeOpenApiClient();
    const secret = 'super-secret-app-secret';
    const a = new LarkAdapter(
      makeConfig({ upstream: { appId: 'cli_appid' } }),
      { sdkClient: client, openApiClient, appId: 'cli_appid', appSecret: secret, now: () => 1000 },
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
});

/** Adapter used by the generic contract suite (fake WS + OpenAPI clients). */
const contractOpenApi = new FakeOpenApiClient();
const contractAdapter = new LarkAdapter(
  makeConfig({ upstream: { appId: 'cli_appid' } }),
  { sdkClient: new FakeWsClient(), openApiClient: contractOpenApi, now: () => 1000 },
);
runChannelAdapterContract(contractAdapter, {
  triggerSendFailure: () => {
    contractOpenApi.createError = new Error('send boom');
  },
});
