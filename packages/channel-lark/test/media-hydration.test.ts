/**
 * Media hydration tests: the MediaHydrator resolves ALL four
 * binary resource kinds — image, file, audio AND video — through the fake
 * media port into localData bytes before emit.
 *
 * Platform verdict evidence (see the task report): the official
 * `im.v1.messageResource.get` API documents its resource scope as 音频、视频、
 * 图片和文件 (audio, video, image and file — SDK-embedded doc statement in
 * @larksuiteoapi/node-sdk@1.73.1), and the SDK `type` query param is typed
 * `string`, so audio/video file_keys download through the same seam as
 * image/file. Failures keep the resourceRef, set a stable ingressFailure and
 * never block text delivery; an over-cap resource maps to 'too-large'.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, mediaCapabilitiesSchema, type MessageReceived } from '@wsz987/channel-core';
import { createTestContext } from '@wsz987/channel-testkit';
import {
  Config,
  LarkAdapter,
  MediaHydrator,
  InboundProcessor,
  type LarkMediaPort,
  type LarkResourceType,
} from '../src/index.ts';
import type { LarkConfig } from '../src/config.ts';

const meta = { channel: 'lark' as never, accountId: 'main' as never };

/**
 * Fake media port with a programmable download result or failure. Records the
 * exact messageResource inputs (incl. the per-kind `type`) for
 * official-method-mapping assertions.
 */
class FakeMediaPort implements LarkMediaPort {
  calls: { messageId: string; resourceKey: string; type: LarkResourceType }[] = [];
  downloadError?: Error;
  downloadResult: { data: Uint8Array; mimeType?: string; name?: string } = {
    data: new Uint8Array([0x1a, 0x2b, 0x3c, 0x4d]),
    mimeType: 'audio/ogg',
    name: 'voice.ogg',
  };
  downloadDelayMs = 0;
  activeDownloads = 0;
  maxActiveDownloads = 0;
  maxBytesCalls: Array<number | undefined> = [];

  async downloadMessageResource(input: {
    messageId: string;
    resourceKey: string;
    type: LarkResourceType;
    signal?: AbortSignal;
    maxBytes?: number;
  }): Promise<{ data: Uint8Array; mimeType?: string; name?: string }> {
    this.calls.push({ messageId: input.messageId, resourceKey: input.resourceKey, type: input.type });
    this.maxBytesCalls.push(input.maxBytes);
    this.activeDownloads += 1;
    this.maxActiveDownloads = Math.max(this.maxActiveDownloads, this.activeDownloads);
    try {
      if (this.downloadDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.downloadDelayMs));
      }
      if (this.downloadError) throw this.downloadError;
      return this.downloadResult;
    } finally {
      this.activeDownloads -= 1;
    }
  }

  uploadImage(): Promise<{ imageKey: string }> {
    return Promise.resolve({ imageKey: 'img_v2_up' });
  }

  uploadFile(): Promise<{ fileKey: string }> {
    return Promise.resolve({ fileKey: 'file_v2_up' });
  }
}

function rawMessage(overrides: Record<string, unknown> = {}): {
  type: 'message.received';
  channel: string;
  accountId: string;
  conversation: { id: string; type: 'group' };
  sender: { id: string };
  message: { id: string; createdAt: number; content: unknown[] };
  raw: Record<string, unknown>;
} {
  return {
    type: 'message.received',
    channel: 'lark',
    accountId: 'main',
    conversation: { id: 'oc_1', type: 'group' },
    sender: { id: 'ou_1' },
    message: {
      id: 'om_media_1',
      createdAt: 1,
      content: [{ type: 'text', text: 'payload' }],
    },
    raw: {},
    ...overrides,
  };
}

function makeProcessor(mediaPort?: LarkMediaPort) {
  const service = new ChannelService(new Context());
  const ctx = createTestContext(service);
  const processor = new InboundProcessor({
    ctx,
    meta,
    dedupEnabled: false,
    dedupWindowMs: 5000,
    now: () => 1000,
    mediaPort,
  });
  return { service, ctx, processor };
}

describe('MediaHydrator (direct) — all four binary kinds', () => {
  it('hydrates an audio resourceRef file_key into AudioPart.localData (type audio)', async () => {
    const port = new FakeMediaPort();
    port.downloadResult = {
      data: new Uint8Array([0x0f, 0x1e, 0x2d]),
      mimeType: 'audio/ogg',
      name: 'voice.ogg',
    };
    const hydrator = new MediaHydrator({ mediaPort: port, signal: new AbortController().signal });
    const event = rawMessage({
      message: {
        id: 'om_aud_1',
        createdAt: 1,
        content: [{ type: 'audio', resourceRef: 'file_v2_voice', durationMs: 3200 }],
      },
    });
    await hydrator.hydrateMedia(event as MessageReceived);
    const audio = (event.message.content as Array<Record<string, unknown>>)[0];
    expect(audio).toMatchObject({
      type: 'audio',
      resourceRef: 'file_v2_voice',
      durationMs: 3200,
      localData: new Uint8Array([0x0f, 0x1e, 0x2d]),
      mimeType: 'audio/ogg',
      name: 'voice.ogg',
      size: 3,
    });
    expect(audio.ingressFailure).toBeUndefined();
    expect(port.calls).toEqual([{ messageId: 'om_aud_1', resourceKey: 'file_v2_voice', type: 'audio' }]);
  });

  it('hydrates a video resourceRef file_key into VideoPart.localData (type video)', async () => {
    const port = new FakeMediaPort();
    port.downloadResult = {
      data: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee]),
      mimeType: 'video/mp4',
      name: 'clip.mp4',
    };
    const hydrator = new MediaHydrator({ mediaPort: port });
    const event = rawMessage({
      message: {
        id: 'om_vid_1',
        createdAt: 1,
        content: [{ type: 'video', resourceRef: 'file_v2_movie', durationMs: 8100 }],
      },
    });
    await hydrator.hydrateMedia(event as MessageReceived);
    const video = (event.message.content as Array<Record<string, unknown>>)[0];
    expect(video).toMatchObject({
      type: 'video',
      resourceRef: 'file_v2_movie',
      durationMs: 8100,
      localData: new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0xee]),
      mimeType: 'video/mp4',
      name: 'clip.mp4',
      size: 5,
    });
    expect(video.ingressFailure).toBeUndefined();
    expect(port.calls).toEqual([{ messageId: 'om_vid_1', resourceKey: 'file_v2_movie', type: 'video' }]);
  });

  it('keeps image/file hydration byte-identical (regression)', async () => {
    const port = new FakeMediaPort();
    port.downloadResult = {
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mimeType: 'image/png',
      name: 'photo.png',
    };
    const hydrator = new MediaHydrator({ mediaPort: port });
    const event = rawMessage({
      message: {
        id: 'om_img_file',
        createdAt: 1,
        content: [
          { type: 'image', resourceRef: 'img_v2_xyz', alt: 'pic' },
          { type: 'file', resourceRef: 'file_v2_doc', name: 'doc.pdf' },
        ],
      },
    });
    await hydrator.hydrateMedia(event as MessageReceived);
    const parts = event.message.content as Array<Record<string, unknown>>;
    // Image: localData + mimeType + name; legacy image shape keeps NO size.
    expect(parts[0]).toMatchObject({
      type: 'image',
      resourceRef: 'img_v2_xyz',
      alt: 'pic',
      localData: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mimeType: 'image/png',
      name: 'photo.png',
    });
    expect(parts[0]).not.toHaveProperty('size');
    // File: localData + mimeType + authoritative size from bytes; the port's
    // resolved name (photo.png) overrides the mapped doc.pdf hint, matching
    // the pre-§23-A4 merge semantics (`resolved.name` wins when present).
    expect(parts[1]).toMatchObject({
      type: 'file',
      resourceRef: 'file_v2_doc',
      name: 'photo.png',
      localData: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      mimeType: 'image/png',
      size: 4,
    });
    expect(port.calls).toEqual([
      { messageId: 'om_img_file', resourceKey: 'img_v2_xyz', type: 'image' },
      { messageId: 'om_img_file', resourceKey: 'file_v2_doc', type: 'file' },
    ]);
  });

  it('keeps resourceRef and records download-failed on a network/API failure (audio)', async () => {
    const port = new FakeMediaPort();
    port.downloadError = new Error('network timeout');
    const hydrator = new MediaHydrator({ mediaPort: port });
    const event = rawMessage({
      message: { id: 'om_aud_2', createdAt: 1, content: [{ type: 'audio', resourceRef: 'file_v2_voice2' }] },
    });
    await hydrator.hydrateMedia(event as MessageReceived);
    const audio = (event.message.content as Array<Record<string, unknown>>)[0];
    expect(audio.resourceRef).toBe('file_v2_voice2');
    expect(audio.localData).toBeUndefined();
    expect(audio.ingressFailure).toBe('download-failed');
  });

  it('maps a missing resource to resource-unavailable (video)', async () => {
    const port = new FakeMediaPort();
    port.downloadError = new Error('resource not found');
    const hydrator = new MediaHydrator({ mediaPort: port });
    const event = rawMessage({
      message: { id: 'om_vid_2', createdAt: 1, content: [{ type: 'video', resourceRef: 'file_v2_gone' }] },
    });
    await hydrator.hydrateMedia(event as MessageReceived);
    const video = (event.message.content as Array<Record<string, unknown>>)[0];
    expect(video.resourceRef).toBe('file_v2_gone');
    expect(video.localData).toBeUndefined();
    expect(video.ingressFailure).toBe('resource-unavailable');
  });

  it('marks too-large without storing oversized bytes or deriving size', async () => {
    const port = new FakeMediaPort();
    port.downloadResult = { data: new Uint8Array(100), mimeType: 'audio/ogg' };
    const hydrator = new MediaHydrator({ mediaPort: port, maxBytes: 10 });
    const event = rawMessage({
      message: { id: 'om_aud_3', createdAt: 1, content: [{ type: 'audio', resourceRef: 'file_v2_big' }] },
    });
    await hydrator.hydrateMedia(event as MessageReceived);
    const audio = (event.message.content as Array<Record<string, unknown>>)[0];
    expect(audio.ingressFailure).toBe('too-large');
    expect(audio.resourceRef).toBe('file_v2_big');
    expect(audio.localData).toBeUndefined();
    expect(audio.size).toBeUndefined();
  });

  it('accepts bytes exactly at maxBytes (cap is strictly greater)', async () => {
    const port = new FakeMediaPort();
    port.downloadResult = { data: new Uint8Array(10), mimeType: 'audio/ogg' };
    const hydrator = new MediaHydrator({ mediaPort: port, maxBytes: 10 });
    const event = rawMessage({
      message: { id: 'om_aud_4', createdAt: 1, content: [{ type: 'audio', resourceRef: 'file_v2_ok' }] },
    });
    await hydrator.hydrateMedia(event as MessageReceived);
    const audio = (event.message.content as Array<Record<string, unknown>>)[0];
    expect(audio.localData?.byteLength).toBe(10);
    expect(audio.size).toBe(10);
    expect(audio.ingressFailure).toBeUndefined();
  });

  it('passes the 100 MiB default hard cap to the SDK port', async () => {
    const port = new FakeMediaPort();
    const hydrator = new MediaHydrator({ mediaPort: port });
    const event = rawMessage({
      message: {
        id: 'om_cap',
        createdAt: 1,
        content: [{ type: 'file', resourceRef: 'file_cap', name: 'cap.bin' }],
      },
    });
    await hydrator.hydrateMedia(event as MessageReceived);
    expect(port.maxBytesCalls).toEqual([100 * 1024 * 1024]);
  });

  it('limits per-message media download concurrency', async () => {
    const port = new FakeMediaPort();
    port.downloadDelayMs = 10;
    const hydrator = new MediaHydrator({ mediaPort: port, maxConcurrency: 2 });
    const event = rawMessage({
      message: {
        id: 'om_concurrency',
        createdAt: 1,
        content: Array.from({ length: 5 }, (_, index) => ({
          type: 'video',
          resourceRef: `file_video_${index}`,
        })),
      },
    });
    await hydrator.hydrateMedia(event as MessageReceived);
    expect(port.calls).toHaveLength(5);
    expect(port.maxActiveDownloads).toBe(2);
  });

  it('leaves parts without resourceRef untouched and never calls the port', async () => {
    const port = new FakeMediaPort();
    const hydrator = new MediaHydrator({ mediaPort: port });
    const event = rawMessage({
      message: {
        id: 'om_no_ref',
        createdAt: 1,
        content: [
          { type: 'audio', url: 'https://example.com/a.ogg', durationMs: 1000 },
          { type: 'video', url: 'https://example.com/v.mp4' },
          { type: 'image', alt: 'no locator' },
        ],
      },
    });
    await hydrator.hydrateMedia(event as MessageReceived);
    const parts = event.message.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'audio', url: 'https://example.com/a.ogg', durationMs: 1000 });
    expect(parts[1]).toEqual({ type: 'video', url: 'https://example.com/v.mp4' });
    expect(parts[2]).toEqual({ type: 'image', alt: 'no locator' });
    expect(port.calls).toHaveLength(0);
  });
});

describe('InboundProcessor audio/video hydration wiring (§23-A4)', () => {
  it('emits an audio event whose part carries localData; text still delivered', async () => {
    const port = new FakeMediaPort();
    port.downloadResult = { data: new Uint8Array([9, 8, 7]), mimeType: 'audio/ogg', name: 'voice.ogg' };
    const { service, processor } = makeProcessor(port);
    const listener = vi.fn();
    service.on(listener);
    await processor.handle({
      type: 'audio',
      msgId: 'om_aud_5',
      senderId: 'ou_1',
      conversationId: 'oc_1',
      chatType: 'group',
      mediaUrl: 'file_v2_voice5',
      durationMs: 4100,
    });
    const event = listener.mock.calls[0]?.[0] as MessageReceived;
    expect(event.type).toBe('message.received');
    const audio = event.message.content[0] as { localData?: Uint8Array; mimeType?: string; resourceRef?: string };
    expect(audio.resourceRef).toBe('file_v2_voice5');
    expect(audio.localData).toEqual(new Uint8Array([9, 8, 7]));
    expect(audio.mimeType).toBe('audio/ogg');
    expect(port.calls).toEqual([{ messageId: 'om_aud_5', resourceKey: 'file_v2_voice5', type: 'audio' }]);
  });

  it('emits a video event whose part carries localData; text still delivered', async () => {
    const port = new FakeMediaPort();
    port.downloadResult = { data: new Uint8Array([1, 2, 3, 4, 5, 6]), mimeType: 'video/mp4', name: 'clip.mp4' };
    const { service, processor } = makeProcessor(port);
    const listener = vi.fn();
    service.on(listener);
    await processor.handle({
      type: 'video',
      msgId: 'om_vid_5',
      senderId: 'ou_1',
      conversationId: 'oc_1',
      chatType: 'group',
      mediaUrl: 'file_v2_movie5',
      durationMs: 9000,
    });
    const event = listener.mock.calls[0]?.[0] as MessageReceived;
    expect(event.type).toBe('message.received');
    const video = event.message.content[0] as { localData?: Uint8Array; mimeType?: string; resourceRef?: string };
    expect(video.resourceRef).toBe('file_v2_movie5');
    expect(video.localData).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
    expect(video.mimeType).toBe('video/mp4');
    expect(port.calls).toEqual([{ messageId: 'om_vid_5', resourceKey: 'file_v2_movie5', type: 'video' }]);
  });

  it('a video download failure keeps resourceRef + ingressFailure and emits (not blocked)', async () => {
    const port = new FakeMediaPort();
    port.downloadError = new Error('boom');
    const { service, processor } = makeProcessor(port);
    const listener = vi.fn();
    service.on(listener);
    await processor.handle({
      type: 'video',
      msgId: 'om_vid_6',
      senderId: 'ou_1',
      conversationId: 'oc_1',
      chatType: 'group',
      mediaUrl: 'file_v2_boom6',
      durationMs: 1200,
    });
    const event = listener.mock.calls[0]?.[0] as MessageReceived;
    expect(event.type).toBe('message.received');
    const video = event.message.content[0] as {
      resourceRef?: string;
      localData?: Uint8Array;
      ingressFailure?: string;
    };
    expect(video.resourceRef).toBe('file_v2_boom6');
    expect(video.ingressFailure).toBe('download-failed');
    expect(video.localData).toBeUndefined();
  });
});

describe('capabilities.media', () => {
  it('declares a directional media map that parses via mediaCapabilitiesSchema', () => {
    const adapter = new LarkAdapter(makeConfig());
    const parsed = mediaCapabilitiesSchema.safeParse(adapter.capabilities.media);
    expect(parsed.success).toBe(true);
    expect(parsed.data.inbound).toEqual({
      image: 'bytes',
      file: 'bytes',
      audio: 'bytes',
      video: 'bytes',
    });
    expect(parsed.data.outbound).toEqual({
      image: 'bytes',
      file: 'bytes',
      audio: 'unsupported',
      video: 'unsupported',
    });
    // Legacy coarse flags remain unchanged.
    expect(adapter.capabilities.audio).toBe(true);
    expect(adapter.capabilities.video).toBe(false);
  });
});

function makeConfig(overrides: Partial<LarkConfig> = {}): LarkConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    timeoutMs: 1000,
    reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
    dedup: { enabled: false, windowMs: 5000 },
    card: { createOnFirstDelta: true, typingIndicator: false },
    upstream: { appId: 'cli_test' },
    ...overrides,
  });
}
