import { describe, expect, it, vi } from 'vitest';
import {
  ChannelService,
  ChannelDuplicateError,
  ChannelError,
  ChannelNotStartedError,
  toChannelError,
  isChannelError,
  conversationKey,
  collectText,
  textParts,
  BufferedReply,
  defineChannelAdapter,
  isChannelAdapter,
  type ChannelAdapter,
  type ChannelAdapterContext,
  type MessageReceived,
  type ChannelEvent,
} from '../src/index.js';
import { Context } from '@deepseek-ai/cordis';

const capabilities = {
  text: true,
  image: false,
  file: false,
  audio: false,
  video: false,
  markdown: true,
  cards: false,
  reactions: false,
  threads: false,
  streaming: 'buffered',
} as const;

function makeAdapter(id: string): ChannelAdapter {
  return defineChannelAdapter({
    id,
    capabilities,
    async start() {},
    async stop() {},
    async send() {
      return { delivered: true };
    },
  });
}

describe('identity / conversationKey', () => {
  it('produces channel:account:conversation[:thread] keys', () => {
    expect(
      conversationKey({
        channelId: 'weixin' as never,
        accountId: 'main' as never,
        conversationId: 'user_123' as never,
      }),
    ).toBe('weixin:main:user_123');

    expect(
      conversationKey({
        channelId: 'lark' as never,
        accountId: 'tenant01' as never,
        conversationId: 'chat_oc_x' as never,
        threadId: 'thread_y' as never,
      }),
    ).toBe('lark:tenant01:chat_oc_x:thread_y');
  });
});

describe('structured messages', () => {
  it('collects plain text and skips non-text parts', () => {
    const parts = [
      { type: 'text' as const, text: 'hello ' },
      { type: 'image' as const, url: 'https://example.com/a.png' },
      { type: 'text' as const, text: 'world' },
    ];
    expect(collectText(parts)).toBe('hello world');
    expect(textParts('hi')).toEqual([{ type: 'text', text: 'hi' }]);
  });
});

describe('ChannelService (Cordis Service)', () => {
  it('is registered as ctx.channels with register/get/list', () => {
    const ctx = new Context();
    const service = new ChannelService(ctx);
    // `ctx.channels` resolves through the cordis context proxy; assert the
    // service surface rather than reference identity.
    expect(ctx.channels.name).toBe('channels');
    expect(ctx.channels).toBeInstanceOf(ChannelService);
    expect(service.name).toBe('channels');

    const unregister = ctx.channels.register(makeAdapter('weixin'));
    expect(ctx.channels.get('weixin')?.id).toBe('weixin');
    expect(ctx.channels.list().map((a) => a.id)).toEqual(['weixin']);

    unregister();
    expect(ctx.channels.get('weixin')).toBeUndefined();
    expect(ctx.channels.list()).toHaveLength(0);
  });

  it('fails loudly on duplicate adapter ids', () => {
    const ctx = new Context();
    new ChannelService(ctx);
    ctx.channels.register(makeAdapter('qq'));
    expect(() => ctx.channels.register(makeAdapter('qq'))).toThrow(ChannelDuplicateError);
  });

  it('dispatches events to typed listeners and removes them on dispose', async () => {
    const ctx = new Context();
    new ChannelService(ctx);

    const listener = vi.fn();
    const dispose = ctx.channels.on(listener);

    const event = {
      type: 'message.received',
      channel: 'weixin',
      accountId: 'main',
      conversation: { id: 'c1', type: 'dm' },
      sender: { id: 'u1' },
      message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] },
    } satisfies MessageReceived;

    await ctx.channels.emit(event);
    expect(listener).toHaveBeenCalledWith(event);

    dispose();
    await ctx.channels.emit(event);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates listener failures and surfaces the first rejection from emit', async () => {
    const ctx = new Context();
    new ChannelService(ctx);

    const calls: string[] = [];
    const syncError = new Error('sync listener boom');
    const asyncError = new Error('async listener boom');
    const disposeSync = ctx.channels.on(() => {
      calls.push('sync');
      throw syncError;
    });
    const disposeAsync = ctx.channels.on(async () => {
      calls.push('async');
      throw asyncError;
    });
    const disposeOk = ctx.channels.on(() => {
      calls.push('ok');
    });

    const event = {
      type: 'message.received',
      channel: 'weixin',
      accountId: 'main',
      conversation: { id: 'c1', type: 'dm' },
      sender: { id: 'u1' },
      message: { id: 'm2', content: [{ type: 'text', text: 'hi' }] },
    } satisfies MessageReceived;

    // A sync throw and an async rejection must not break the other listeners;
    // emit rejects with the first (sync) error.
    await expect(ctx.channels.emit(event)).rejects.toBe(syncError);
    expect(calls).toEqual(['sync', 'async', 'ok']);

    // After removing the failing listeners, emit resolves again.
    disposeSync();
    disposeAsync();
    disposeOk();
    await expect(ctx.channels.emit(event)).resolves.toBeUndefined();
  });

  it('propagates async listener rejections to the emit caller', async () => {
    const ctx = new Context();
    new ChannelService(ctx);

    const asyncError = new Error('async rejection boom');
    const dispose = ctx.channels.on(async () => {
      throw asyncError;
    });

    const event = {
      type: 'message.received',
      channel: 'weixin',
      accountId: 'main',
      conversation: { id: 'c1', type: 'dm' },
      sender: { id: 'u1' },
      message: { id: 'm3', content: [{ type: 'text', text: 'hi' }] },
    } satisfies MessageReceived;

    await expect(ctx.channels.emit(event)).rejects.toBe(asyncError);
    dispose();
  });
});

describe('BufferedReply', () => {
  it('accumulates deltas and delivers once on finish', async () => {
    const deliver = vi.fn(async () => ({ delivered: true }));
    const reply = new BufferedReply({ deliver });
    await reply.append('hello ');
    await reply.append('world');
    await reply.finish();
    expect(deliver).toHaveBeenCalledWith('hello world');
  });

  it('discards content on fail and ignores later writes', async () => {
    const deliver = vi.fn(async () => ({ delivered: true }));
    const reply = new BufferedReply({ deliver });
    await reply.append('partial');
    await reply.fail();
    await reply.append('more');
    await reply.finish();
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('adapter helpers and errors', () => {
  it('defineChannelAdapter / isChannelAdapter round-trip', () => {
    const adapter = makeAdapter('lark');
    expect(isChannelAdapter(adapter)).toBe(true);
    expect(isChannelAdapter({ id: 'x' })).toBe(false);
  });

  it('maps unknown thrown values to stable codes', () => {
    const error = toChannelError(new Error('boom'), 'CHANNEL_SEND_FAILED');
    expect(error).toBeInstanceOf(ChannelError);
    expect(error.code).toBe('CHANNEL_SEND_FAILED');
    expect(isChannelError(error, 'CHANNEL_SEND_FAILED')).toBe(true);
    expect(isChannelError(error, 'CHANNEL_START_FAILED')).toBe(false);

    const start = new ChannelNotStartedError('not started');
    expect(isChannelError(start)).toBe(true);
  });
});
