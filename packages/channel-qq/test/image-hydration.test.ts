/**
 * Image hydration tests (M2A Native Image Ingress, fully offline):
 *
 * - hydrateImageParts unit suite: fake fetcher injected, asserts localData +
 *   mimeType, the URL + abort signal forwarded to the fetcher, failure code
 *   mapping, and that resourceRef-only / dataUri-only parts are untouched.
 * - InboundProcessor integration: a faked secureFetch proves images reach the
 *   emitted event with localData, and that a failed download still emits the
 *   part with its url + an ingressFailure code (text delivery never blocked).
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService } from '@wsz987/channel-core';
import {
  BodyTooLargeError,
  RemoteMediaError,
  SecureRemoteMediaFetcher,
  UnsafeHostError,
} from '@wsz987/channel-core';
import { createTestContext } from '@wsz987/channel-testkit';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { InboundProcessor } from '../src/inbound.ts';
import { hydrateImageParts } from '../src/image-hydrator.ts';
import { mapInbound } from '../src/mapper.ts';
import type { FilePart, ImagePart, MessagePart } from '@wsz987/channel-core';

const meta = { channel: 'qq' as never, accountId: 'main' as never };

function inbound(overrides: Partial<QQBotInboundMessage> = {}): QQBotInboundMessage {
  return {
    rawEventType: 'C2C_MESSAGE_CREATE',
    kind: 'c2c',
    senderId: 'user_123',
    senderName: 'alice',
    content: 'look',
    messageId: 'msg_1',
    timestamp: '2026-08-14T10:00:00+08:00',
    replyTarget: { scope: 'c2c', targetId: 'user_123', msgId: 'msg_1' },
    raw: {},
    attachments: [],
    ...overrides,
  } as QQBotInboundMessage;
}

/** A fake SecureRemoteMediaFetcher whose fetchBounded is a controllable stub. */
function fakeFetcher() {
  const fetchBounded = vi.fn<(url: string, opts: unknown) => Promise<{ data: Uint8Array; mimeType?: string; finalUrl: string }>>();
  return { fetchBounded, object: { fetchBounded } as unknown as SecureRemoteMediaFetcher };
}

describe('hydrateImageParts (unit)', () => {
  const bytes = new Uint8Array([1, 2, 3]);

  it('injects localData + mimeType for an image part with an http(s) url', async () => {
    const fetcher = fakeFetcher();
    fetcher.fetchBounded.mockResolvedValue({ data: bytes, mimeType: 'image/png', finalUrl: 'https://e/p.png' });
    const parts: MessagePart[] = [{ type: 'image', url: 'https://e/p.png', alt: 'p.png' }];

    await hydrateImageParts(parts, fetcher.object);

    expect(parts[0]).toEqual({
      type: 'image',
      url: 'https://e/p.png',
      alt: 'p.png',
      localData: bytes,
      mimeType: 'image/png',
    });
    expect(fetcher.fetchBounded).toHaveBeenCalledTimes(1);
    expect(fetcher.fetchBounded.mock.calls[0]?.[0]).toBe('https://e/p.png');
  });

  it('forwards the abort signal to the fetcher', async () => {
    const fetcher = fakeFetcher();
    fetcher.fetchBounded.mockResolvedValue({ data: bytes, finalUrl: 'https://e/p.png' });
    const controller = new AbortController();
    await hydrateImageParts(
      [{ type: 'image', url: 'https://e/p.png' }],
      fetcher.object,
      { signal: controller.signal },
    );
    const opts = fetcher.fetchBounded.mock.calls[0]?.[1] as { signal?: AbortSignal; maxBytes?: number };
    expect(opts?.signal).toBe(controller.signal);
    expect(opts?.maxBytes).toBe(20 * 1024 * 1024);
  });

  it('prefers the fetcher mimeType over the platform hint', async () => {
    const fetcher = fakeFetcher();
    fetcher.fetchBounded.mockResolvedValue({ data: bytes, mimeType: 'image/webp', finalUrl: 'https://e/p' });
    const parts: MessagePart[] = [{ type: 'image', url: 'https://e/p', mimeType: 'image/jpeg' }];
    await hydrateImageParts(parts, fetcher.object);
    expect((parts[0] as ImagePart).mimeType).toBe('image/webp');
  });

  it('keeps the platform mimeType when the fetcher returns none', async () => {
    const fetcher = fakeFetcher();
    fetcher.fetchBounded.mockResolvedValue({ data: bytes, finalUrl: 'https://e/p' });
    const parts: MessagePart[] = [{ type: 'image', url: 'https://e/p', mimeType: 'image/png' }];
    await hydrateImageParts(parts, fetcher.object);
    expect((parts[0] as ImagePart).mimeType).toBe('image/png');
    expect((parts[0] as ImagePart).localData).toBe(bytes);
  });

  it('is skipped for parts without a url (resourceRef-only parts untouched)', async () => {
    const fetcher = fakeFetcher();
    const parts: MessagePart[] = [{ type: 'image', resourceRef: 'img_123' }];
    await hydrateImageParts(parts, fetcher.object);
    expect(fetcher.fetchBounded).not.toHaveBeenCalled();
    expect(parts[0]).toEqual({ type: 'image', resourceRef: 'img_123' });
  });

  it('is skipped for parts already carrying localData or dataUri', async () => {
    const fetcher = fakeFetcher();
    const local = new Uint8Array([9]);
    const parts: MessagePart[] = [
      { type: 'image', url: 'https://e/p', localData: local },
      { type: 'image', url: 'https://e/q', dataUri: 'data:image/png;base64,AAA=' },
    ];
    await hydrateImageParts(parts, fetcher.object);
    expect(fetcher.fetchBounded).not.toHaveBeenCalled();
    expect((parts[0] as ImagePart).localData).toBe(local);
  });

  it('maps body too large to ingressFailure too-large', async () => {
    const fetcher = fakeFetcher();
    fetcher.fetchBounded.mockRejectedValue(new BodyTooLargeError(20));
    const parts: MessagePart[] = [{ type: 'image', url: 'https://e/p' }];
    await hydrateImageParts(parts, fetcher.object);
    expect(parts[0]).toEqual({ type: 'image', url: 'https://e/p', ingressFailure: 'too-large' });
  });

  it('maps unsafe host to ingressFailure resource-unavailable', async () => {
    const fetcher = fakeFetcher();
    fetcher.fetchBounded.mockRejectedValue(new UnsafeHostError('https://169.254.1.1/p', 'link-local'));
    const parts: MessagePart[] = [{ type: 'image', url: 'https://e/p' }];
    await hydrateImageParts(parts, fetcher.object);
    expect((parts[0] as ImagePart).ingressFailure).toBe('resource-unavailable');
  });

  it('maps too many redirects to ingressFailure resource-unavailable', async () => {
    const fetcher = fakeFetcher();
    fetcher.fetchBounded.mockRejectedValue(new RemoteMediaError('TOO_MANY_REDIRECTS', 'loop'));
    const parts: MessagePart[] = [{ type: 'image', url: 'https://e/p' }];
    await hydrateImageParts(parts, fetcher.object);
    expect((parts[0] as ImagePart).ingressFailure).toBe('resource-unavailable');
  });

  it('maps a generic network error to ingressFailure download-failed and keeps url', async () => {
    const fetcher = fakeFetcher();
    fetcher.fetchBounded.mockRejectedValue(new Error('net down'));
    const parts: MessagePart[] = [{ type: 'image', url: 'https://e/p' }];
    await hydrateImageParts(parts, fetcher.object);
    expect(parts[0]).toEqual({ type: 'image', url: 'https://e/p', ingressFailure: 'download-failed' });
  });

  it('maps non-http url to resource-unavailable without calling the fetcher', async () => {
    const fetcher = fakeFetcher();
    const parts: MessagePart[] = [{ type: 'image', url: 'ftp://e/p' }];
    await hydrateImageParts(parts, fetcher.object);
    expect(fetcher.fetchBounded).not.toHaveBeenCalled();
    expect(parts[0]).toEqual({ type: 'image', url: 'ftp://e/p', ingressFailure: 'resource-unavailable' });
  });

  it('continues hydrating the next image when one fails', async () => {
    const fetcher = fakeFetcher();
    fetcher.fetchBounded.mockRejectedValueOnce(new Error('boom'));
    fetcher.fetchBounded.mockResolvedValueOnce({ data: bytes, mimeType: 'image/jpeg', finalUrl: 'https://e/q' });
    const parts: MessagePart[] = [
      { type: 'image', url: 'https://e/one' },
      { type: 'image', url: 'https://e/two' },
    ];
    await hydrateImageParts(parts, fetcher.object);
    expect((parts[0] as ImagePart).ingressFailure).toBe('download-failed');
    expect((parts[1] as ImagePart).localData).toBe(bytes);
  });
});

describe('InboundProcessor image hydration (integration)', () => {
  function makeProcessor(fetcher: SecureRemoteMediaFetcher, captured: (e: unknown) => void) {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const off = service.on((e) => captured(e));
    const processor = new InboundProcessor({
      ctx,
      meta,
      dedupEnabled: false,
      dedupWindowMs: 0,
      secureFetch: fetcher,
    });
    return { processor, ctx, off };
  }

  it('emits an event whose image part carries localData + mimeType', async () => {
    const fetcher = fakeFetcher();
    fetcher.fetchBounded.mockResolvedValue({
      data: new Uint8Array([7, 8, 9]),
      mimeType: 'image/gif',
      finalUrl: 'https://e/g.gif',
    });
    const captured: unknown[] = [];
    const { processor, ctx, off } = makeProcessor(fetcher.object, (e) => captured.push(e));
    try {
      const ev = mapInbound(
        inbound({ content: 'hi', attachments: [{ content_type: 'image/gif', url: 'https://e/g.gif', filename: 'g.gif' }] }),
        meta,
      );
      const img = ev.message.content.find((p): p is ImagePart => p.type === 'image')!;
      expect(img.localData).toBeUndefined();

      await processor.handle(
        inbound({ content: 'hi', attachments: [{ content_type: 'image/gif', url: 'https://e/g.gif', filename: 'g.gif' }] }),
      );

      const received = captured.find((e) => (e as { type: string }).type === 'message.received') as
        | { message: { content: MessagePart[] } }
        | undefined;
      const emittedImage = received?.message.content.find((p): p is ImagePart => p.type === 'image');
      expect(emittedImage).toBeDefined();
      expect(emittedImage?.localData).toEqual(new Uint8Array([7, 8, 9]));
      expect(emittedImage?.mimeType).toBe('image/gif');
      expect(emittedImage?.url).toBe('https://e/g.gif');

      // The abort signal handed to the processor context was forwarded.
      const opts = fetcher.fetchBounded.mock.calls[0]?.[1] as { signal?: AbortSignal };
      expect(opts?.signal).toBe(ctx.signal);
    } finally {
      off();
    }
  });

  it('still emits (url retained + ingressFailure) when the download fails', async () => {
    const fetcher = fakeFetcher();
    fetcher.fetchBounded.mockRejectedValue(new Error('connection refused'));
    const captured: unknown[] = [];
    const { processor, off } = makeProcessor(fetcher.object, (e) => captured.push(e));
    try {
      await processor.handle(
        inbound({ content: 'keep me', attachments: [{ content_type: 'image/png', url: 'https://e/p.png' }] }),
      );
      const received = captured.find((e) => (e as { type: string }).type === 'message.received') as {
        message: { content: MessagePart[] };
      } | undefined;
      const text = received?.message.content.find((p) => p.type === 'text') as { text?: string } | undefined;
      const img = received?.message.content.find((p): p is ImagePart => p.type === 'image');
      // Text delivery is never blocked.
      expect(text?.text).toBe('keep me');
      // The image part is retained with its locator + a stable failure code.
      expect(img?.url).toBe('https://e/p.png');
      expect(img?.ingressFailure).toBe('download-failed');
      expect(img?.localData).toBeUndefined();
    } finally {
      off();
    }
  });
});

describe('hydrateImageParts — generic file hydration (M7B)', () => {
  const bytes = new Uint8Array([1, 2, 3]);

  it('inflates a file part with localData + mimeType + size', async () => {
    const fetcher = fakeFetcher();
    fetcher.fetchBounded.mockResolvedValue({
      data: bytes,
      mimeType: 'application/pdf',
      finalUrl: 'https://e/r.pdf',
    });
    const parts: MessagePart[] = [{ type: 'file', url: 'https://e/r.pdf', name: 'r.pdf', size: 4096 }];

    await hydrateImageParts(parts, fetcher.object);

    expect(parts[0]).toEqual({
      type: 'file',
      url: 'https://e/r.pdf',
      name: 'r.pdf',
      localData: bytes,
      mimeType: 'application/pdf',
      size: 3,
    });
    expect(fetcher.fetchBounded).toHaveBeenCalledTimes(1);
  });

  it('uses the hydrated byte length as size and falls back to a sniffed mime', async () => {
    const fetcher = fakeFetcher();
    fetcher.fetchBounded.mockResolvedValue({ data: new Uint8Array(5), finalUrl: 'https://e/d.docx' });
    const parts: MessagePart[] = [{ type: 'file', url: 'https://e/d.docx', name: 'report.docx' }];

    await hydrateImageParts(parts, fetcher.object);

    expect((parts[0] as FilePart).size).toBe(5);
    expect((parts[0] as FilePart).mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('keeps url + a stable ingressFailure code when the file download fails', async () => {
    const fetcher = fakeFetcher();
    fetcher.fetchBounded.mockRejectedValue(new Error('file fetch down'));
    const parts: MessagePart[] = [{ type: 'file', url: 'https://e/r.bin', name: 'r.bin' }];

    await hydrateImageParts(parts, fetcher.object);

    expect(parts[0]).toEqual({
      type: 'file',
      url: 'https://e/r.bin',
      name: 'r.bin',
      ingressFailure: 'download-failed',
    });
    expect((parts[0] as FilePart).localData).toBeUndefined();
  });

  it('leaves audio/video parts untouched (no consumer in V1)', async () => {
    const fetcher = fakeFetcher();
    const parts: MessagePart[] = [
      { type: 'audio', url: 'https://e/a.wav' },
      { type: 'video', url: 'https://e/c.mp4' },
    ];
    await hydrateImageParts(parts, fetcher.object);
    expect(fetcher.fetchBounded).not.toHaveBeenCalled();
    expect(parts[0]).toEqual({ type: 'audio', url: 'https://e/a.wav' });
    expect(parts[1]).toEqual({ type: 'video', url: 'https://e/c.mp4' });
  });
});

describe('InboundProcessor — generic file hydration (integration, M7B)', () => {
  function makeProcessor(fetcher: SecureRemoteMediaFetcher, captured: (e: unknown) => void) {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const off = service.on((e) => captured(e));
    const processor = new InboundProcessor({
      ctx,
      meta,
      dedupEnabled: false,
      dedupWindowMs: 0,
      secureFetch: fetcher,
    });
    return { processor, ctx, off };
  }

  it('emits a file part carrying localData + mimeType + size', async () => {
    const fetcher = fakeFetcher();
    fetcher.fetchBounded.mockResolvedValue({
      data: new Uint8Array([4, 5, 6]),
      mimeType: 'text/plain',
      finalUrl: 'https://e/notes.txt',
    });
    const captured: unknown[] = [];
    const { processor, off } = makeProcessor(fetcher.object, (e) => captured.push(e));
    try {
      await processor.handle(
        inbound({
          content: 'see file',
          attachments: [
            { content_type: 'file', url: 'https://e/notes.txt', filename: 'notes.txt', size: 128 },
          ],
        }),
      );
      const received = captured.find((e) => (e as { type: string }).type === 'message.received') as {
        message: { content: MessagePart[] };
      } | undefined;
      const file = received?.message.content.find((p): p is FilePart => p.type === 'file');
      const text = received?.message.content.find((p) => p.type === 'text') as { text?: string } | undefined;
      expect(text?.text).toBe('see file');
      expect(file).toBeDefined();
      expect(file?.localData).toEqual(new Uint8Array([4, 5, 6]));
      expect(file?.mimeType).toBe('text/plain');
      expect(file?.size).toBe(3);
      expect(file?.url).toBe('https://e/notes.txt');
    } finally {
      off();
    }
  });

  it('still emits a file part (url + ingressFailure) when the download fails', async () => {
    const fetcher = fakeFetcher();
    fetcher.fetchBounded.mockRejectedValue(new Error('pdf fetch refused'));
    const captured: unknown[] = [];
    const { processor, off } = makeProcessor(fetcher.object, (e) => captured.push(e));
    try {
      await processor.handle(
        inbound({
          content: 'keep me',
          attachments: [{ content_type: 'file', url: 'https://e/r.pdf', filename: 'r.pdf' }],
        }),
      );
      const received = captured.find((e) => (e as { type: string }).type === 'message.received') as {
        message: { content: MessagePart[] };
      } | undefined;
      const text = received?.message.content.find((p) => p.type === 'text') as { text?: string } | undefined;
      const file = received?.message.content.find((p): p is FilePart => p.type === 'file');
      expect(text?.text).toBe('keep me');
      expect(file?.url).toBe('https://e/r.pdf');
      expect(file?.ingressFailure).toBe('download-failed');
      expect(file?.localData).toBeUndefined();
    } finally {
      off();
    }
  });
});

