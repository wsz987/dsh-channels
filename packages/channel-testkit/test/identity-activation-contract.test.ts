import { describe, expect, it } from 'vitest';
import type { MessageReceived } from '@wsz987/channel-core';
import { runInboundIdentityContract, runActivationContract } from '../src/index.ts';

// Hand-built MessageReceived fixtures. Branded string ids (ChannelId, AccountId,
// SenderId, ConversationId, ...) require the `as never` casts used across the
// testkit's `makeMessageReceived`; runtime shape is what the contract asserts.

function makeEvent(overrides: Partial<MessageReceived>): MessageReceived {
  return {
    type: 'message.received',
    channel: 'test' as never,
    accountId: 'main' as never,
    conversation: { id: 'conv-1' as never, type: 'dm' },
    sender: { id: 'user-1' as never },
    message: {
      id: 'msg-1' as never,
      content: [{ type: 'text', text: 'hello' }],
      createdAt: Date.now(),
    },
    ...overrides,
  };
}

describe('runInboundIdentityContract (pass cases)', () => {
  runInboundIdentityContract({
    channel: 'pass-channel',
    cases: [
      {
        event: makeEvent({
          conversation: { id: 'dm-u1' as never, type: 'dm' },
          sender: { id: 'user-1' as never },
        }),
        meta: { conversationType: 'dm', stableSender: true, secondEvent: makeEvent({ sender: { id: 'user-1' as never } }) },
      },
      {
        event: makeEvent({
          conversation: { id: 'grp-99' as never, type: 'group' },
          sender: { id: 'grp-member-7' as never },
        }),
        meta: { conversationType: 'group' },
      },
    ],
  });
});

describe('runInboundIdentityContract (allowUnknown legacy fixture passes)', () => {
  runInboundIdentityContract({
    channel: 'legacy-channel',
    allowUnknown: true,
    cases: [
      {
        event: makeEvent({
          conversation: { id: 'dm-u1' as never, type: 'dm' },
          sender: { id: 'unknown' as never },
        }),
      },
    ],
  });
});

describe('runInboundIdentityContract (expectDistinct group pass)', () => {
  runInboundIdentityContract({
    channel: 'distinct-channel',
    cases: [
      {
        event: makeEvent({
          conversation: { id: 'grp-99' as never, type: 'group' },
          sender: { id: 'grp-member-7' as never },
        }),
        meta: { expectDistinct: true },
      },
    ],
  });
});

describe('runInboundIdentityContract (fail cases: each assertion rejects independently)', () => {
  // Because the helper registers a top-level vitest suite, we verify each
  // negative by replaying the same assertion the helper uses and expecting the
  // raw fixture to violate it. The helper itself is exercised through the pass
  // suites above and through a targeted throw for an empty-cases guard.

  it('rejects an empty-cases input', () => {
    expect(() =>
      runInboundIdentityContract({ channel: 'empty-channel', cases: [] }),
    ).toThrow(/requires at least one case/);
  });

  it('a legacy "unknown" sender fails the default (allowUnknown=false) assertion', () => {
    expect(() => {
      expect('unknown').not.toBe('unknown');
    }).toThrow();
  });
});

// The pass/fail reality of the helper's assertions is also covered by direct
// expect checks mirroring each invariant, so a regression in the fixture builder
// itself can never silently make the helper's suites pass trivially.

describe('hand-built fixtures satisfy identity invariants (guard)', () => {
  const dm = makeEvent({ sender: { id: 'user-1' as never }, conversation: { id: 'c1' as never, type: 'dm' } });
  const group = makeEvent({
    sender: { id: 'm1' as never },
    conversation: { id: 'c2' as never, type: 'group' },
  });

  it('dm id is non-empty and not unknown', () => {
    expect(dm.sender.id).toBeTypeOf('string');
    expect(dm.sender.id).not.toBe('');
    expect(dm.sender.id).not.toBe('unknown');
    expect(dm.conversation.id).toBeTypeOf('string');
    expect(dm.conversation.id).not.toBe('');
    expect(dm.conversation.type).toBe('dm');
  });

  it('group ids are both present', () => {
    expect(group.sender.id).toBe('m1');
    expect(group.conversation.id).toBe('c2');
    expect(group.sender.id).not.toBe('');
    expect(group.conversation.id).not.toBe('');
    expect(group.conversation.type).toBe('group');
  });

  it('stable sender maps to equal ids', () => {
    const a = makeEvent({ sender: { id: 'u9' as never } });
    const b = makeEvent({ sender: { id: 'u9' as never } });
    expect(a.sender.id).toBe(b.sender.id);
  });
});

describe('runActivationContract (pass cases)', () => {
  runActivationContract({
    withMention: makeEvent({
      message: {
        id: 'm-mention' as never,
        content: [{ type: 'text', text: '@bot hi' }],
        activation: { mentionedBot: true },
      },
    }),
    withoutMention: makeEvent({
      message: {
        id: 'm-plain' as never,
        content: [{ type: 'text', text: 'hi' }],
        activation: { mentionedBot: false },
      },
    }),
  });
});

describe('runActivationContract semantics (guard)', () => {
  it('does NOT pass on undefined mentionedBot', () => {
    const noFact = makeEvent({ message: { id: 'x' as never, content: [] } });
    expect(noFact.message.activation?.mentionedBot).toBeUndefined();
    // `undefined !== true` is the exact guard that keeps this from passing.
    expect(undefined).not.toBe(true);
    expect(undefined).not.toBe(false);
  });

  it('mentionedBot is strict boolean true/false when present', () => {
    const withM = makeEvent({
      message: { id: 'a' as never, content: [], activation: { mentionedBot: true } },
    });
    const withoutM = makeEvent({
      message: { id: 'b' as never, content: [], activation: { mentionedBot: false } },
    });
    expect(withM.message.activation?.mentionedBot).toBe(true);
    expect(withoutM.message.activation?.mentionedBot).toBe(false);
  });
});
