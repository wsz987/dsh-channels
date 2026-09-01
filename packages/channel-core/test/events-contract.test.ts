import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  ChannelService,
  channelEventEnvelopeSchema,
  conversationRefSchema,
  type MessageReceived,
} from '../src/index.js';

interface ConversationInput {
  id: string;
  type: 'dm' | 'group';
  threadId?: string;
  externalId?: string;
  name?: string;
}

function makeEvent(conversation: ConversationInput): MessageReceived {
  return {
    type: 'message.received',
    channel: 'qq',
    accountId: 'main',
    // Test-only cast: branded id types are satisfied by plain strings here.
    conversation: conversation as MessageReceived['conversation'],
    sender: { id: 'member_1' },
    message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] },
  };
}

describe('conversationRefSchema', () => {
  it('accepts externalId and name when present', () => {
    const result = conversationRefSchema.safeParse({
      id: 'OPEN_A',
      type: 'group',
      externalId: '123456789',
      name: '研发群',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.externalId).toBe('123456789');
      expect(result.data.name).toBe('研发群');
    }
  });

  it('accepts conversations without externalId/name (backward compatible)', () => {
    expect(
      conversationRefSchema.safeParse({ id: 'c1', type: 'dm' }).success,
    ).toBe(true);
    expect(
      conversationRefSchema.safeParse({
        id: 'c1',
        type: 'group',
        threadId: 't1',
      }).success,
    ).toBe(true);
  });

  it('keeps unknown keys (loose), matching the contract schema convention', () => {
    const result = conversationRefSchema.safeParse({
      id: 'c1',
      type: 'dm',
      futureField: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty-string externalId / name and unknown type', () => {
    expect(
      conversationRefSchema.safeParse({
        id: 'c1',
        type: 'dm',
        externalId: '',
      }).success,
    ).toBe(false);
    expect(
      conversationRefSchema.safeParse({
        id: 'c1',
        type: 'dm',
        name: '',
      }).success,
    ).toBe(false);
    expect(
      conversationRefSchema.safeParse({ id: 'c1', type: 'channel' }).success,
    ).toBe(false);
  });
});

describe('event envelope with conversation externalId/name', () => {
  it('validates events carrying externalId/name', () => {
    const event = makeEvent({
      id: 'OPEN_A',
      type: 'group',
      externalId: '123456789',
      name: '研发群',
    });
    expect(channelEventEnvelopeSchema.safeParse(event).success).toBe(true);
  });

  it('validates events without externalId/name (backward compatible)', () => {
    const event = makeEvent({ id: 'c1', type: 'dm' });
    expect(channelEventEnvelopeSchema.safeParse(event).success).toBe(true);
  });

  it('emits events with externalId/name intact through ChannelService', async () => {
    const ctx = new Context();
    new ChannelService(ctx);

    const listener = vi.fn();
    const dispose = ctx.channels.on(listener);

    const event = makeEvent({
      id: 'OPEN_A',
      type: 'group',
      externalId: '123456789',
      name: '研发群',
    });

    await ctx.channels.emit(event);
    expect(listener).toHaveBeenCalledWith(event);
    expect(listener.mock.calls[0]?.[0]?.conversation).toEqual({
      id: 'OPEN_A',
      type: 'group',
      externalId: '123456789',
      name: '研发群',
    });

    dispose();
  });
});
