import { describe, expect, it, vi, beforeEach } from 'vitest';
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
  TelegramAdapter,
  InboundProcessor,
  HttpTelegramUpstream,
  FetchTransport,
  TelegramStreamingReply,
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
    tokenRef: 'TELEGRAM_BOT_TOKEN',
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
    streaming: {
      enabled: true,
      placeholder: '…',
    },
    maxDownloadBytes: 20 * 1024 * 1024,
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

  it('keeps a document caption as text before the file part', () => {
    const event = mapInbound(
      {
        update_id: 1003,
        message: {
          message_id: 503,
          chat: { id: 100200300, type: 'private' },
          from: { id: 100200300, first_name: 'Alice' },
          document: {
            file_id: 'ANON_DOCUMENT',
            file_name: 'report.pdf',
            mime_type: 'application/pdf',
          },
          caption: 'quarterly report',
        },
      },
      { channel: 'telegram' as never, accountId: 'main' as never },
    );
    expect(event.message.content).toEqual([
      { type: 'text', text: 'quarterly report' },
      {
        type: 'file',
        resourceRef: 'ANON_DOCUMENT',
        name: 'report.pdf',
        mimeType: 'application/pdf',
      },
    ]);
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

  it('maps forum topics and reply correlation into the channel contract', () => {
    const event = mapInbound(
      {
        update_id: 2,
        message: {
          message_id: 8,
          message_thread_id: 77,
          reply_to_message: { message_id: 6 },
          chat: { id: -1001, type: 'supergroup' },
          from: { id: 3 },
          text: 'topic reply',
        },
      },
      { channel: 'telegram' as never, accountId: 'main' as never },
    );
    expect(event.conversation.threadId).toBe('77');
    expect(event.message.replyTo).toBe('6');
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

  it('infers image metadata from the binary response and Telegram file_path', async () => {
    transport.route(tgPath('getFile'), () => ({
      ok: true,
      result: {
        file_id: 'ANON_PHOTO',
        file_unique_id: 'anon-photo',
        file_path: 'photos/file_42.jpg',
      },
    }));
    transport.requestBinary = vi.fn(async () => ({
      data: new Uint8Array([0xff, 0xd8, 0xff]),
      contentType: 'application/octet-stream',
    }));

    await expect(upstream().downloadFile('ANON_PHOTO')).resolves.toEqual({
      data: new Uint8Array([0xff, 0xd8, 0xff]),
      mimeType: 'image/jpeg',
      name: 'file_42.jpg',
    });
  });

  it('keeps FetchTransport requestBinary bound to its transport instance', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/bot${TOKEN}/getFile`)) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            file_id: 'BOUND_PHOTO',
            file_unique_id: 'bound-photo',
            file_path: 'photos/bound.jpg',
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }) as typeof fetch;
    const transport = new FetchTransport('https://api.telegram.org', { timeoutMs: 1000, fetchImpl });
    const driver = new HttpTelegramUpstream({ transport, token: TOKEN, longPollTimeoutMs: 500 });

    await expect(driver.downloadFile('BOUND_PHOTO')).resolves.toMatchObject({
      mimeType: 'image/jpeg',
      name: 'bound.jpg',
      data: new Uint8Array([0xff, 0xd8, 0xff]),
    });
  });

  it('deleteWebhook preserves pending updates while switching to polling', async () => {
    transport.route(tgPath('deleteWebhook'), () => ({ ok: true, result: true }));
    await upstream().deleteWebhook();
    expect(transport.calls[0]).toMatchObject({
      path: tgPath('deleteWebhook'),
      init: { method: 'POST', body: { drop_pending_updates: false } },
    });
  });

  it('deleteWebhook surfaces a failed transition instead of starting conflicting polling', async () => {
    transport.route(tgPath('deleteWebhook'), () => ({
      ok: false,
      error_code: 400,
      description: 'Bad Request',
    }));
    await expect(upstream().deleteWebhook()).rejects.toMatchObject({ code: 'CHANNEL_ERROR' });
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
    const cursor = { offset: 0 };
    await upstream().getUpdates(cursor, controller.signal, async (update) => {
      received.push(update);
    });
    expect(received).toHaveLength(2);
    expect(cursor.offset).toBe(12);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('does not advance the offset when update handling fails', async () => {
    const controller = new AbortController();
    transport.route(tgPath('getUpdates'), () => ({
      ok: true,
      result: [{ update_id: 10, message: { message_id: 1, chat: { id: 1, type: 'private' }, text: 'a' } }],
    }));
    const cursor = { offset: 4 };

    await expect(
      upstream().getUpdates(cursor, controller.signal, async () => {
        throw new Error('dispatch failed');
      }),
    ).rejects.toThrow('dispatch failed');
    expect(cursor.offset).toBe(4);
  });

  it('getUpdates exits gracefully when the signal aborts', async () => {
    const controller = new AbortController();
    // Simulate the long-poll hang: each poll takes a few ms so the loop does
    // not microtask-spin while the test observes it.
    transport.route(tgPath('getUpdates'), async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, result: [] };
    });
    const promise = upstream().getUpdates({ offset: 0 }, controller.signal, async () => undefined);
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

  it('sendMessage maps reply and topic ids to official Bot API fields', async () => {
    transport.route(tgPath('sendMessage'), () => ({ ok: true, result: { message_id: 42 } }));
    await upstream().sendMessage('123', 'hello', { replyToMessageId: '40', messageThreadId: '9' });
    expect(transport.calls[0]?.init?.body).toEqual({
      chat_id: '123',
      text: 'hello',
      reply_parameters: { message_id: 40 },
      message_thread_id: 9,
    });
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

  it('editMessageText includes both chat_id and message_id', async () => {
    transport.route(tgPath('editMessageText'), () => ({ ok: true, result: { message_id: 42 } }));
    await upstream().editMessageText('123', '42', 'updated');
    expect(transport.calls[0]?.init?.body).toEqual({
      chat_id: '123',
      message_id: 42,
      text: 'updated',
    });
  });

  it('uploads localData as multipart with reply and topic fields', async () => {
    transport.route(tgPath('sendDocument'), () => ({ ok: true, result: { message_id: 7 } }));
    await upstream().sendMedia(
      '123',
      {
        type: 'file',
        localData: new Uint8Array([1, 2, 3]),
        mimeType: 'application/pdf',
        name: 'report.pdf',
        caption: 'report',
      },
      { replyToMessageId: '41', messageThreadId: '9' },
    );
    const form = transport.calls[0]?.init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('chat_id')).toBe('123');
    expect(form.get('caption')).toBe('report');
    expect(form.get('reply_parameters')).toBe('{"message_id":41}');
    expect(form.get('message_thread_id')).toBe('9');
    const document = form.get('document') as File;
    expect(document.name).toBe('report.pdf');
    expect(document.type).toBe('application/pdf');
    expect(Array.from(new Uint8Array(await document.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it('FetchTransport preserves FormData and lets fetch set the multipart boundary', async () => {
    let captured: RequestInit | undefined;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured = init;
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    const real = new FetchTransport('https://api.telegram.org', { timeoutMs: 1000, fetchImpl });
    const form = new FormData();
    form.append('chat_id', '123');
    await real.request('/upload', { method: 'POST', body: form });
    expect(captured?.body).toBe(form);
    expect(new Headers(captured?.headers).has('content-type')).toBe(false);
  });

  it('FetchTransport preserves binary response metadata for attachment ingestion', async () => {
    const fetchImpl = (async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-disposition': 'attachment; filename="photo.png"',
      },
    })) as typeof fetch;
    const real = new FetchTransport('https://api.telegram.org', { timeoutMs: 1000, fetchImpl });

    await expect(real.requestBinary('/file/botTEST/photos/photo.png')).resolves.toEqual({
      data: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
      contentDisposition: 'attachment; filename="photo.png"',
    });
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

  it('does not deduplicate an update whose first emit failed', async () => {
    const service = new ChannelService(new Context());
    const base = createTestContext(service);
    const emit = vi.fn()
      .mockRejectedValueOnce(new Error('temporary dispatch failure'))
      .mockResolvedValue(undefined);
    const processor = new InboundProcessor({
      ctx: { ...base, emit },
      meta: { channel: 'telegram' as never, accountId: 'main' as never },
      dedupEnabled: true,
      dedupWindowMs: 5000,
      now: () => 1000,
    });
    const raw = {
      update_id: 501,
      message: { message_id: 4, chat: { id: 1, type: 'private' }, from: { id: 2 }, text: 'retry' },
    };
    await expect(processor.handle(raw)).rejects.toThrow('temporary dispatch failure');
    await expect(processor.handle(raw)).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('dispatches photos from one media group as independent hydrated updates', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const files = {
      downloadFile: vi.fn(async (fileId: string) => ({
        data: new TextEncoder().encode(fileId),
        mimeType: 'image/jpeg',
        name: `${fileId}.jpg`,
      })),
    };
    const processor = new InboundProcessor({
      ctx,
      meta: { channel: 'telegram' as never, accountId: 'main' as never },
      dedupEnabled: true,
      dedupWindowMs: 5000,
      files,
    });
    const received: MessageReceived[] = [];
    service.on((event) => {
      if (event.type === 'message.received') received.push(event);
    });

    for (const [updateId, messageId, fileId, caption] of [
      [701, 801, 'ALBUM_PHOTO_1', 'album caption'],
      [702, 802, 'ALBUM_PHOTO_2', undefined],
    ] as const) {
      await processor.handle({
        update_id: updateId,
        message: {
          message_id: messageId,
          media_group_id: 'album-1',
          chat: { id: 1, type: 'private' },
          from: { id: 2, first_name: 'Alice' },
          photo: [{ file_id: fileId, width: 640, height: 640 }],
          ...(caption ? { caption } : {}),
        },
      });
    }

    expect(received.map((event) => event.message.id)).toEqual(['801', '802']);
    expect(received[0]?.message.content.map((part) => part.type)).toEqual(['text', 'image']);
    expect(received[1]?.message.content.map((part) => part.type)).toEqual(['image']);
    expect(files.downloadFile).toHaveBeenNthCalledWith(1, 'ALBUM_PHOTO_1', ctx.signal);
    expect(files.downloadFile).toHaveBeenNthCalledWith(2, 'ALBUM_PHOTO_2', ctx.signal);
    for (const event of received) {
      const image = event.message.content.find((part) => part.type === 'image');
      expect(image).toMatchObject({ mimeType: 'image/jpeg' });
      expect(image?.localData?.byteLength).toBeGreaterThan(0);
    }
  });

  it('preserves document metadata from the Telegram message during hydration', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const processor = new InboundProcessor({
      ctx,
      meta: { channel: 'telegram' as never, accountId: 'main' as never },
      dedupEnabled: true,
      dedupWindowMs: 5000,
      files: {
        downloadFile: vi.fn(async () => ({
          data: new Uint8Array([1, 2, 3]),
          mimeType: 'application/octet-stream',
          name: 'generated-from-file-path.bin',
        })),
      },
    });
    const received: MessageReceived[] = [];
    service.on((event) => {
      if (event.type === 'message.received') received.push(event);
    });

    await processor.handle({
      update_id: 703,
      message: {
        message_id: 803,
        chat: { id: 1, type: 'private' },
        from: { id: 2 },
        document: {
          file_id: 'DOCUMENT_WITH_METADATA',
          file_name: 'report.pdf',
          mime_type: 'application/pdf',
        },
      },
    });

    expect(received[0]?.message.content).toContainEqual(expect.objectContaining({
      type: 'file',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      size: 3,
      localData: new Uint8Array([1, 2, 3]),
    }));
  });
});

describe('TelegramStreamingReply', () => {
  it('caps edits at 4096 characters and sends overflow chunks when finishing', async () => {
    const transport = new FakeTransport();
    transport.route(tgPath('sendMessage'), () => ({ ok: true, result: { message_id: 42 } }));
    transport.route(tgPath('editMessageText'), () => ({ ok: true, result: { message_id: 42 } }));
    const upstream = new HttpTelegramUpstream({ transport, token: TOKEN, longPollTimeoutMs: 500 });
    const reply = new TelegramStreamingReply(upstream, {
      channelId: 'telegram' as never,
      accountId: 'main' as never,
      conversationId: '123' as never,
      threadId: '9' as never,
      replyToMessageId: '41' as never,
    });
    await reply.start();
    const text = 'x'.repeat(4096) + 'tail';
    await reply.replace({ text });
    await reply.finish({ text });

    const initial = transport.calls[0]?.init?.body;
    expect(initial).toEqual({
      chat_id: '123',
      text: '…',
      reply_parameters: { message_id: 41 },
      message_thread_id: 9,
    });
    const edit = transport.calls.find((call) => call.path === tgPath('editMessageText'))?.init?.body as {
      chat_id: string; message_id: number; text: string;
    };
    expect(edit.chat_id).toBe('123');
    expect(edit.message_id).toBe(42);
    expect(edit.text).toHaveLength(4096);
    const overflow = transport.calls.filter((call) => call.path === tgPath('sendMessage'))[1]?.init?.body;
    expect(overflow).toEqual({ chat_id: '123', text: 'tail', message_thread_id: 9 });
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
    transport.route(tgPath('deleteWebhook'), () => ({ ok: true, result: true }));
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
    await vi.waitFor(async () => {
      expect((await a.getHealth()).status).toBe('ok');
      expect((await a.getHealth()).authenticated).toBe(true);
    });

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

    await a.stop();
    await a.stop(); // idempotent
  });

  it('deletes a webhook before polling and reports connected only after a successful poll', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    routeAuth();
    let releasePoll!: () => void;
    let polls = 0;
    transport.route(tgPath('getUpdates'), async (_init, signal) => {
      polls += 1;
      if (polls === 1) {
        await new Promise<void>((resolve) => {
          releasePoll = resolve;
        });
        return { ok: true, result: [] };
      }
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    const states: string[] = [];
    service.on((event) => {
      if (event.type === 'connection.changed') states.push(event.state);
    });

    const a = adapter({ token: TOKEN });
    await a.start(ctx);
    expect(transport.calls.map((call) => call.path).slice(0, 3)).toEqual([
      tgPath('getMe'),
      tgPath('deleteWebhook'),
      tgPath('getUpdates'),
    ]);
    expect(states).toEqual(['connecting']);
    expect((await a.getHealth()).status).toBe('down');

    releasePoll();
    await vi.waitFor(() => expect(states).toContain('connected'));
    expect((await a.getHealth()).status).toBe('ok');
    await a.stop();
  });

  it('retries a failed inbound update from the same offset before acknowledging it', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    routeAuth();
    const offsets: number[] = [];
    let polls = 0;
    transport.route(tgPath('getUpdates'), async (init) => {
      offsets.push((init?.body as { offset: number }).offset);
      polls += 1;
      if (polls <= 2) {
        return {
          ok: true,
          result: [{
            update_id: 50,
            message: { message_id: 5, chat: { id: 1, type: 'private' }, text: 'retry me' },
          }],
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ok: true, result: [] };
    });
    let attempts = 0;
    service.on(async (event) => {
      if (event.type !== 'message.received') return;
      attempts += 1;
      if (attempts === 1) throw new Error('temporary bridge failure');
    });

    const a = adapter({
      token: TOKEN,
      reconnect: { enabled: true, baseDelayMs: 1, maxDelayMs: 1, maxRetries: 2 },
    });
    await a.start(ctx);
    await vi.waitFor(() => expect(attempts).toBe(2));
    await vi.waitFor(() => expect(offsets).toContain(51));
    expect(offsets.slice(0, 3)).toEqual([0, 0, 51]);
    await a.stop();
  });

  it('stop aborts an in-flight poll without disposing the owning context', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    routeAuth();
    let observedSignal: AbortSignal | undefined;
    transport.route(tgPath('getUpdates'), (_init, signal) => {
      observedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    });
    const a = adapter({ token: TOKEN });
    await a.start(ctx);
    await vi.waitFor(() => expect(observedSignal).toBeDefined());

    await expect(a.stop()).resolves.toBeUndefined();
    expect(observedSignal?.aborted).toBe(true);
    expect(ctx.signal.aborted).toBe(false);
    await expect(a.stop()).resolves.toBeUndefined();
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

  it('send with a resourceRef media part resolves the file_id to sendPhoto', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    routeAuth();
    transport.route(tgPath('sendPhoto'), () => ({ ok: true, result: { message_id: 11 } }));
    const a = adapter({ token: TOKEN });
    await a.start(ctx);
    const result = await a.send(makeChannelTarget(), {
      text: 'look at this',
      parts: [{ type: 'image', resourceRef: 'ANON_FILE_ID', alt: 'photo' }],
    });
    expect(result.delivered).toBe(true);
    const call = transport.calls.find((c) => c.path === tgPath('sendPhoto'));
    expect(call?.init?.body).toEqual({
      chat_id: 'conv-1',
      photo: 'ANON_FILE_ID',
      caption: 'look at this',
    });
    await a.stop();
  });

  it('send uploads localData instead of degrading to an empty text message', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    routeAuth();
    transport.route(tgPath('sendDocument'), () => ({ ok: true, result: { message_id: 12 } }));
    const a = adapter({ token: TOKEN });
    await a.start(ctx);
    const result = await a.send(makeChannelTarget(), {
      parts: [{
        type: 'file',
        localData: new Uint8Array([5, 6]),
        name: 'note.txt',
        mimeType: 'text/plain',
      }],
    });
    expect(result.delivered).toBe(true);
    const call = transport.calls.find((item) => item.path === tgPath('sendDocument'));
    expect(call?.init?.body).toBeInstanceOf(FormData);
    expect(transport.calls.some((item) => item.path === tgPath('sendMessage'))).toBe(false);
    await a.stop();
  });

  it('fails closed when a media part has no supported outbound carrier', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    routeAuth();
    const a = adapter({ token: TOKEN });
    await a.start(ctx);
    await expect(a.send(makeChannelTarget(), {
      text: 'must not silently drop attachment',
      parts: [{ type: 'file', dataUri: 'data:text/plain;base64,aGk=' }],
    })).rejects.toMatchObject({ code: 'CHANNEL_SEND_FAILED' });
    expect(transport.calls.some((item) => item.path === tgPath('sendMessage'))).toBe(false);
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
    expect(inject).toEqual(['channels', 'credentials']);
    expect(apply).toBeTypeOf('function');
  });

  it('exposes an upstream compatibility manifest', () => {
    expect(manifest).toMatchObject({ id: 'telegram', adapterVersion: '0.4.0', status: 'experimental' });
    expect(manifest.upstream.strategy).toBe('source');
    expect(manifest.upstream.reference).toContain('core.telegram.org');
  });

  it('adapter contract suite passes', () => {
    const transport = new FakeTransport();
    transport.route(tgPath('getMe'), () => ({
      ok: true,
      result: { id: 1, is_bot: true, first_name: 'ProofBot', username: 'proof_bot' },
    }));
    transport.route(tgPath('deleteWebhook'), () => ({ ok: true, result: true }));
    transport.route(tgPath('sendMessage'), () => ({ ok: true, result: { message_id: 1 } }));
    transport.route(tgPath('sendPhoto'), () => ({ ok: true, result: { message_id: 2 } }));
    transport.route(tgPath('sendDocument'), () => ({ ok: true, result: { message_id: 3 } }));
    transport.route(tgPath('sendAudio'), () => ({ ok: true, result: { message_id: 4 } }));
    transport.route(tgPath('sendVideo'), () => ({ ok: true, result: { message_id: 5 } }));
      transport.route(tgPath('getUpdates'), async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: true, result: [] };
      });
    runChannelAdapterContract(new TelegramAdapter(makeConfig({ token: TOKEN }), { transport }));
  });
});