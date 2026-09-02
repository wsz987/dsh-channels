/**
 * CardKit 2.0 native-streaming acceptance driven by the generic ReplyRouter.
 *
 * Wires a real `LarkAdapter` (over a fake official SDK WS client + fake
 * OpenAPI client), a real `ReplyRouter` imported from channel-harness source,
 * and a SessionBinding, then drives `assistant/chunk`, `assistant/message`
 * and `turn/end` records through it. All assertions run on the generic
 * pipeline with capability negotiation only (`streaming: 'edit'`) — the
 * harness module is never special-cased and the channel id `'lark'` appears
 * only as binding data.
 *
 * The streamed reply rides the OFFICIAL CardKit lifecycle: card entity create
 * → card reference send → cardElement.content stream → card.settings close.
 * No `im.v1.message.patch` pseudo-stream and no legacy transport.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, type MessageReceived } from '@wsz987/channel-core';
import { createTestContext } from '@wsz987/channel-testkit';
import { ReplyRouter } from '../../channel-harness/src/reply-router.ts';
import { ReplyContextStore } from '../../channel-harness/src/reply-context-store.ts';
import { SESSION_BINDING_SCHEMA_VERSION, type SessionBinding } from '../../channel-harness/src/session-router.ts';
import {
  Config,
  LarkAdapter,
  type LarkCardReply,
  type LarkOpenApiClient,
  type LarkSdkClient,
  type LarkSdkDispatcher,
} from '../src/index.ts';
import type { LarkConfig } from '../src/config.ts';

/** Fake official SDK WS client (captures the dispatcher). */
class FakeWsClient implements LarkSdkClient {
  starts = 0;
  closes = 0;
  dispatcher?: LarkSdkDispatcher;

  async start(params: { eventDispatcher: LarkSdkDispatcher }): Promise<void> {
    this.dispatcher = params.eventDispatcher;
    this.starts += 1;
  }

  close(): void {
    this.closes += 1;
  }
}

/** Fake official OpenAPI client recording CardKit + message calls. */
class FakeOpenApiClient implements LarkOpenApiClient {
  calls: { method: string; payload?: unknown }[] = [];

  im = {
    v1: {
      message: {
        create: async (payload: unknown) => {
          this.calls.push({ method: 'message.create', payload });
          return { code: 0, data: { message_id: `om_${this.calls.length}` } };
        },
        patch: async (payload: unknown) => {
          this.calls.push({ method: 'message.patch', payload });
          return { code: 0 };
        },
      },
      image: {
        create: async () => ({ image_key: 'img_v2' }),
      },
      file: {
        create: async () => ({ file_key: 'file_v2' }),
      },
    },
  };

  cardkit = {
    v1: {
      card: {
        create: async (payload: unknown) => {
          this.calls.push({ method: 'cardkit.card.create', payload });
          return { code: 0, data: { card_id: `cc_${this.calls.length}` } };
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

function makeConfig(overrides: Partial<LarkConfig> = {}): LarkConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    timeoutMs: 1000,
    reconnect: {
      enabled: true,
      baseDelayMs: 1,
      maxDelayMs: 10,
      maxRetries: 0,
    },
    dedup: {
      enabled: true,
      windowMs: 5000,
    },
    card: {
      createOnFirstDelta: true,
      typingIndicator: false,
    },
    upstream: {
      appId: 'cli_e2e',
    },
    ...overrides,
  });
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeAdapter(): { adapter: LarkAdapter; openApi: FakeOpenApiClient; client: FakeWsClient } {
  const openApi = new FakeOpenApiClient();
  const client = new FakeWsClient();
  const adapter = new LarkAdapter(makeConfig(), {
    sdkClient: client,
    openApiClient: openApi,
    now: () => Date.now(),
  });
  return { adapter, openApi, client };
}

function makeBinding(): SessionBinding {
  return {
    channelId: 'lark',
    accountId: 'main',
    conversationId: 'oc_1',
    sessionId: 's1',
    route: { preset: 'default' },
    schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeRouter(
  adapter: LarkAdapter,
  binding: SessionBinding,
  updateIntervalMs: number,
): ReplyRouter {
  const replyContexts = new ReplyContextStore();
  // Seed a channel-inbound ReplyContext for turn 0 (the turn these tests
  // drive) so the router's ReplyContext outbound gate passes.
  replyContexts.register('harness-0', {
    sessionId: binding.sessionId,
    context: { conversationType: 'dm', replyToMessageId: 'msg_0' },
  });
  replyContexts.claim({ sessionId: binding.sessionId, messageId: 'harness-0', turn: 0 });
  return new ReplyRouter({
    config: {
      updateIntervalMs,
      maxTextLength: undefined,
      splitParagraphs: true,
      splitCodeBlocks: true,
      finalFlush: true,
    },
    getAdapter: () => adapter,
    getBinding: () => binding,
    replyContexts,
    logger: silentLogger,
  });
}

/** Capture the card handle created inside the router via createReply. */
function captureHandle(
  adapter: LarkAdapter,
): { handle: () => LarkCardReply | undefined } {
  const captured = { handle: undefined as LarkCardReply | undefined };
  const createReply = adapter.createReply.bind(adapter);
  vi.spyOn(adapter, 'createReply').mockImplementation(async (target, options) => {
    const handle = await createReply(target, options);
    captured.handle = handle;
    return handle;
  });
  return captured;
}

function fakeSession(id: string): never {
  return { id } as never;
}

function chunkEvent(turn: number, text: string): never {
  return {
    type: 'assistant/chunk',
    seq: 1,
    time: Date.now(),
    data: { turn, step: 0, chunk: { type: 'text-delta', index: 0, text } },
  } as never;
}

function assistantMessageEvent(turn: number, text: string): never {
  return {
    type: 'assistant/message',
    seq: 2,
    time: Date.now(),
    data: { turn, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  } as never;
}

function turnEndEvent(turn: number): never {
  return {
    type: 'turn/end',
    seq: 3,
    time: Date.now(),
    data: { turn, reason: { kind: 'completed' } },
  } as never;
}

describe('CardKit 2.0 native streaming through the generic ReplyRouter', () => {
  it('streams deltas through cardElement.content and closes streaming at turn end', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const { adapter, openApi, client } = makeAdapter();
    await adapter.start(ctx);

    const captured = captureHandle(adapter);
    const binding = makeBinding();
    // Chunks arrive every 8ms while the throttle window is 50ms, so the router
    // coalesces bursts and flushes only on interval boundaries.
    const router = makeRouter(adapter, binding, 50);
    const session = fakeSession('s1');

    const chunkCount = 20;
    for (let i = 0; i < chunkCount; i += 1) {
      router.onSessionEvent(session, chunkEvent(0, 'a'));
      await sleep(8);
    }

    // The card entity was created once and streamed (fewer content calls than
    // chunks thanks to throttling, but at least one preview).
    await vi.waitFor(() => {
      const created = openApi.calls.filter((c) => c.method === 'cardkit.card.create').length;
      expect(created).toBe(1);
    }, { timeout: 3000 });
    // Wait for the final throttle flush so the handle holds the whole stream.
    await vi.waitFor(() => {
      expect(captured.handle?.text).toBe('a'.repeat(chunkCount));
    }, { timeout: 3000 });

    const contentCalls = openApi.calls.filter((c) => c.method === 'cardkit.cardElement.content').length;
    expect(contentCalls).toBeGreaterThan(0);
    expect(contentCalls).toBeLessThan(chunkCount);
    expect(captured.handle?.status).toBe('active');

    // turn/end finalizes via cardkit.card.settings (streaming_mode false).
    router.onSessionEvent(session, turnEndEvent(0));
    await vi.waitFor(() => {
      expect(captured.handle?.status).toBe('finished');
      expect(openApi.calls.some((c) => c.method === 'cardkit.card.settings')).toBe(true);
    }, { timeout: 3000 });
    expect(captured.handle?.text).toBe('a'.repeat(chunkCount));

    // The streamed reply used createReply (edit), never send; and no
    // message.patch pseudo-stream appears anywhere.
    expect(openApi.calls.some((c) => c.method === 'message.patch')).toBe(false);
    expect(openApi.calls.filter((c) => c.method === 'cardkit.card.create').length).toBe(1);
    expect(client.starts).toBeGreaterThan(0);

    await adapter.stop();
  }, 8000);

  it('delivers via the CardKit card path even when only an assistant/message (no deltas) flows', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const { adapter, openApi } = makeAdapter();
    await adapter.start(ctx);

    const captured = captureHandle(adapter);
    const router = makeRouter(adapter, makeBinding(), 0);
    const session = fakeSession('s1');

    router.onSessionEvent(session, assistantMessageEvent(0, 'final only'));
    router.onSessionEvent(session, turnEndEvent(0));

    await vi.waitFor(() => {
      expect(captured.handle?.status).toBe('finished');
      expect(openApi.calls.some((c) => c.method === 'cardkit.card.create')).toBe(true);
      expect(openApi.calls.some((c) => c.method === 'cardkit.card.settings')).toBe(true);
    }, { timeout: 3000 });
    expect(captured.handle?.text).toBe('final only');
    // No message.patch pseudo-stream and no plain text send for the reply.
    expect(openApi.calls.some((c) => c.method === 'message.patch')).toBe(false);

    await adapter.stop();
  }, 8000);

  it('marks the card failed when a mid-stream element update throws (failure)', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const { adapter, openApi } = makeAdapter();
    await adapter.start(ctx);

    const captured = captureHandle(adapter);
    const router = makeRouter(adapter, makeBinding(), 20);
    const session = fakeSession('s1');

    // The first flush creates the entity; the second flush's element content
    // update throws.
    const realContent = openApi.cardkit.v1.cardElement.content.bind(openApi.cardkit.v1.cardElement);
    let contentCalls = 0;
    openApi.cardkit.v1.cardElement.content = async (payload: unknown) => {
      contentCalls += 1;
      if (contentCalls >= 2) throw new Error('element content exploded');
      return realContent(payload);
    };

    router.onSessionEvent(session, chunkEvent(0, 'a'));
    await sleep(30);
    router.onSessionEvent(session, chunkEvent(0, 'b'));

    // The router calls handle.fail -> card enters 'failed' with the error.
    await vi.waitFor(() => {
      expect(captured.handle).toBeDefined();
      expect(captured.handle?.status).toBe('failed');
    }, { timeout: 3000 });
    expect(captured.handle?.error).toBeInstanceOf(Error);
    expect((captured.handle?.error as Error).message).toContain('element content exploded');

    // A later turn/end must not finalize a failed card (settings only from
    // the failure close).
    router.onSessionEvent(session, turnEndEvent(0));
    await vi.waitFor(() => {
      expect(captured.handle?.status).toBe('failed');
    }, { timeout: 1000 });

    await adapter.stop();
  }, 8000);

  it('deduplicates identical inbound payloads before forwarding (dedup)', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const { adapter, client } = makeAdapter();
    const received: MessageReceived[] = [];
    service.on((event) => {
      if (event.type === 'message.received') received.push(event as MessageReceived);
    });
    await adapter.start(ctx);
    await vi.waitFor(() => expect(client.starts).toBe(1), { timeout: 2000 });

    const dupRaw = {
      type: 'text',
      msgId: 'dup-m1',
      senderId: 'ou_1',
      conversationId: 'oc_1',
      chatType: 'group',
      content: 'hello',
    };
    // Two identical inbound deliveries (transport retry) — the dispatcher
    // wraps them in the v1 envelope the WS delivers.
    const envelope = {
      schema: '2.0',
      header: { event_id: 'evt-dup', event_type: 'im.message.receive_v1', create_time: '1700000000000' },
      event: {
        sender: { sender_id: { open_id: 'ou_1' }, sender_type: 'user' },
        message: {
          message_id: 'dup-m1',
          chat_id: 'oc_1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
          create_time: '1700000000000',
        },
      },
    };
    await client.dispatcher!.invoke(envelope, { needCheck: false });
    await client.dispatcher!.invoke(envelope, { needCheck: false });

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    }, { timeout: 2000 });
    // Let a duplicate settle if the window logic is wrong.
    await sleep(100);
    expect(received).toHaveLength(1);
    expect(received[0]?.message.id).toBe('dup-m1');
    expect(received[0]?.conversation.id).toBe('oc_1');

    await adapter.stop();
  }, 8000);
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
