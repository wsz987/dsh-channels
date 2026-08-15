/**
 * message-converter file-store hook path (plan \u00a750/\u00a754).
 *
 * When a `fileStore` hook is provided, a file/audio/video part with
 * `localData` renders a compact stored-asset descriptor line instead of the
 * `[file: name]` placeholder; without the hook the placeholder is kept and
 * image behavior is unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import { toHarnessUserMessage, partsToText } from '../src/message-converter.ts';
import type { MessageReceived } from '@wsz987/channel-core';
import type { ChannelFileDescriptor } from '../src/file-provider.ts';

function fileEvent(): MessageReceived {
  return {
    type: 'message.received',
    channel: 'weixin',
    accountId: 'main',
    conversation: { id: 'u1', type: 'dm' },
    sender: { id: 'u1' },
    message: {
      id: 'm1',
      content: [
        { type: 'file', name: 'report.pdf', mimeType: 'application/pdf', localData: new Uint8Array([0x25, 0x50, 0x44, 0x46]) },
      ],
    },
  } as unknown as MessageReceived;
}

function descriptor(): ChannelFileDescriptor {
  return {
    attachmentId: 'att-9',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    bytes: 4,
    durable: true,
    readable: false,
  };
}

describe('toHarnessUserMessage file-store hook', () => {
  it('renders a descriptor line when the hook stores the file', async () => {
    const hook = vi.fn(async () => descriptor());
    const message = await toHarnessUserMessage(fileEvent(), { fileStore: hook });
    const text = message.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    expect(hook).toHaveBeenCalledTimes(1);
    expect(text).not.toContain('[file:');
    expect(text).toContain('att-9');
    expect(text).toContain('report.pdf');
  });

  it('falls back to [file: name] without the hook', async () => {
    const message = await toHarnessUserMessage(fileEvent(), {});
    const text = message.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    expect(text).toContain('[file: report.pdf]');
  });

  it('falls back to the placeholder when the hook returns undefined', async () => {
    const hook = vi.fn(async () => undefined);
    const message = await toHarnessUserMessage(fileEvent(), { fileStore: hook });
    const text = message.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
    expect(text).toContain('[file: report.pdf]');
  });
});

describe('partsToText file fallback + image parity', () => {
  it('keeps [file: name] when image path is untouched', async () => {
    const text = await partsToText([
      { type: 'file', name: 'b.pdf' },
      { type: 'image', url: 'https://c/i', mimeType: 'image/jpeg', localData: new Uint8Array([1]) },
      { type: 'audio', durationMs: 500 },
    ]);
    // Image has localData but no saveImage hook -> [image...] placeholder.
    expect(text).toContain('[file: b.pdf]');
    expect(text).toContain('[image:');
    expect(text).toContain('[audio: 500ms]');
  });
});
