/**
 * M7C: DingTalk generic FILE inbound hydration (plan §86 / §32A).
 *
 * Covers the `InboundProcessor` file-hydration step: a genuine http(s) file
 * url is fetched into `localData` + `mimeType` + `size` via the secure fetcher;
 * an opaque file mediaId is moved to `resourceRef` then resolved through the
 * injectable DingTalk OpenAPI media resolver into `localData`; failures keep
 * the locator and stamp `ingressFailure` without blocking emission. Fully offline.
 */
import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, type MessageReceived } from '@wsz987/channel-core';
import { createTestContext } from '@wsz987/channel-testkit';
import { InboundProcessor, type MediaResolverLike, type RemoteMediaFetchLike } from '../src/index.ts';

/** A fake secure fetcher that records calls and returns one bounded result. */
function okFetcher(): { fetcher: RemoteMediaFetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetcher: RemoteMediaFetchLike = {
    async fetchBounded(url) {
      calls.push(url);
      return { data: new Uint8Array([9, 8, 7]), mimeType: 'application/pdf', finalUrl: url };
    },
  };
  return { fetcher, calls };
}

/** A fake resolveMedia that turns a mediaId into bytes. */
function okResolver(): { resolver: MediaResolverLike; calls: { ref: string; options?: unknown }[] } {
  const calls: { ref: string; options?: unknown }[] = [];
  const resolver: MediaResolverLike = {
    async resolveMedia(ref, options) {
      calls.push({ ref, options });
      return { data: new Uint8Array([1, 2, 3, 4]), mimeType: 'application/octet-stream', size: 4 };
    },
  };
  return { resolver, calls };
}

/** Build the inbound processor with injected fetcher + resolver. */
function makeProcessor(opts: { fetcher?: RemoteMediaFetchLike; resolver?: MediaResolverLike } = {}) {
  const service = new ChannelService(new Context());
  const ctx = createTestContext(service);
  const processor = new InboundProcessor({
    ctx,
    meta: { channel: 'dingtalk' as never, accountId: 'main' as never },
    dedupEnabled: false,
    dedupWindowMs: 5000,
    secureFetch: opts.fetcher,
    resolveMedia: opts.resolver,
  });
  return { processor, service, ctx };
}

async function handleFile(raw: Record<string, unknown>, processor: InboundProcessor, service: ChannelService) {
  const received: MessageReceived[] = [];
  service.on((event) => { if (event.type === 'message.received') received.push(event); });
  await processor.handle(raw);
  return received;
}

describe('InboundProcessor generic file hydration (M7C)', () => {
  it('file with a genuine http(s) url -> fetched into localData + mimeType + size', async () => {
    const { fetcher, calls } = okFetcher();
    const { processor, service, ctx } = makeProcessor({ fetcher });
    const received = await handleFile(
      { type: 'file', msgId: 'f1', senderId: 'u1', conversationId: 'c1', mediaUrl: 'https://dingtalk.example/report.pdf', title: 'report.pdf' },
      processor,
      service,
    );
    expect(received).toHaveLength(1);
    const part = received[0]?.message.content[0] as Record<string, unknown>;
    expect(part).toMatchObject({
      type: 'file',
      url: 'https://dingtalk.example/report.pdf',
      mimeType: 'application/pdf',
      name: 'report.pdf',
    });
    expect(Array.from((part.localData as Uint8Array))).toEqual([9, 8, 7]);
    expect(calls).toEqual(['https://dingtalk.example/report.pdf']);
    await ctx.dispose();
  });

  it('file with an opaque mediaId -> resourceRef set, then resolveMedia -> localData', async () => {
    const { fetcher, calls } = okFetcher();
    const { resolver, calls: resCalls } = okResolver();
    const { processor, service, ctx } = makeProcessor({ fetcher, resolver });
    const received = await handleFile(
      { type: 'file', msgId: 'f2', senderId: 'u1', conversationId: 'c1', mediaUrl: 'mediaId_xyz', title: 'doc.pdf' },
      processor,
      service,
    );
    expect(received).toHaveLength(1);
    const part = received[0]?.message.content[0] as Record<string, unknown>;
    // Opaque handle moved to resourceRef; url removed.
    expect(part).toMatchObject({ type: 'file', resourceRef: 'mediaId_xyz', name: 'doc.pdf' });
    expect(part.url).toBeUndefined();
    expect(Array.from((part.localData as Uint8Array))).toEqual([1, 2, 3, 4]);
    expect(part.mimeType).toBe('application/octet-stream');
    expect(part.size).toBe(4);
    // The opaque handle was NOT passed to the generic fetcher.
    expect(calls).toHaveLength(0);
    expect(resCalls.map((c) => c.ref)).toEqual(['mediaId_xyz']);
    await ctx.dispose();
  });

  it('file URL fetch failure -> keeps url + ingressFailure, text still emitted', async () => {
    const throwFetcher: RemoteMediaFetchLike = {
      async fetchBounded() {
        throw new Error('download failed');
      },
    };
    const { processor, service, ctx } = makeProcessor({ fetcher: throwFetcher });
    const received = await handleFile(
      { type: 'file', msgId: 'f3', senderId: 'u1', conversationId: 'c1', mediaUrl: 'https://dingtalk.example/big.pdf', title: 'big.pdf' },
      processor,
      service,
    );
    expect(received).toHaveLength(1);
    const part = received[0]?.message.content[0] as Record<string, unknown>;
    expect(part).toMatchObject({ type: 'file', url: 'https://dingtalk.example/big.pdf', ingressFailure: 'download-failed' });
    expect(part.localData).toBeUndefined();
    await ctx.dispose();
  });

  it('mediaId resolution failure -> keeps resourceRef + ingressFailure', async () => {
    const failResolver: MediaResolverLike = {
      async resolveMedia() {
        throw new Error('unresolvable');
      },
    };
    const { processor, service, ctx } = makeProcessor({ resolver: failResolver });
    const received = await handleFile(
      { type: 'file', msgId: 'f4', senderId: 'u1', conversationId: 'c1', mediaUrl: 'mediaId_bad', title: 'x.bin' },
      processor,
      service,
    );
    expect(received).toHaveLength(1);
    const part = received[0]?.message.content[0] as Record<string, unknown>;
    expect(part).toMatchObject({ type: 'file', resourceRef: 'mediaId_bad' });
    expect(part.url).toBeUndefined();
    expect(String((part as { ingressFailure?: unknown }).ingressFailure).length).toBeGreaterThan(0);
    expect(part.localData).toBeUndefined();
    await ctx.dispose();
  });

  it('file failure never blocks a sibling image/text passthrough', async () => {
    const throwFetcher: RemoteMediaFetchLike = {
      async fetchBounded() {
        throw new Error('boom');
      },
    };
    const { processor, service, ctx } = makeProcessor({ fetcher: throwFetcher });
    const received: MessageReceived[] = [];
    service.on((event) => { if (event.type === 'message.received') received.push(event); });
    await processor.handle({ type: 'file', msgId: 'f5', senderId: 'u1', conversationId: 'c1', mediaUrl: 'https://dingtalk.example/f.pdf' });
    expect(received).toHaveLength(1);
    const part = received[0]?.message.content[0] as Record<string, unknown>;
    expect(part).toMatchObject({ type: 'file', ingressFailure: 'download-failed' });
    await ctx.dispose();
  });
});
