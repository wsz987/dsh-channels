/**
 * ReplyContextStore contract tests (QQ-R2, v1.1 §16 + §46 matrix).
 *
 * Locks in the message-id → claimed → turn correlation: the bridge registers
 * a pending context keyed by the Harness UserMessage id BEFORE followup, the
 * `agent/inbox/claimed` listener claims it into an active `sessionId`+`turn`
 * slot, `getTurn` resolves it lazily for the reply pipeline, `releaseTurn`
 * drops it at `turn/end`, and `discard` drops a pending context that never
 * became a turn.
 */
import { describe, expect, it } from 'vitest';
import { ReplyContextStore } from '../src/reply-context-store.ts';

describe('ReplyContextStore', () => {
  it('registers pending by message id and claims into the active turn', () => {
    const store = new ReplyContextStore();
    store.register('msg_A', {
      sessionId: 's1',
      context: { conversationType: 'dm', replyToMessageId: 'qq_A' },
    });
    // Pending by message id.
    expect(store.claim({ sessionId: 's1', messageId: 'msg_A', turn: 1 })).toEqual({
      conversationType: 'dm',
      replyToMessageId: 'qq_A',
    });
    expect(store.getTurn('s1', 1)).toEqual({
      conversationType: 'dm',
      replyToMessageId: 'qq_A',
    });
  });

  it('binds two messages A/B strictly via their own ids to distinct turns (no cross-wire)', () => {
    const store = new ReplyContextStore();
    store.register('msg_A', {
      sessionId: 's1',
      context: { conversationType: 'dm', replyToMessageId: 'qq_A' },
    });
    store.register('msg_B', {
      sessionId: 's1',
      context: { conversationType: 'group', replyToMessageId: 'qq_B' },
    });

    // Claim B first (out of order) — it must still map to its OWN context,
    // not A's. There is no FIFO dependence.
    expect(store.claim({ sessionId: 's1', messageId: 'msg_B', turn: 2 })).toEqual({
      conversationType: 'group',
      replyToMessageId: 'qq_B',
    });
    expect(store.getTurn('s1', 2)).toEqual({
      conversationType: 'group',
      replyToMessageId: 'qq_B',
    });
    // A still pending.
    expect(store.claim({ sessionId: 's1', messageId: 'msg_A', turn: 1 })).toEqual({
      conversationType: 'dm',
      replyToMessageId: 'qq_A',
    });
    expect(store.getTurn('s1', 1)).toEqual({
      conversationType: 'dm',
      replyToMessageId: 'qq_A',
    });
  });

  it('discard drops a pending context before claim (A discarded → gone)', () => {
    const store = new ReplyContextStore();
    store.register('msg_A', {
      sessionId: 's1',
      context: { conversationType: 'dm', replyToMessageId: 'qq_A' },
    });
    store.discard('msg_A');
    expect(store.claim({ sessionId: 's1', messageId: 'msg_A', turn: 1 })).toBeUndefined();
  });

  it('releaseTurn drops the active context (turn 1 end → gone)', () => {
    const store = new ReplyContextStore();
    store.register('msg_A', {
      sessionId: 's1',
      context: { conversationType: 'dm', replyToMessageId: 'qq_A' },
    });
    store.claim({ sessionId: 's1', messageId: 'msg_A', turn: 1 });
    store.releaseTurn('s1', 1);
    expect(store.getTurn('s1', 1)).toBeUndefined();
  });

  it('claim with an unknown messageId returns undefined', () => {
    const store = new ReplyContextStore();
    expect(store.claim({ sessionId: 's1', messageId: 'nope', turn: 1 })).toBeUndefined();
  });

  it('getTurn for an unknown turn returns undefined', () => {
    const store = new ReplyContextStore();
    expect(store.getTurn('s1', 99)).toBeUndefined();
  });

  it('carries raw through register/claim/getTurn', () => {
    const store = new ReplyContextStore();
    const raw = { nested: true };
    store.register('msg_A', {
      sessionId: 's1',
      context: { conversationType: 'group', raw },
    });
    store.claim({ sessionId: 's1', messageId: 'msg_A', turn: 1 });
    expect(store.getTurn('s1', 1)?.raw).toBe(raw);
  });

  it('keeps pending/active independent across sessions', () => {
    const store = new ReplyContextStore();
    store.register('msg_A', {
      sessionId: 's1',
      context: { conversationType: 'dm', replyToMessageId: 'a' },
    });
    store.register('msg_B', {
      sessionId: 's2',
      context: { conversationType: 'group', replyToMessageId: 'b' },
    });
    expect(store.claim({ sessionId: 's1', messageId: 'msg_A', turn: 1 })?.replyToMessageId).toBe('a');
    expect(store.claim({ sessionId: 's2', messageId: 'msg_B', turn: 1 })?.replyToMessageId).toBe('b');
    // Same turn number, different sessions — independent slots.
    expect(store.getTurn('s1', 1)?.replyToMessageId).toBe('a');
    expect(store.getTurn('s2', 1)?.replyToMessageId).toBe('b');
  });
});
