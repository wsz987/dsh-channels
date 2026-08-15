/**
 * M2A: DingTalk native image ingress hydration (plan §32A / §79A).
 *
 * Covers the `InboundProcessor` image-hydration step: a fake secure
 * fetcher turns a genuine http(s) picUrl into `localData` + `mimeType` on
 * the emitted `MessageReceived`, failure paths annotate `ingressFailure`
 * without blocking text delivery, an opaque mediaId is deferred to
 * `resourceRef` with no fetch attempted, and the fetcher receives the
 * picUrl and the adapter-context AbortSignal. Fully offline.
 */
import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  BodyTooLargeError,
  ChannelService,
  RemoteMediaError,
  UnsafeHostError,
  type MessageReceived,
} from '@wsz987/channel-core';
import { createTestContext } from '@wsz987/channel-testkit';
import { InboundProcessor } from '../src/index.ts';
import type { MediaResolverLike, RemoteMediaFetchLike } from '../src/index.ts';

/** Construct the inbound processor with an injected fake secure fetcher. */
function makeProcessor(secureFetch: RemoteMediaFetchLike, signal: AbortSignal, resolveMedia?: MediaResolverLike) {
  const service = new ChannelService(new Context());
  const ctx = createTestContext(service);
  // The context owns its own signal; override with the caller-provided one so
  // tests can assert the signal is threaded through to the fetcher.
  Object.defineProperty(ctx, 'signal', { value: signal, configurable: true });
  const processor = new InboundProcessor({
    ctx,
    meta: { channel: 'dingtalk' as never, accountId: 'main' as never },
    dedupEnabled: false,
    dedupWindowMs: 5000,
    secureFetch,
    resolveMedia,
  });
  return { processor, service, ctx };
}

/** A fake secure fetcher that records calls and returns one bounded result. */
function okFetcher(): {
  fetcher: RemoteMediaFetchLike;
  calls: { url: string; options: { maxBytes: number; idleTimeoutMs?: number; signal?: AbortSignal } }[];
} {
  const calls: { url: string; options: { maxBytes: number; idleTimeoutMs?: number; signal?: AbortSignal } }[] = [];
  const fetcher: RemoteMediaFetchLike = {
    async fetchBounded(url, options) {
      calls.push({
        url,
        options: {
          maxBytes: options.maxBytes,
          idleTimeoutMs: options.idleTimeoutMs,
          signal: options.signal,
        },
      });
      return { data: new Uint8Array([1, 2, 3]), mimeType: 'image/png', finalUrl: url };
    },
  };
  return { fetcher, calls };
}

/** Shorthand to install a one-shot throwing fetch implementation. */
function rejectFetcher(impl: (url: string) => Error | Promise<never>): RemoteMediaFetchLike {
  return {
    async fetchBounded(url) {
      const error = impl(url);
      if (error instanceof Error) {
        throw error; // covers both the sync-throw and awaited Promise<never> shapes
      }
      throw error;
    },
  };
}

describe('InboundProcessor image hydration (M2A)', () => {
  it('fetches a genuine picUrl and emits localData + mimeType on the part', async () => {
    const { fetcher, calls } = okFetcher();
    const controller = new AbortController();
    const { processor, service, ctx } = makeProcessor(fetcher, controller.signal);
    const received: MessageReceived[] = [];
    service.on((event) => { if (event.type === 'message.received') received.push(event); });

    await processor.handle({
      type: 'image', msgId: 'm1', senderId: 'u1', conversationId: 'c1',
      picUrl: 'https://dingtalk.example/pic.png',
    });

    expect(received).toHaveLength(1);
    const content = received[0]?.message.content;
    expect(content?.[0]).toMatchObject({
      type: 'image',
      url: 'https://dingtalk.example/pic.png',
      mimeType: 'image/png',
    });
    const part = content?.[0] as { localData?: Uint8Array };
    expect(part.localData).toBeDefined();
    expect(Array.from(part.localData!)).toEqual([1, 2, 3]);
    // Fetcher called exactly once with the picUrl.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://dingtalk.example/pic.png');
    await ctx.dispose();
  });

  it('threads the adapter-context AbortSignal into the fetcher', async () => {
    const { fetcher, calls } = okFetcher();
    const controller = new AbortController();
    const { processor, service, ctx } = makeProcessor(fetcher, controller.signal);
    const received: MessageReceived[] = [];
    service.on((event) => { if (event.type === 'message.received') received.push(event); });
    await processor.handle({ type: 'image', msgId: 'm2', senderId: 'u1', conversationId: 'c1', picUrl: 'https://dingtalk.example/a.png' });
    expect(calls[0]?.options.signal).toBe(controller.signal);
    expect(received).toHaveLength(1);
    await ctx.dispose();
  });

  it('too-large failure → keeps url, ingressFailure too-large, text still emitted', async () => {
    // Make the next fetch reject as over the cap.
    const { processor, service, ctx } = makeProcessor(
      rejectFetcher(() => new BodyTooLargeError(20 * 1024 * 1024, 'exceeds cap')),
      new AbortController().signal,
    );
    const received: MessageReceived[] = [];
    service.on((event) => { if (event.type === 'message.received') received.push(event); });

    await processor.handle({ type: 'image', msgId: 'm3', senderId: 'u1', conversationId: 'c1', picUrl: 'https://dingtalk.example/big.png' });

    expect(received).toHaveLength(1);
    const part = received[0]?.message.content[0] as Record<string, unknown>;
    expect(part).toMatchObject({
      type: 'image',
      url: 'https://dingtalk.example/big.png',
      ingressFailure: 'too-large',
    });
    expect(part.localData).toBeUndefined();
    await ctx.dispose();
  });

  it('unsafe-host failure → keeps url, ingressFailure resource-unavailable, text still emitted', async () => {
    const { processor, service, ctx } = makeProcessor(
      rejectFetcher(() => new UnsafeHostError('https://dingtalk.example/x.png', 'unsafe host')),
      new AbortController().signal,
    );
    const received: MessageReceived[] = [];
    service.on((event) => { if (event.type === 'message.received') received.push(event); });

    await processor.handle({ type: 'image', msgId: 'm4', senderId: 'u1', conversationId: 'c1', picUrl: 'https://dingtalk.example/x.png' });
    const part = received[0]?.message.content[0] as Record<string, unknown>;
    expect(part).toMatchObject({ type: 'image', url: 'https://dingtalk.example/x.png', ingressFailure: 'resource-unavailable' });
    expect(received).toHaveLength(1);
    await ctx.dispose();
  });

  it('network failure → keeps url, ingressFailure download-failed, text still emitted', async () => {
    const { processor, service, ctx } = makeProcessor(
      rejectFetcher(() => new RemoteMediaError('DOWNLOAD_FAILED', 'connection reset')),
      new AbortController().signal,
    );
    const received: MessageReceived[] = [];
    service.on((event) => { if (event.type === 'message.received') received.push(event); });
    await processor.handle({ type: 'image', msgId: 'm5', senderId: 'u1', conversationId: 'c1', picUrl: 'https://dingtalk.example/network.png' });
    const part = received[0]?.message.content[0] as Record<string, unknown>;
    expect(part).toMatchObject({ type: 'image', url: 'https://dingtalk.example/network.png', ingressFailure: 'download-failed' });
    expect(received).toHaveLength(1);
    await ctx.dispose();
  });

  it('image failure never blocks a sibling text part (text still emitted)', async () => {
    const { processor, service, ctx } = makeProcessor(
      rejectFetcher(() => new Error('network down')),
      new AbortController().signal,
    );
    const received: MessageReceived[] = [];
    service.on((event) => { if (event.type === 'message.received') received.push(event); });
    await processor.handle({ type: 'image', msgId: 'm6', senderId: 'u1', conversationId: 'c1', picUrl: 'https://dingtalk.example/img.png', title: 'chart' });
    expect(received).toHaveLength(1);
    const parts = received[0]?.message.content;
    expect(parts).toHaveLength(1);
    expect(parts?.[0]).toMatchObject({ type: 'image', ingressFailure: 'download-failed' });
    await ctx.dispose();
  });

  it('opaque mediaId-only locator → resourceRef set, no fetch attempted', async () => {
    const { fetcher, calls } = okFetcher();
    const { processor, service, ctx } = makeProcessor(fetcher, new AbortController().signal);
    const received: MessageReceived[] = [];
    service.on((event) => { if (event.type === 'message.received') received.push(event); });
    // A bare mediaId (not a URL) in the raw: the mapper puts it in url, the
    // hydrator must defer it to resourceRef and never call the fetcher.
    await processor.handle({ type: 'image', msgId: 'm7', senderId: 'u1', conversationId: 'c1', picUrl: 'mediaId_8829' });
    expect(received).toHaveLength(1);
    const part = received[0]?.message.content[0] as Record<string, unknown>;
    expect(part).toMatchObject({ type: 'image', resourceRef: 'mediaId_8829' });
    expect(part).not.toHaveProperty('url');
    expect(calls).toHaveLength(0); // no generic fetch for an opaque handle
    await ctx.dispose();
  });

  it('official picture payload (picMediaId + picDownloadCode) → resolved via the OpenAPI port into localData', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
    const resolveCalls: { ref: string; options?: Record<string, unknown> }[] = [];
    const resolver: MediaResolverLike = {
      async resolveMedia(ref, options) {
        resolveCalls.push({ ref, options });
        return { data: png, mimeType: 'image/png', size: png.byteLength };
      },
    };
    const { processor, service, ctx } = makeProcessor(okFetcher().fetcher, new AbortController().signal, resolver);
    const received: MessageReceived[] = [];
    service.on((event) => { if (event.type === 'message.received') received.push(event); });
    // Real gateway raw produced by stream-upstream.toGatewayRaw for a picture
    // message: picMediaId (opaque) + picDownloadCode + robotCode.
    await processor.handle({
      type: 'picture', msgId: 'm8', senderId: 'u1', conversationId: 'c1',
      picMediaId: '@lADP_1', picDownloadCode: 'dl-8', robotCode: 'rb-1',
    });
    expect(received).toHaveLength(1);
    const part = received[0]?.message.content[0] as Record<string, unknown>;
    expect(part).toMatchObject({ type: 'image', resourceRef: '@lADP_1', mimeType: 'image/png' });
    expect(part).not.toHaveProperty('url');
    expect(Array.from((part.localData as Uint8Array))).toEqual(Array.from(png));
    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]?.ref).toBe('@lADP_1');
    expect(resolveCalls[0]?.options).toMatchObject({ downloadCode: 'dl-8', robotCode: 'rb-1' });
    await ctx.dispose();
  });

  it('richText downloadCode images are independently hydrated', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]);
    const refs: string[] = [];
    const resolver: MediaResolverLike = {
      async resolveMedia(ref) {
        refs.push(ref);
        return { data: png, mimeType: 'image/png', size: png.byteLength };
      },
    };
    const { processor, service, ctx } = makeProcessor(okFetcher().fetcher, new AbortController().signal, resolver);
    const received: MessageReceived[] = [];
    service.on((event) => { if (event.type === 'message.received') received.push(event); });
    await processor.handle({
      type: 'richText', msgId: 'm-rich', senderId: 'u1', conversationId: 'c1', content: 'caption',
      richTextImages: [{ downloadCode: 'dl-rich-1' }, { downloadCode: 'dl-rich-2' }],
    });
    expect(received).toHaveLength(1);
    const images = received[0]?.message.content.filter((part) => part.type === 'image') ?? [];
    expect(images).toHaveLength(2);
    expect(refs).toEqual(['downloadCode:dl-rich-1', 'downloadCode:dl-rich-2']);
    expect(images.every((part) => part.type === 'image' && part.localData?.byteLength === png.byteLength)).toBe(true);
    await ctx.dispose();
  });

  it('opaque image without a resolver stays on resourceRef (delivered, unresolved)', async () => {
    const { processor, service, ctx } = makeProcessor(okFetcher().fetcher, new AbortController().signal);
    const received: MessageReceived[] = [];
    service.on((event) => { if (event.type === 'message.received') received.push(event); });
    await processor.handle({
      type: 'picture', msgId: 'm9', senderId: 'u1', conversationId: 'c1',
      picMediaId: '@lADP_2', picDownloadCode: 'dl-9', robotCode: 'rb-1',
    });
    expect(received).toHaveLength(1);
    const part = received[0]?.message.content[0] as Record<string, unknown>;
    expect(part).toMatchObject({ type: 'image', resourceRef: '@lADP_2' });
    expect(part.localData).toBeUndefined();
    await ctx.dispose();
  });

  it('genuine http(s) picUrl stays on url (never misread as an opaque handle)', async () => {
    const { fetcher, calls } = okFetcher();
    const { processor, service, ctx } = makeProcessor(fetcher, new AbortController().signal);
    const received: MessageReceived[] = [];
    service.on((event) => { if (event.type === 'message.received') received.push(event); });
    await processor.handle({ type: 'image', msgId: 'm10', senderId: 'u1', conversationId: 'c1', picUrl: 'https://dingtalk.example/real.png' });
    expect(received).toHaveLength(1);
    const part = received[0]?.message.content[0] as Record<string, unknown>;
    expect(part).toMatchObject({ type: 'image', url: 'https://dingtalk.example/real.png' });
    expect(part).not.toHaveProperty('resourceRef');
    expect(calls).toHaveLength(1);
    await ctx.dispose();
  });
});
