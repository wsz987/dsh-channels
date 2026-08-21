/**
 * Interaction + rich streaming tests (plan §20.2 / §20.4 / §20.5).
 *
 * Covers callback_query → interaction.received mapping (untrusted data echoed as
 * the action, never interpreted), answerCallbackQuery ACK, InlineKeyboardMarkup
 * mapping with the 64-byte callback_data gate, adapter.edit(), and the native
 * rich draft → final streaming flow.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, ChannelError, type InteractionReceived, type OutboundMessage } from '@wsz987/channel-core';
import { makeChannelTarget, createTestContext } from '@wsz987/channel-testkit';
import {
  Config,
  TelegramAdapter,
  InboundProcessor,
  HttpTelegramUpstream,
  TelegramApiError,
  TelegramRichStreamingReply,
  mapCallbackQuery,
  isCallbackQueryUpdate,
  actionsToReplyMarkup,
  createTelegramDefinition,
} from '../src/index.ts';
import type { HttpTransport, HttpRequestInit } from '../src/index.ts';
import type { TelegramConfig } from '../src/config.ts';

const TOKEN = 'TEST_BOT_TOKEN_123';
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
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
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
    reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
    dedup: { enabled: true, windowMs: 5000 },
    streaming: { enabled: true, placeholder: '…' },
    maxDownloadBytes: 20 * 1024 * 1024,
    ...overrides,
  });
}

const CALLBACK_UPDATE = {
  update_id: 900,
  callback_query: {
    id: 'cq_123',
    from: { id: 100200300, first_name: 'Alice', is_bot: false },
    message: { message_id: 501, chat: { id: 100200300, type: 'private' } },
    data: 'action-opaque-token',
    chat_instance: 'x',
  },
};

const META = { channel: 'telegram' as never, accountId: 'main' as never };

describe('callback_query -> interaction.received', () => {
  it('isCallbackQueryUpdate discriminates callback updates', () => {
    expect(isCallbackQueryUpdate(CALLBACK_UPDATE)).toBe(true);
    expect(isCallbackQueryUpdate({ update_id: 1, message: { message_id: 1, text: 'hi' } })).toBe(false);
    expect(isCallbackQueryUpdate({ callback_query: { id: 5 } })).toBe(false); // malformed: id not string
  });

  it('maps a callback query to an interaction with action = callback_data', () => {
    const event = mapCallbackQuery(CALLBACK_UPDATE, META);
    expect(event.type).toBe('interaction.received');
    expect(event.interactionId).toBe('cq_123');
    expect(event.action).toBe('action-opaque-token');
    expect(event.conversation).toEqual({ id: '100200300', type: 'dm' });
    expect(event.sender).toEqual({ id: '100200300', name: 'Alice' });
    expect(event.raw).toBe(CALLBACK_UPDATE);
  });

  it('never lets the adapter parse callback_data (echoed verbatim)', () => {
    const data = 'dshq:abc:0:1';
    const event = mapCallbackQuery({ ...CALLBACK_UPDATE, callback_query: { ...CALLBACK_UPDATE.callback_query, data } }, META);
    expect(event.action).toBe(data);
    // The event carries no harness-specific interpretation.
    expect((event as InteractionReceived).value).toBeUndefined();
  });

  it('fails closed on a malformed callback payload (no fabricated event)', () => {
    expect(() => mapCallbackQuery({ callback_query: { id: 5 } }, META)).toThrow();
    expect(() => mapCallbackQuery('not-an-object', META)).toThrow();
  });
});

describe('InboundProcessor callback handling', () => {
  it('ACKs best-effort and emits interaction.received', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const ackCallback = vi.fn(async () => undefined);
    const processor = new InboundProcessor({
      ctx,
      meta: META,
      dedupEnabled: false,
      dedupWindowMs: 0,
      ackCallback,
    });
    const interaction: InteractionReceived[] = [];
    service.on((event) => {
      if (event.type === 'interaction.received') interaction.push(event);
    });

    await processor.handle(CALLBACK_UPDATE);
    expect(ackCallback).toHaveBeenCalledWith('cq_123');
    expect(interaction).toHaveLength(1);
    expect(interaction[0]!.action).toBe('action-opaque-token');
  });

  it('an ACK failure does not block the interaction emit', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const processor = new InboundProcessor({
      ctx,
      meta: META,
      dedupEnabled: false,
      dedupWindowMs: 0,
      ackCallback: async () => {
        throw new Error('ack boom');
      },
    });
    const interaction: InteractionReceived[] = [];
    service.on((event) => {
      if (event.type === 'interaction.received') interaction.push(event);
    });
    await processor.handle(CALLBACK_UPDATE);
    expect(interaction).toHaveLength(1); // ACK failed but the interaction still arrives
  });
});

describe('answerCallbackQuery upstream', () => {
  it('posts the callback_query_id', async () => {
    const transport = new FakeTransport();
    transport.route(tgPath('answerCallbackQuery'), () => ({ ok: true, result: true }));
    const upstream = new HttpTelegramUpstream({ transport, token: TOKEN, longPollTimeoutMs: 500 });
    await upstream.answerCallbackQuery({ callback_query_id: 'cq_123' });
    expect(transport.calls[0]?.path).toBe(tgPath('answerCallbackQuery'));
    expect(transport.calls[0]?.init?.body).toEqual({ callback_query_id: 'cq_123' });
  });
});

describe('Bot API 10.2 rich wire shape', () => {
  it('uses rich_message.markdown and a non-zero integer draft_id', async () => {
    const transport = new FakeTransport();
    transport.route(tgPath('sendRichMessage'), () => ({ ok: true, result: { message_id: 1 } }));
    transport.route(tgPath('sendRichMessageDraft'), () => ({ ok: true, result: true }));
    transport.route(tgPath('editMessageText'), () => ({ ok: true, result: true }));
    const upstream = new HttpTelegramUpstream({ transport, token: TOKEN, longPollTimeoutMs: 500 });

    await upstream.sendRichMessage('123', { markdown: '**final**' });
    await upstream.sendRichMessageDraft('123', 77, { markdown: '**partial' });
    await upstream.editMessageRich('123', '9', { markdown: '**edited**' });

    expect(transport.calls[0]?.init?.body).toEqual({
      chat_id: '123',
      rich_message: { markdown: '**final**' },
    });
    expect(transport.calls[1]?.init?.body).toEqual({
      chat_id: 123,
      draft_id: 77,
      rich_message: { markdown: '**partial' },
    });
    expect(transport.calls[2]?.init?.body).toEqual({
      chat_id: '123',
      message_id: 9,
      rich_message: { markdown: '**edited**' },
    });
  });
});

describe('InlineKeyboardMarkup + callback_data gate', () => {
  it('maps action rows to inline_keyboard rows with styles', () => {
    const markup = actionsToReplyMarkup([
      { actions: [{ id: 'a1', label: 'One' }, { id: 'a2', label: 'Two', style: 'danger' }] },
      { actions: [{ id: 'b1', label: 'Three', style: 'primary' }] },
    ]);
    expect(markup).toEqual({
      inline_keyboard: [
        [
          { text: 'One', callback_data: 'a1' },
          { text: 'Two', callback_data: 'a2', style: 'danger' },
        ],
        [{ text: 'Three', callback_data: 'b1', style: 'primary' }],
      ],
    });
  });

  it('returns undefined for no actions', () => {
    expect(actionsToReplyMarkup(undefined)).toBeUndefined();
    expect(actionsToReplyMarkup([])).toBeUndefined();
  });

  it('fails closed when an action id exceeds 64 bytes', () => {
    const tooLong = 'x'.repeat(65);
    expect(() =>
      actionsToReplyMarkup([{ actions: [{ id: tooLong, label: 'L' }] }]),
    ).toThrow(/64-byte callback_data/);
  });
});

describe('Telegram definition formatting persistence', () => {
  it('saves, snapshots, and restores formatting as an independent nested config', async () => {
    const definition = createTelegramDefinition({
      config: makeConfig(),
      credentials: {
        resolve: async () => ({ value: TOKEN, source: 'test' }),
        describe: async () => ({ configured: true, writable: true }),
        set: async () => undefined,
      },
    });
    await definition.saveConfig({ formatting: { mode: 'html' } });
    const saved = definition.snapshotConfig() as TelegramConfig;
    expect(saved.formatting.mode).toBe('html');
    saved.formatting.mode = 'plain';
    expect((definition.snapshotConfig() as TelegramConfig).formatting.mode).toBe('html');

    await definition.restoreConfig({ ...makeConfig(), formatting: { mode: 'rich-markdown', fallback: 'plain' } });
    expect((definition.snapshotConfig() as TelegramConfig).formatting.mode).toBe('rich-markdown');
  });
});

describe('adapter.edit()', () => {
  let transport: FakeTransport;
  beforeEach(() => {
    transport = new FakeTransport();
  });

  function adapter(overrides: Partial<TelegramConfig> = {}): TelegramAdapter {
    return new TelegramAdapter(makeConfig(overrides), { transport, now: () => 1000 });
  }

  it('edits Markdown as a rich message by default', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    transport.route(tgPath('getMe'), () => ({ ok: true, result: { id: 1, is_bot: true } }));
    transport.route(tgPath('deleteWebhook'), () => ({ ok: true, result: true }));
    transport.route(tgPath('editMessageText'), () => ({ ok: true, result: true }));
    const a = adapter({ token: TOKEN });
    await a.start(ctx);
    const target = makeChannelTarget();
    await a.edit(target, '42', { text: 'updated' });
    const call = transport.calls.find((c) => c.path === tgPath('editMessageText'));
    expect(call?.init?.body).toEqual({
      chat_id: 'conv-1',
      message_id: 42,
      rich_message: { markdown: 'updated' },
    });
    await a.stop();
  });

  it('updates reply markup', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    transport.route(tgPath('getMe'), () => ({ ok: true, result: { id: 1, is_bot: true } }));
    transport.route(tgPath('deleteWebhook'), () => ({ ok: true, result: true }));
    transport.route(tgPath('editMessageReplyMarkup'), () => ({ ok: true, result: true }));
    const a = adapter({ token: TOKEN });
    await a.start(ctx);
    const target = makeChannelTarget();
    const msg: OutboundMessage = {
      actions: [{ actions: [{ id: 'a1', label: 'One' }] }],
    };
    await a.edit(target, '42', msg);
    const call = transport.calls.find((c) => c.path === tgPath('editMessageReplyMarkup'));
    expect(call?.init?.body).toMatchObject({
      chat_id: 'conv-1',
      message_id: 42,
      reply_markup: { inline_keyboard: [[{ text: 'One', callback_data: 'a1' }]] },
    });
    await a.stop();
  });

  it('clears reply markup when actions are explicitly empty', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    transport.route(tgPath('getMe'), () => ({ ok: true, result: { id: 1, is_bot: true } }));
    transport.route(tgPath('deleteWebhook'), () => ({ ok: true, result: true }));
    transport.route(tgPath('editMessageReplyMarkup'), () => ({ ok: true, result: true }));
    const a = adapter({ token: TOKEN });
    await a.start(ctx);
    await a.edit(makeChannelTarget(), '42', { actions: [] });
    const call = transport.calls.find((c) => c.path === tgPath('editMessageReplyMarkup'));
    expect(call?.init?.body).toEqual({
      chat_id: 'conv-1',
      message_id: 42,
      reply_markup: { inline_keyboard: [] },
    });
    await a.stop();
  });

  it('edits rich text and actions atomically through editMessageText', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    transport.route(tgPath('getMe'), () => ({ ok: true, result: { id: 1, is_bot: true } }));
    transport.route(tgPath('deleteWebhook'), () => ({ ok: true, result: true }));
    transport.route(tgPath('editMessageText'), () => ({ ok: true, result: true }));
    const a = adapter({ token: TOKEN });
    await a.start(ctx);
    await a.edit(makeChannelTarget(), '42', {
      text: 'updated',
      actions: [{ actions: [{ id: 'a1', label: 'One' }] }],
    });
    const call = transport.calls.find((c) => c.path === tgPath('editMessageText'));
    expect(call?.init?.body).toMatchObject({
      chat_id: 'conv-1',
      message_id: 42,
      rich_message: { markdown: 'updated' },
      reply_markup: { inline_keyboard: [[{ text: 'One', callback_data: 'a1' }]] },
    });
    await a.stop();
  });
});

describe('TelegramRichStreamingReply (native DM draft)', () => {
  function makeUpstream() {
    return {
      sendRichMessageDraft: vi.fn(async () => ({ message_id: 1 })),
      sendRichMessage: vi.fn(async () => ({ message_id: 2 })),
      sendMessage: vi.fn(async () => ({ messageId: '1', raw: {} })),
      editMessageText: vi.fn(async () => undefined),
      editMessageRich: vi.fn(async () => undefined),
    };
  }

  function makeReply(upstream: ReturnType<typeof makeUpstream>, draftId = 1234) {
    return new TelegramRichStreamingReply(
      upstream as never,
      { channelId: 'telegram' as never, accountId: 'main' as never, conversationId: '123' as never, conversationType: 'dm' },
      '…',
      { formatting: { mode: 'rich-markdown' } },
      draftId,
    );
  }

  it('opens a draft with a stable draft id and persists via sendRichMessage', async () => {
    const upstream = makeUpstream();
    const reply = makeReply(upstream, 77);
    await reply.start();
    expect(upstream.sendRichMessageDraft).toHaveBeenCalledWith(
      '123',
      77,
      { markdown: '…' },
      expect.anything(),
    );
    await reply.replace({ text: '## Partial' });
    expect(upstream.sendRichMessageDraft).toHaveBeenLastCalledWith(
      '123',
      77,
      { markdown: '## Partial' },
      expect.anything(),
    );
    await reply.finish({ text: '## Final' });
    expect(upstream.sendRichMessage).toHaveBeenCalledWith('123', { markdown: '## Final' }, expect.anything());
  });

  it('final falls back to plain exactly once on a rich format error', async () => {
    const upstream = makeUpstream();
    upstream.sendRichMessage.mockImplementationOnce(async () => {
      throw Object.assign(new Error('entity too long'), { kind: 'format' });
    });
    const reply = makeReply(upstream, 77);
    await reply.start();
    await reply.finish({ text: '## Final' });
    // first rich attempt failed; the fallback resends as plain text.
    expect(upstream.sendRichMessage).toHaveBeenCalledTimes(1);
    expect(upstream.sendMessage).toHaveBeenCalledWith('123', 'Final', expect.anything(), undefined);
  });

  it('coalesces rich draft updates while Telegram rate-limits the stream', async () => {
    vi.useFakeTimers();
    try {
      const upstream = makeUpstream();
      upstream.sendRichMessageDraft
        .mockResolvedValueOnce({ message_id: 1 })
        .mockRejectedValueOnce(new TelegramApiError({
          method: 'sendRichMessageDraft',
          errorCode: 429,
          description: 'Too Many Requests: retry after 62',
          parameters: { retryAfter: 62 },
        }));
      const reply = makeReply(upstream, 77);
      await reply.start();
      await reply.replace({ text: 'first' });
      await reply.replace({ text: 'latest' });

      expect(upstream.sendRichMessageDraft).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(62_000);

      expect(upstream.sendRichMessageDraft).toHaveBeenCalledTimes(3);
      expect(upstream.sendRichMessageDraft).toHaveBeenLastCalledWith(
        '123',
        77,
        { markdown: 'latest' },
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('interaction mapper via adapter receive loop', () => {
  let transport: FakeTransport;
  beforeEach(() => {
    transport = new FakeTransport();
  });
  function adapter(overrides: Partial<TelegramConfig> = {}): TelegramAdapter {
    return new TelegramAdapter(makeConfig(overrides), { transport, now: () => 1000 });
  }

  it('emits interaction.received from a callback_query update', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    transport.route(tgPath('getMe'), () => ({ ok: true, result: { id: 1, is_bot: true } }));
    transport.route(tgPath('deleteWebhook'), () => ({ ok: true, result: true }));
    transport.route(tgPath('answerCallbackQuery'), () => ({ ok: true, result: true }));
    let polls = 0;
    transport.route(tgPath('getUpdates'), async () => {
      polls += 1;
      if (polls === 2) return { ok: true, result: [CALLBACK_UPDATE] };
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, result: [] };
    });
    const interactions: InteractionReceived[] = [];
    service.on((event) => {
      if (event.type === 'interaction.received') interactions.push(event);
    });
    const a = adapter({ token: TOKEN });
    await a.start(ctx);
    await vi.waitFor(() => expect(interactions).toHaveLength(1), { timeout: 2000 });
    expect(interactions[0]!.action).toBe('action-opaque-token');
    expect(transport.calls.some((c) => c.path === tgPath('answerCallbackQuery'))).toBe(true);
    await a.stop();
  });
});
