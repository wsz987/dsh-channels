/**
 * Image hydration tests (plan §96 / §79A Lark): a fake media port returns
 * bytes which the emitted event carries as localData + mimeType; failures
 * keep the resourceRef, set a stable ingressFailure, and never block text
 * delivery; images without a resourceRef are left untouched.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, type MessageReceived } from '@wsz987/channel-core';
import { createTestContext } from '@wsz987/channel-testkit';
import { ImageHydrator, InboundProcessor } from '../src/index.ts';
import type { LarkMediaPort } from '../src/index.ts';

const meta = { channel: 'lark' as never, accountId: 'main' as never };

/**
 * Fake media port with a programmable download result or failure. Records the
 * exact messageResource inputs for official-method-mapping assertions.
 */
class FakeMediaPort implements LarkMediaPort {
  calls: { messageId: string; resourceKey: string }[] = [];
  downloadError?: Error;
  downloadResult: { data: Uint8Array; mimeType?: string; name?: string } = {
    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    mimeType: 'image/png',
    name: 'photo.png',
  };

  async downloadMessageResource(input: {
    messageId: string;
    resourceKey: string;
    type: 'image' | 'file';
    signal?: AbortSignal;
  }): Promise<{ data: Uint8Array; mimeType?: string; name?: string }> {
    this.calls.push({ messageId: input.messageId, resourceKey: input.resourceKey });
    if (this.downloadError) throw this.downloadError;
    return this.downloadResult;
  }

  uploadImage(): Promise<{ imageKey: string }> {
    return Promise.resolve({ imageKey: 'img_v2_up' });
  }

  uploadFile(): Promise<{ fileKey: string }> {
    return Promise.resolve({ fileKey: 'file_v2_up' });
  }
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

describe('ImageHydrator (direct)', () => {
  it('populates localData + mimeType (+ name) on a resourceRef image part', async () => {
    const port = new FakeMediaPort();
    const hydrator = new ImageHydrator({ mediaPort: port, signal: new AbortController().signal });
    const event = {
      type: 'message.received',
      channel: 'lark',
      accountId: 'main',
      conversation: { id: 'oc_1', type: 'group' as const },
      sender: { id: 'ou_1' },
      message: {
        id: 'om_in_1',
        createdAt: 1,
        content: [{ type: 'image' as const, resourceRef: 'img_v2_xyz', alt: 'pic' },
                  { type: 'text' as const, text: 'hello' }],
      },
      raw: {},
    };
    await hydrator.hydrateImages(event as MessageReceived);
    const image = (event as MessageReceived).message.content[0] as {
      localData?: Uint8Array;
      mimeType?: string;
      name?: string;
      ingressFailure?: string;
    };
    expect(image.localData).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(image.mimeType).toBe('image/png');
    expect(image.name).toBe('photo.png');
    expect(image.ingressFailure).toBeUndefined();
    expect(port.calls).toEqual([{ messageId: 'om_in_1', resourceKey: 'img_v2_xyz' }]);
  });

  it('keeps resourceRef and records download-failed on a network/API failure', async () => {
    const port = new FakeMediaPort();
    port.downloadError = new Error('network timeout');
    const hydrator = new ImageHydrator({ mediaPort: port });
    const event = {
      type: 'message.received' as const,
      channel: 'lark' as const,
      accountId: 'main' as const,
      conversation: { id: 'oc_1', type: 'group' as const },
      sender: { id: 'ou_1' },
      message: { id: 'om_in_2', createdAt: 1, content: [{ type: 'image' as const, resourceRef: 'img_v2_nope' }] },
      raw: {},
    };
    await hydrator.hydrateImages(event as MessageReceived);
    const image = (event as MessageReceived).message.content[0] as {
      resourceRef?: string;
      localData?: Uint8Array;
      ingressFailure?: string;
    };
    expect(image.resourceRef).toBe('img_v2_nope');
    expect(image.localData).toBeUndefined();
    expect(image.ingressFailure).toBe('download-failed');
  });

  it('records resource-unavailable when the resource is missing', async () => {
    const port = new FakeMediaPort();
    port.downloadError = new Error('resource not found');
    const hydrator = new ImageHydrator({ mediaPort: port });
    const event = {
      type: 'message.received' as const,
      channel: 'lark' as const,
      accountId: 'main' as const,
      conversation: { id: 'oc_1', type: 'group' as const },
      sender: { id: 'ou_1' },
      message: { id: 'om_in_3', createdAt: 1, content: [{ type: 'image' as const, resourceRef: 'img_v2_gone' }] },
      raw: {},
    };
    await hydrator.hydrateImages(event as MessageReceived);
    expect((event as MessageReceived).message.content[0]).toMatchObject({ ingressFailure: 'resource-unavailable' });
  });

  it('leaves image parts without resourceRef untouched', async () => {
    const port = new FakeMediaPort();
    const hydrator = new ImageHydrator({ mediaPort: port });
    const event = {
      type: 'message.received' as const,
      channel: 'lark' as const,
      accountId: 'main' as const,
      conversation: { id: 'oc_1', type: 'group' as const },
      sender: { id: 'ou_1' },
      message: {
        id: 'om_in_4', createdAt: 1,
        content: [{ type: 'image' as const, url: 'https://example.com/pic.png', alt: 'web' },
                  { type: 'image' as const, alt: 'no locator' }],
      },
      raw: {},
    };
    await hydrator.hydrateImages(event as MessageReceived);
    const parts = (event as MessageReceived).message.content;
    expect(parts[0]).toEqual({ type: 'image', url: 'https://example.com/pic.png', alt: 'web' });
    expect(parts[1]).toEqual({ type: 'image', alt: 'no locator' });
    expect(port.calls).toHaveLength(0);
  });
});

describe('InboundProcessor hydration wiring', () => {
  it('emits an event whose image part carries localData + mimeType (text still delivered)', async () => {
    const port = new FakeMediaPort();
    const { service, processor } = makeProcessor(port);
    const listener = vi.fn();
    service.on(listener);
    await processor.handle({
      type: 'image',
      msgId: 'om_in_5',
      senderId: 'ou_1',
      conversationId: 'oc_1',
      picUrl: 'img_v2_abc',
    });
    const event = listener.mock.calls[0]?.[0] as MessageReceived;
    expect(event.type).toBe('message.received');
    const image = event.message.content[0] as {
      localData?: Uint8Array;
      mimeType?: string;
      resourceRef?: string;
    };
    expect(image.resourceRef).toBe('img_v2_abc');
    expect(image.localData).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(image.mimeType).toBe('image/png');
    // messageId for messageResource.get came from the invocation context.
    expect(port.calls).toEqual([{ messageId: 'om_in_5', resourceKey: 'img_v2_abc' }]);
  });

  it('failure keeps resourceRef + ingressFailure and still emits (text not blocked)', async () => {
    const port = new FakeMediaPort();
    port.downloadError = new Error('boom');
    const { service, processor } = makeProcessor(port);
    const listener = vi.fn();
    service.on(listener);
    await processor.handle({
      type: 'image',
      msgId: 'om_in_6',
      senderId: 'ou_1',
      conversationId: 'oc_1',
      picUrl: 'img_v2_boom',
    });
    // The event was still emitted despite the download failure.
    const event = listener.mock.calls[0]?.[0] as MessageReceived;
    expect(event.type).toBe('message.received');
    const image = event.message.content[0] as {
      resourceRef?: string;
      localData?: Uint8Array;
      ingressFailure?: string;
    };
    expect(image.resourceRef).toBe('img_v2_boom');
    expect(image.ingressFailure).toBe('download-failed');
    expect(image.localData).toBeUndefined();
  });

  it('does not hydrate when no media port is injected', async () => {
    const { service, processor } = makeProcessor(undefined);
    const listener = vi.fn();
    service.on(listener);
    await processor.handle({
      type: 'image',
      msgId: 'om_in_7',
      senderId: 'ou_1',
      conversationId: 'oc_1',
      picUrl: 'img_v2_noport',
    });
    const event = listener.mock.calls[0]?.[0] as MessageReceived;
    expect(event.message.content[0]).toEqual({ type: 'image', resourceRef: 'img_v2_noport' });
  });
});

describe('File hydration (M7A generic file ingress)', () => {
  it('populates localData + mimeType + name on a resourceRef file part (type file)', async () => {
    const port = new FakeMediaPort();
    port.downloadResult = {
      data: new Uint8Array([1, 2, 3, 4]),
      mimeType: 'application/pdf',
      name: 'doc.pdf',
    };
    const hydrator = new ImageHydrator({ mediaPort: port });
    const event = {
      type: 'message.received' as const,
      channel: 'lark' as const,
      accountId: 'main' as const,
      conversation: { id: 'oc_1', type: 'group' as const },
      sender: { id: 'ou_1' },
      message: { id: 'om_file_1', createdAt: 1, content: [{ type: 'file' as const, resourceRef: 'file_v2_abc', name: 'doc.pdf' }] },
      raw: {},
    };
    await hydrator.hydrateImages(event as MessageReceived);
    const file = (event as MessageReceived).message.content[0] as {
      localData?: Uint8Array;
      mimeType?: string;
      name?: string;
      resourceRef?: string;
      ingressFailure?: string;
    };
    expect(file.localData).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(file.mimeType).toBe('application/pdf');
    expect(file.name).toBe('doc.pdf');
    expect(file.resourceRef).toBe('file_v2_abc');
    expect(file.ingressFailure).toBeUndefined();
    // The port was called with type 'file'.
    expect(port.calls).toEqual([{ messageId: 'om_file_1', resourceKey: 'file_v2_abc' }]);
  });

  it('keeps resourceRef and records download-failed on a file download failure', async () => {
    const port = new FakeMediaPort();
    port.downloadError = new Error('network timeout');
    const hydrator = new ImageHydrator({ mediaPort: port });
    const event = {
      type: 'message.received' as const,
      channel: 'lark' as const,
      accountId: 'main' as const,
      conversation: { id: 'oc_1', type: 'group' as const },
      sender: { id: 'ou_1' },
      message: { id: 'om_file_2', createdAt: 1, content: [{ type: 'file' as const, resourceRef: 'file_v2_nope' }] },
      raw: {},
    };
    await hydrator.hydrateImages(event as MessageReceived);
    const file = (event as MessageReceived).message.content[0] as {
      resourceRef?: string;
      localData?: Uint8Array;
      ingressFailure?: string;
    };
    expect(file.resourceRef).toBe('file_v2_nope');
    expect(file.localData).toBeUndefined();
    expect(file.ingressFailure).toBe('download-failed');
  });

  it('records resource-unavailable for a missing file resource', async () => {
    const port = new FakeMediaPort();
    port.downloadError = new Error('resource not found');
    const hydrator = new ImageHydrator({ mediaPort: port });
    const event = {
      type: 'message.received' as const,
      channel: 'lark' as const,
      accountId: 'main' as const,
      conversation: { id: 'oc_1', type: 'group' as const },
      sender: { id: 'ou_1' },
      message: { id: 'om_file_3', createdAt: 1, content: [{ type: 'file' as const, resourceRef: 'file_v2_gone' }] },
      raw: {},
    };
    await hydrator.hydrateImages(event as MessageReceived);
    expect((event as MessageReceived).message.content[0]).toMatchObject({ ingressFailure: 'resource-unavailable' });
  });
});

describe('InboundProcessor file hydration wiring (M7A)', () => {
  it('emits a file event whose file part carries localData + name; text still delivered', async () => {
    const port = new FakeMediaPort();
    port.downloadResult = {
      data: new Uint8Array([9, 9, 9]),
      mimeType: 'application/pdf',
      name: 'contract.pdf',
    };
    const { service, processor } = makeProcessor(port);
    const listener = vi.fn();
    service.on(listener);
    await processor.handle({
      type: 'file',
      msgId: 'om_file_5',
      senderId: 'ou_1',
      conversationId: 'oc_1',
      mediaUrl: 'file_v2_xyz',
      title: 'contract.pdf',
    });
    const event = listener.mock.calls[0]?.[0] as MessageReceived;
    expect(event.type).toBe('message.received');
    const file = event.message.content[0] as {
      localData?: Uint8Array;
      mimeType?: string;
      name?: string;
      resourceRef?: string;
    };
    expect(file.resourceRef).toBe('file_v2_xyz');
    expect(file.localData).toEqual(new Uint8Array([9, 9, 9]));
    expect(file.mimeType).toBe('application/pdf');
    expect(file.name).toBe('contract.pdf');
    expect(port.calls).toEqual([{ messageId: 'om_file_5', resourceKey: 'file_v2_xyz' }]);
  });

  it('a file download failure keeps resourceRef + ingressFailure and emits (not blocked)', async () => {
    const port = new FakeMediaPort();
    port.downloadError = new Error('boom');
    const { service, processor } = makeProcessor(port);
    const listener = vi.fn();
    service.on(listener);
    await processor.handle({
      type: 'file',
      msgId: 'om_file_6',
      senderId: 'ou_1',
      conversationId: 'oc_1',
      mediaUrl: 'file_v2_boom',
      title: 'broken.pdf',
    });
    const event = listener.mock.calls[0]?.[0] as MessageReceived;
    expect(event.type).toBe('message.received');
    const file = event.message.content[0] as {
      resourceRef?: string;
      localData?: Uint8Array;
      ingressFailure?: string;
    };
    expect(file.resourceRef).toBe('file_v2_boom');
    expect(file.ingressFailure).toBe('download-failed');
    expect(file.localData).toBeUndefined();
  });
});
