import { runActivationContract } from '@wsz987/channel-testkit';
import { mapInbound } from '../src/mapper.ts';

const meta = { channel: 'dingtalk' as never, accountId: 'main' as never };

runActivationContract({
  withMention: mapInbound({
    type: 'text',
    msgId: 'mention-true',
    senderId: 'member-1',
    conversationId: 'group-1',
    conversationType: '2',
    content: 'hello',
    mentionedBot: true,
  }, meta),
  withoutMention: mapInbound({
    type: 'text',
    msgId: 'mention-false',
    senderId: 'member-1',
    conversationId: 'group-1',
    conversationType: '2',
    content: 'hello',
    mentionedBot: false,
  }, meta),
});
