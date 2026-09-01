/**
 * Mapper tests (fully offline): Tencent SDK inbound message → Channel event.
 */
import { describe, expect, it } from 'vitest';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { mapInbound, mapMessageParts } from '../src/mapper.ts';

const meta = { channel: 'qq' as never, accountId: 'main' as never };

function inbound(overrides: Partial<QQBotInboundMessage> = {}): QQBotInboundMessage {
  return {
    rawEventType: 'C2C_MESSAGE_CREATE',
    kind: 'c2c',
    senderId: 'user_123',
    senderName: 'alice',
    senderIsBot: false,
    content: 'hi',
    messageId: 'msg_1',
    timestamp: '2026-08-14T10:00:00+08:00',
    replyTarget: { scope: 'c2c', targetId: 'user_123', msgId: 'msg_1' },
    raw: {},
    ...overrides,
  } as QQBotInboundMessage;
}

describe('mapInbound', () => {
  it('maps a c2c message to a dm conversation keyed by senderId', () => {
    const event = mapInbound(inbound({ content: 'hello', senderId: 'user_123' }), meta);
    expect(event.conversation).toEqual({ id: 'user_123', type: 'dm' });
    expect(event.sender).toEqual({ id: 'user_123', name: 'alice' });
    expect(event.message.id).toBe('msg_1');
  });

  it('maps a group message to a group conversation keyed by groupOpenid', () => {
    const event = mapInbound(
      inbound({
        kind: 'group',
        senderId: 'user_321',
        senderName: 'bob',
        groupOpenid: 'group_789',
        content: 'hello group',
        replyTarget: { scope: 'group', targetId: 'group_789', msgId: 'msg_grp_1' },
      }),
      meta,
    );
    expect(event.conversation).toEqual({ id: 'group_789', type: 'group' });
    expect(event.sender).toEqual({ id: 'user_321', name: 'bob' });
    expect(event.message.activation?.mentionedBot).toBe(false);
  });

  it('maps a new-QQ group-at event to a strict mention fact and strips the leading bot marker', () => {
    const event = mapInbound(
      inbound({
        rawEventType: 'GROUP_AT_MESSAGE_CREATE',
        kind: 'group',
        senderId: 'user_321',
        groupOpenid: 'group_789',
        content: '<@!bot_app_id> 2',
        replyTarget: { scope: 'group', targetId: 'group_789', msgId: 'msg_grp_at_1' },
      }),
      meta,
    );
    expect(event.message.activation?.mentionedBot).toBe(true);
    expect(event.message.content).toEqual([{ type: 'text', text: '2' }]);
  });

  it('accepts the SDK structured is_you fact on a generic group event', () => {
    const event = mapInbound(
      inbound({
        rawEventType: 'GROUP_MESSAGE_CREATE',
        kind: 'group',
        senderId: 'user_321',
        groupOpenid: 'group_789',
        mentions: [{ id: 'bot_app_id', is_you: true }],
        content: '<@!bot_app_id> structured mention',
        replyTarget: { scope: 'group', targetId: 'group_789', msgId: 'msg_grp_structured' },
      }),
      meta,
    );
    expect(event.message.activation?.mentionedBot).toBe(true);
    expect(event.message.content).toEqual([{ type: 'text', text: 'structured mention' }]);
  });

  it('uses group_openid as the only QQ group identity even when raw payload includes group_id', () => {
    const event = mapInbound(
      inbound({
        kind: 'group',
        senderId: 'user_321',
        groupOpenid: 'OPEN_A',
        content: 'hello group',
        replyTarget: { scope: 'group', targetId: 'OPEN_A', msgId: 'msg_grp_1' },
        raw: { group_id: '123456789', group_openid: 'OPEN_A' },
      }),
      meta,
    );
    expect(event.conversation).toEqual({
      id: 'OPEN_A',
      type: 'group',
    });
  });

  it('does not let a disagreeing raw group_openid replace the normalized canonical identity', () => {
    const event = mapInbound(
      inbound({
        kind: 'group',
        senderId: 'user_321',
        groupOpenid: 'OPEN_A',
        content: 'hello group',
        replyTarget: { scope: 'group', targetId: 'OPEN_A', msgId: 'msg_grp_1' },
        raw: { group_id: '123456789', group_openid: 'OPEN_B' },
      }),
      meta,
    );
    expect(event.conversation).toEqual({ id: 'OPEN_A', type: 'group' });
  });

  it('still emits group messages when raw payload has no group number', () => {
    const event = mapInbound(
      inbound({
        kind: 'group',
        senderId: 'user_321',
        groupOpenid: 'group_789',
        content: 'hello group',
        replyTarget: { scope: 'group', targetId: 'group_789', msgId: 'msg_grp_1' },
        raw: { group_openid: 'group_789' },
      }),
      meta,
    );
    expect(event.conversation).toEqual({ id: 'group_789', type: 'group' });
  });

  it('does not use an OpenID-looking raw group_id as a separate identity', () => {
    const event = mapInbound(
      inbound({
        kind: 'group',
        senderId: 'user_321',
        groupOpenid: '6AA0C1708977CA97B35AECB8E1EF2C0F',
        content: 'hello group',
        replyTarget: { scope: 'group', targetId: '6AA0C1708977CA97B35AECB8E1EF2C0F', msgId: 'msg_grp_2' },
        raw: {
          group_id: '6AA0C1708977CA97B35AECB8E1EF2C0F',
          group_openid: '6AA0C1708977CA97B35AECB8E1EF2C0F',
        },
      }),
      meta,
    );
    expect(event.conversation).toEqual({
      id: '6AA0C1708977CA97B35AECB8E1EF2C0F',
      type: 'group',
    });
  });

  it('parses createdAt from the ISO timestamp and preserves raw', () => {
    const raw = { id: 'msg_1' };
    const event = mapInbound(inbound({ raw }), meta);
    expect(event.message.createdAt).toBe(1786672800000);
    expect(event.raw).toBe(raw);
  });
});

describe('mapMessageParts', () => {
  it('maps text content to a text part', () => {
    expect(mapMessageParts(inbound({ content: 'hello', attachments: [] }))).toEqual([
      { type: 'text', text: 'hello' },
    ]);
  });

  it('maps an image attachment', () => {
    expect(
      mapMessageParts(
        inbound({
          content: '',
          attachments: [{ content_type: 'image/png', url: 'https://e/p.png', filename: 'p.png' }],
        }),
      ),
    ).toEqual([{ type: 'image', url: 'https://e/p.png', alt: 'p.png' }]);
  });

  it('maps a voice attachment preferring voice_wav_url', () => {
    expect(
      mapMessageParts(
        inbound({
          content: '',
          attachments: [
            {
              content_type: 'voice',
              url: 'https://e/a.silk',
              voice_wav_url: 'https://e/a.wav',
              asr_refer_text: 'hi there',
            },
          ],
        }),
      ),
    ).toEqual([{ type: 'audio', url: 'https://e/a.wav' }]);
  });

  it('maps a voice attachment without wav url to the base url', () => {
    expect(
      mapMessageParts(
        inbound({
          content: '',
          attachments: [{ content_type: 'audio', url: 'https://e/a.amr' }],
        }),
      ),
    ).toEqual([{ type: 'audio', url: 'https://e/a.amr' }]);
  });

  it('maps a video attachment', () => {
    expect(
      mapMessageParts(
        inbound({
          content: '',
          attachments: [{ content_type: 'video/mp4', url: 'https://e/c.mp4' }],
        }),
      ),
    ).toEqual([{ type: 'video', url: 'https://e/c.mp4' }]);
  });

  it('maps a file attachment with name and size', () => {
    expect(
      mapMessageParts(
        inbound({
          content: '',
          attachments: [
            { content_type: 'file', url: 'https://e/r.pdf', filename: 'r.pdf', size: 4096 },
          ],
        }),
      ),
    ).toEqual([{ type: 'file', url: 'https://e/r.pdf', name: 'r.pdf', size: 4096 }]);
  });

  it('maps an unknown attachment to an unsupported part', () => {
    expect(
      mapMessageParts(
        inbound({
          content: '',
          attachments: [{ content_type: 'sticker', url: 'https://e/s.webp' }],
        }),
      ),
    ).toEqual([{ type: 'unsupported', reason: "unknown qq attachment type 'sticker'" }]);
  });

  it('maps text plus attachments together', () => {
    expect(
      mapMessageParts(
        inbound({
          content: 'look:',
          attachments: [{ content_type: 'image/png', url: 'https://e/p.png' }],
        }),
      ),
    ).toEqual([
      { type: 'text', text: 'look:' },
      { type: 'image', url: 'https://e/p.png', alt: undefined },
    ]);
  });
});
