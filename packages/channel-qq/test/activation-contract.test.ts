import { runActivationContract } from '@wsz987/channel-testkit';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { mapInbound } from '../src/mapper.ts';

const meta = { channel: 'qq' as never, accountId: 'main' as never };

function group(rawEventType: string): QQBotInboundMessage {
  return {
    rawEventType,
    kind: 'group',
    senderId: 'member_openid_1',
    content: rawEventType === 'GROUP_AT_MESSAGE_CREATE' ? '<@!bot_app_id> 2' : '2',
    messageId: `msg-${rawEventType}`,
    timestamp: '2026-08-27T10:00:00+08:00',
    groupOpenid: 'group_openid_1',
    replyTarget: { scope: 'group', targetId: 'group_openid_1' },
    raw: {},
  } as QQBotInboundMessage;
}

runActivationContract({
  withMention: mapInbound(group('GROUP_AT_MESSAGE_CREATE'), meta),
  withoutMention: mapInbound(group('GROUP_MESSAGE_CREATE'), meta),
});
