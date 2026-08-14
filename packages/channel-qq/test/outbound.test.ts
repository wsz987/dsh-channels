/**
 * Outbound tests (fully offline): DSH ChannelTarget/message → SDK ReplyTarget.
 */
import { describe, expect, it } from 'vitest';
import { ChannelSendError } from '@dsh/channel-core';
import type { ChannelTarget } from '@dsh/channel-core';
import { MediaFileType } from '@tencent-connect/qqbot-nodejs';
import { FakeQQSdkClient, decodeDataUri, mediaOpts } from '../src/sdk-client.ts';
import { OutboundSender, toReplyTarget } from '../src/outbound.ts';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function targetFn(): ChannelTarget {
  return {
    channelId: 'qq' as never,
    accountId: 'main' as never,
    conversationId: 'conv_1' as never,
  };
}

describe('toReplyTarget', () => {
  it('maps a dm target to c2c scope', () => {
    expect(
      toReplyTarget({
        ...targetFn(),
        conversationType: 'dm',
        replyToMessageId: 'msg_9' as never,
      }),
    ).toEqual({ scope: 'c2c', targetId: 'conv_1', msgId: 'msg_9' });
  });

  it('maps a group target to group scope', () => {
    expect(toReplyTarget({ ...targetFn(), conversationType: 'group' })).toEqual({
      scope: 'group',
      targetId: 'conv_1',
      msgId: undefined,
    });
  });

  it('defaults to c2c when conversationType is absent', () => {
    expect(toReplyTarget(targetFn())).toEqual({ scope: 'c2c', targetId: 'conv_1', msgId: undefined });
  });
});

describe('OutboundSender', () => {
  it('sends a text-only message via sendText', async () => {
    const client = new FakeQQSdkClient();
    const sender = new OutboundSender(client, silentLogger);
    const result = await sender.send(
      { ...targetFn(), conversationType: 'dm', replyToMessageId: 'msg_9' as never },
      { text: 'hi there' },
    );
    expect(result.delivered).toBe(true);
    expect(client.textCalls).toEqual([
      { target: { scope: 'c2c', targetId: 'conv_1', msgId: 'msg_9' }, text: 'hi there' },
    ]);
    expect(client.mediaCalls).toHaveLength(0);
  });

  it('sends an image via sendMedia', async () => {
    const client = new FakeQQSdkClient();
    const sender = new OutboundSender(client, silentLogger);
    await sender.send(targetFn(), {
      parts: [{ type: 'image', url: 'https://e/p.png', alt: 'chart' }],
    });
    expect(client.mediaCalls).toHaveLength(1);
    expect(client.mediaCalls[0]?.target).toEqual({ scope: 'c2c', targetId: 'conv_1', msgId: undefined });
    expect(client.mediaCalls[0]?.message.parts).toEqual([
      { type: 'image', url: 'https://e/p.png', alt: 'chart' },
    ]);
    expect(client.textCalls).toHaveLength(0);
  });

  it('sends audio/video/file via sendMedia', async () => {
    const client = new FakeQQSdkClient();
    const sender = new OutboundSender(client, silentLogger);
    await sender.send(targetFn(), { parts: [{ type: 'audio', url: 'https://e/a.wav' }] });
    await sender.send(targetFn(), { parts: [{ type: 'video', url: 'https://e/c.mp4' }] });
    await sender.send(targetFn(), {
      parts: [{ type: 'file', url: 'https://e/r.pdf', name: 'r.pdf' }],
    });
    expect(client.mediaCalls).toHaveLength(3);
  });

  it('wraps a send failure in ChannelSendError', async () => {
    const client = new FakeQQSdkClient();
    client.sendError = new Error('platform down');
    const sender = new OutboundSender(client, silentLogger);
    await expect(sender.send(targetFn(), { text: 'hi' })).rejects.toBeInstanceOf(ChannelSendError);
    await expect(sender.send(targetFn(), { text: 'hi' })).rejects.toMatchObject({
      code: 'CHANNEL_SEND_FAILED',
    });
  });
});

describe('mediaOpts (dataUri → fileData)', () => {
  it('decodes an image dataUri into fileData (not url)', () => {
    const opts = mediaOpts({ parts: [{ type: 'image', dataUri: 'data:image/png;base64,AAAA' }] });
    expect(opts.fileType).toBe(MediaFileType.IMAGE);
    expect(opts.fileData).toBe('AAAA');
    expect(opts.url).toBeUndefined();
  });

  it('decodes audio/video/file dataUri into fileData (not url)', () => {
    const audio = mediaOpts({ parts: [{ type: 'audio', dataUri: 'data:audio/wav;base64,UKlG' }] });
    expect(audio.fileType).toBe(MediaFileType.VOICE);
    expect(audio.fileData).toBe('UKlG');
    expect(audio.url).toBeUndefined();

    const video = mediaOpts({ parts: [{ type: 'video', dataUri: 'data:video/mp4;base64,BBBB' }] });
    expect(video.fileType).toBe(MediaFileType.VIDEO);
    expect(video.fileData).toBe('BBBB');
    expect(video.url).toBeUndefined();

    const file = mediaOpts({
      parts: [{ type: 'file', dataUri: 'data:application/pdf;base64,JVBER', name: 'r.pdf' }],
    });
    expect(file.fileType).toBe(MediaFileType.FILE);
    expect(file.fileData).toBe('JVBER');
    expect(file.fileName).toBe('r.pdf');
    expect(file.url).toBeUndefined();
  });

  it('keeps a real http(s) url as url (not fileData)', () => {
    const opts = mediaOpts({ parts: [{ type: 'image', url: 'https://e/p.png' }] });
    expect(opts.fileType).toBe(MediaFileType.IMAGE);
    expect(opts.url).toBe('https://e/p.png');
    expect(opts.fileData).toBeUndefined();
  });

  it('rejects a non-base64 dataUri', () => {
    expect(() => mediaOpts({ parts: [{ type: 'image', dataUri: 'not-a-data-uri' }] })).toThrow(
      'unsupported media data URI',
    );
  });

  it('decodeDataUri strips the mime/prefix and returns the base64 payload', () => {
    expect(decodeDataUri('data:image/png;base64,AAAA==')).toBe('AAAA==');
    expect(decodeDataUri('data:;base64,AAAA')).toBe('AAAA');
  });
});
