/**
 * OutboundSender file routing (M7A): a FilePart carrying localData is sent via
 * sendFile (which maps to im.v1.file.create → im.message.create upstream); the
 * existing image and text paths are preserved.
 */
import { describe, expect, it, vi } from 'vitest';
import { OutboundSender } from '../src/index.ts';
import type { LarkUpstream, LarkFileRef } from '../src/index.ts';
import type { ChannelTarget, OutboundMessage } from '@wsz987/channel-core';

const target: ChannelTarget = { conversationId: 'oc_456' };

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function fakeUpstream(): LarkUpstream & Record<string, ReturnType<typeof vi.fn>> {
  const outbound: LarkUpstream = {
    receive: vi.fn().mockResolvedValue(undefined),
    sendText: vi.fn().mockResolvedValue({ id: 'out-text' }),
    sendMedia: vi.fn().mockResolvedValue({ id: 'out-img' }),
    sendFile: vi.fn().mockResolvedValue({ id: 'out-file' }),
    createCard: vi.fn().mockResolvedValue({ cardId: 'card-1' }),
    updateCard: vi.fn().mockResolvedValue({}),
    finishCard: vi.fn().mockResolvedValue({}),
    failCard: vi.fn().mockResolvedValue({}),
  };
  return outbound as LarkUpstream & Record<string, ReturnType<typeof vi.fn>>;
}

function message(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return { text: 'hi', parts: [], ...overrides };
}

describe('OutboundSender file routing (M7A)', () => {
  it('sends a pure FilePart with localData via sendFile, with name + mimeType', async () => {
    const upstream = fakeUpstream();
    const sender = new OutboundSender(upstream, silentLogger as never);
    const localData = new Uint8Array([1, 2, 3]);
    const result = await sender.send(target, {
      parts: [{ type: 'file', localData, name: 'doc.pdf', mimeType: 'application/pdf' }],
    });
    expect(result.delivered).toBe(true);
    expect(upstream.sendFile).toHaveBeenCalledTimes(1);
    const invoked = (upstream.sendFile as ReturnType<typeof vi.fn>).mock.calls[0] as [string, LarkFileRef];
    expect(invoked[0]).toBe('oc_456');
    expect(invoked[1]).toEqual({ type: 'file', localData, name: 'doc.pdf', mimeType: 'application/pdf' });
    expect(upstream.sendText).not.toHaveBeenCalled();
    expect(upstream.sendMedia).not.toHaveBeenCalled();
  });

  it('falls back to text when a FilePart lacks localData', async () => {
    const upstream = fakeUpstream();
    const sender = new OutboundSender(upstream, silentLogger as never);
    await sender.send(target, { parts: [{ type: 'file', resourceRef: 'file_v2_x', name: 'x.bin' }] });
    expect(upstream.sendFile).not.toHaveBeenCalled();
    expect(upstream.sendText).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing image path when a message has a pure image and no text', async () => {
    const upstream = fakeUpstream();
    const sender = new OutboundSender(upstream, silentLogger as never);
    await sender.send(target, { parts: [{ type: 'image', url: 'https://x/p.png', alt: 'pic' }] });
    expect(upstream.sendMedia).toHaveBeenCalledTimes(1);
    expect(upstream.sendFile).not.toHaveBeenCalled();
  });

  it('sends text (text carrier wins) when text and a file part coexist', async () => {
    const upstream = fakeUpstream();
    const sender = new OutboundSender(upstream, silentLogger as never);
    await sender.send(target, {
      text: 'caption',
      parts: [{ type: 'file', localData: new Uint8Array([1]), name: 'd.bin' }],
    });
    expect(upstream.sendText).toHaveBeenCalledTimes(1);
    expect(upstream.sendFile).not.toHaveBeenCalled();
    expect(upstream.sendMedia).not.toHaveBeenCalled();
  });
});