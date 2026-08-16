/**
 * message-converter image-attachment path (WX5 harness attachment).
 */
import { describe, expect, it } from 'vitest';
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { toHarnessUserMessage, partsToText } from '../src/message-converter.ts';
import type { MessageReceived } from '@wsz987/channel-core';

function makeRef(id: string): ImageAttachmentRef {
  return { attachmentId: AttachmentId(id), mediaType: 'image/jpeg', bytes: 4, width: 1, height: 1 };
}

function imageEvent(localData?: Uint8Array): MessageReceived {
  return {
    type: 'message.received',
    channel: 'weixin',
    accountId: 'main',
    conversation: { id: 'u1', type: 'dm' },
    sender: { id: 'u1' },
    message: {
      id: 'm1',
      content: [{ type: 'image', url: 'https://c/i', mimeType: 'image/jpeg', localData }],
    },
  } as unknown as MessageReceived;
}

describe('toHarnessUserMessage image path', () => {
  it('emits an ImageBlock when localData + saveImage are present', async () => {
    const saved: any[] = [];
    const message = await toHarnessUserMessage(imageEvent(new Uint8Array([1, 2, 3, 4])), {
      saveImage: async (input) => {
        saved.push(input);
        return makeRef('att-1');
      },
    });
    const images = message.content.filter((b) => b.type === 'image');
    expect(images).toHaveLength(1);
    expect((images[0] as any).attachment).toEqual(makeRef('att-1'));
    expect(saved).toHaveLength(1);
    expect(saved[0].mediaType).toBe('image/jpeg');
  });

  it('preserves text-image-text block order', async () => {
    const event = imageEvent(new Uint8Array([1, 2, 3, 4]));
    event.message.content = [
      { type: 'text', text: 'before' },
      ...event.message.content,
      { type: 'text', text: 'after' },
    ];
    const message = await toHarnessUserMessage(event, {
      saveImage: async () => makeRef('att-order'),
    });

    expect(message.content.map((block) => block.type)).toEqual(['text', 'image', 'text']);
    expect(message.content[0]).toMatchObject({ text: 'before' });
    expect(message.content[2]).toMatchObject({ text: 'after' });
  });

  it('falls back to the [image] placeholder without localData', async () => {
    const message = await toHarnessUserMessage(imageEvent(undefined));
    const text = message.content.filter((b) => b.type === 'text').map((b: any) => b.text).join('');
    expect(text).toContain('[image:');
    expect(message.content.filter((b) => b.type === 'image')).toHaveLength(0);
  });

  it('falls back to placeholder when saveImage throws', async () => {
    const message = await toHarnessUserMessage(imageEvent(new Uint8Array([1])), {
      saveImage: async () => { throw new Error('no store'); },
    });
    expect(message.content.filter((b) => b.type === 'image')).toHaveLength(0);
    const text = message.content.filter((b) => b.type === 'text').map((b: any) => b.text).join('');
    expect(text).toContain('[image:');
  });
});

describe('partsToText backward compatibility', () => {
  it('keeps non-image placeholders', async () => {
    const text = await partsToText([
      { type: 'audio', durationMs: 500 },
      { type: 'file', name: 'a.pdf' },
      { type: 'unsupported', reason: 'x' },
    ]);
    expect(text).toBe('[audio: 500ms][file: a.pdf][unsupported content]');
  });
});
