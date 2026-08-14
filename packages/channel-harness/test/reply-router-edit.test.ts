/**
 * ReplyRouter `edit`-strategy contract tests (M2 "Rich Streaming").
 *
 * Locks in the generic capability-negotiated streaming pipeline that the
 * DingTalk AI Card path relies on: `assistant/chunk` (text-delta) → throttled
 * `handle.replace` previews → `finish` at `turn/end` → `fail` on mid-stream
 * errors. No platform identifiers appear anywhere — the strategy comes only
 * from `adapter.capabilities.streaming`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { ChannelAdapter } from '@wsz987/channel-core';
import { ReplyRouter } from '../src/reply-router.ts';
import { SESSION_BINDING_SCHEMA_VERSION, type SessionBinding } from '../src/session-router.ts';
import { ReplyContextStore } from '../src/reply-context-store.ts';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function fakeSession(id: string): Session {
  return { id } as unknown as Session;
}

function turnStartEvent(turn: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: 0, time: Date.now(), data: { turn } };
}

function chunkEvent(turn: number, text: string): SessionEvent<'assistant/chunk'> {
  return {
    type: 'assistant/chunk',
    seq: 1,
    time: Date.now(),
    data: { turn, step: 0, chunk: { type: 'text-delta', index: 0, text } },
  };
}

function assistantMessageEvent(turn: number, text: string): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq: 1,
    time: Date.now(),
    data: {
      turn,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    },
  };
}

function turnEndEvent(turn: number): SessionEvent<'turn/end'> {
  return {
    type: 'turn/end',
    seq: 2,
    time: Date.now(),
    data: { turn, reason: { kind: 'completed' } },
  };
}

interface EditRecording {
  replaceCalls: string[];
  finishCalls: string[];
  failCalls: unknown[];
  text: string;
}

/** Adapter with `streaming: 'edit'` whose handle records every call. */
function makeEditAdapter(): { adapter: ChannelAdapter; created: EditRecording[] } {
  const created: EditRecording[] = [];
  const adapter = {
    id: 'edit-fake',
    capabilities: {
      text: true,
      image: false,
      file: false,
      audio: false,
      video: false,
      markdown: true,
      cards: true,
      reactions: false,
      threads: false,
      streaming: 'edit',
    },
    start: async () => {},
    stop: async () => {},
    send: async () => ({ delivered: true }),
    createReply: async () => {
      const entry: EditRecording = {
        replaceCalls: [],
        finishCalls: [],
        failCalls: [],
        text: '',
      };
      created.push(entry);
      return {
        append: async (delta: string) => {
          entry.text += delta;
        },
        replace: async (message: { text?: string }) => {
          const text = message.text ?? '';
          entry.replaceCalls.push(text);
          entry.text = text;
        },
        finish: async (message?: { text?: string }) => {
          const text = message?.text ?? entry.text;
          entry.finishCalls.push(text);
          entry.text = text;
        },
        fail: async (error: unknown) => {
          entry.failCalls.push(error);
        },
      };
    },
  };
  return { adapter: adapter as unknown as ChannelAdapter, created };
}

function makeBinding(sessionId = 's1'): SessionBinding {
  return {
    channelId: 'edit-fake',
    accountId: 'main',
    conversationId: 'u1',
    sessionId,
    route: { preset: 'default' },
    schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Seed a channel-inbound context (register + claim) for one turn. */
function seedChannelTurn(store: ReplyContextStore, turn = 0, sessionId = 's1'): void {
  store.register(`harness_${turn}`, {
    sessionId,
    context: { conversationType: 'dm', replyToMessageId: `qq_${turn}` },
  });
  store.claim({ sessionId, messageId: `harness_${turn}`, turn });
}

/** A ReplyContextStore pre-seeded with a channel-inbound context for `turn`. */
function seededStore(turn = 0): ReplyContextStore {
  const store = new ReplyContextStore();
  seedChannelTurn(store, turn);
  return store;
}

function makeRouter(
  adapter: ChannelAdapter,
  reply: Partial<{ updateIntervalMs: number; maxTextLength: number }> = {},
): ReplyRouter {
  const replyContexts = seededStore(0);
  return new ReplyRouter({
    config: {
      updateIntervalMs: reply.updateIntervalMs ?? 0,
      maxTextLength: reply.maxTextLength,
      splitParagraphs: true,
      splitCodeBlocks: true,
      finalFlush: true,
    },
    getAdapter: () => adapter,
    getBinding: () => makeBinding(),
    replyContexts,
    logger: silentLogger,
  });
}

describe('ReplyRouter edit strategy', () => {
  it('replaces with cumulative text per delta and finalizes once', async () => {
    const { adapter, created } = makeEditAdapter();
    const router = makeRouter(adapter);
    const session = fakeSession('s1');

    router.onSessionEvent(session, turnStartEvent(0));
    router.onSessionEvent(session, chunkEvent(0, 'hi'));
    router.onSessionEvent(session, chunkEvent(0, ' world'));
    router.onSessionEvent(session, turnEndEvent(0));

    await vi.waitFor(() => {
      expect(created[0]?.finishCalls).toHaveLength(1);
    });
    expect(created).toHaveLength(1); // one card, updated in place
    // Serialized flushes coalesce: the single flush reads the full buffer.
    expect(created[0]?.replaceCalls).toEqual(['hi world']);
    expect(created[0]?.finishCalls[0]).toBe('hi world');
    expect(created[0]?.failCalls).toHaveLength(0);
    await vi.waitFor(() => {
      expect(router.activeSessions()).toEqual([]);
    });
  });

  it('throttles previews strictly below the chunk count', async () => {
    const { adapter, created } = makeEditAdapter();
    const router = makeRouter(adapter, { updateIntervalMs: 30 });
    const session = fakeSession('s1');

    router.onSessionEvent(session, turnStartEvent(0));
    for (const c of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      router.onSessionEvent(session, chunkEvent(0, c));
    }

    // Let the throttle window elapse so the pending timer fires.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(created[0]?.replaceCalls.length).toBeLessThan(8);
    expect(created[0]?.text).toBe('abcdefgh');

    router.onSessionEvent(session, turnEndEvent(0));
    await vi.waitFor(() => {
      expect(router.activeSessions()).toEqual([]);
    });
  });

  it('flushes deltas pending in the throttle window at turn/end (no data loss)', async () => {
    const { adapter, created } = makeEditAdapter();
    const router = makeRouter(adapter, { updateIntervalMs: 30 });
    const session = fakeSession('s1');

    router.onSessionEvent(session, turnStartEvent(0));
    router.onSessionEvent(session, chunkEvent(0, 'a'));
    await vi.waitFor(() => {
      expect(created[0]?.replaceCalls).toEqual(['a']);
    });
    // b and c arrive inside the throttle window; turn/end fires before the
    // pending timer. The final content must still be complete.
    router.onSessionEvent(session, chunkEvent(0, 'b'));
    router.onSessionEvent(session, chunkEvent(0, 'c'));
    router.onSessionEvent(session, turnEndEvent(0));

    await vi.waitFor(() => {
      expect(created[0]?.finishCalls).toHaveLength(1);
    });
    expect(created[0]?.finishCalls[0]).toBe('abc');
  });

  it('marks the reply failed and cleans the session when a preview update throws', async () => {
    // The failing adapter throws on every replace from the start (no
    // mid-flight mutation — deterministic by construction).
    const created: { failCalls: unknown[]; replaceCalls: string[] }[] = [];
    const adapter = {
      id: 'failing-fake',
      capabilities: {
        text: true,
        image: false,
        file: false,
        audio: false,
        video: false,
        markdown: true,
        cards: true,
        reactions: false,
        threads: false,
        streaming: 'edit',
      },
      start: async () => {},
      stop: async () => {},
      send: async () => ({ delivered: true }),
      createReply: async () => {
        const entry = { failCalls: [] as unknown[], replaceCalls: [] as string[] };
        created.push(entry);
        return {
          append: async () => {},
          replace: async (message: { text?: string }) => {
            entry.replaceCalls.push(message.text ?? '');
            throw new Error('card update rejected');
          },
          finish: async () => {},
          fail: async (error: unknown) => {
            entry.failCalls.push(error);
          },
        };
      },
    };
    const router = new ReplyRouter({
      config: {
        updateIntervalMs: 0,
        maxTextLength: undefined,
        splitParagraphs: true,
        splitCodeBlocks: true,
        finalFlush: true,
      },
      getAdapter: () => adapter as unknown as ChannelAdapter,
      getBinding: () => makeBinding(),
      replyContexts: seededStore(),
      logger: silentLogger,
    });
    const session = fakeSession('s1');

    router.onSessionEvent(session, turnStartEvent(0));
    router.onSessionEvent(session, chunkEvent(0, 'boom'));
    await vi.waitFor(() => {
      expect(created[0]?.failCalls).toHaveLength(1);
    });
    expect(created[0]?.failCalls[0]).toBeInstanceOf(Error);

    router.onSessionEvent(session, turnEndEvent(0));
    await vi.waitFor(() => {
      expect(router.activeSessions()).toEqual([]);
    });
  });

  it('degrades to buffered delivery when createReply is absent', async () => {
    const sent: { text?: string }[] = [];
    const adapter = {
      id: 'no-card',
      capabilities: {
        text: true,
        image: false,
        file: false,
        audio: false,
        video: false,
        markdown: true,
        cards: false,
        reactions: false,
        threads: false,
        streaming: 'edit' as const,
      },
      start: async () => {},
      stop: async () => {},
      send: async (_target: unknown, message: { text?: string }) => {
        sent.push(message);
        return { delivered: true };
      },
    };
    const router = new ReplyRouter({
      config: {
        updateIntervalMs: 0,
        maxTextLength: undefined,
        splitParagraphs: true,
        splitCodeBlocks: true,
        finalFlush: true,
      },
      getAdapter: () => adapter as unknown as ChannelAdapter,
      getBinding: () => makeBinding(),
      replyContexts: seededStore(),
      logger: silentLogger,
    });
    const session = fakeSession('s1');

    router.onSessionEvent(session, turnStartEvent(0));
    router.onSessionEvent(session, chunkEvent(0, 'hello '));
    router.onSessionEvent(session, chunkEvent(0, 'world'));
    router.onSessionEvent(session, turnEndEvent(0));

    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.text).toBe('hello world');
  });

  it('produces no reply for an empty turn', async () => {
    const { adapter, created } = makeEditAdapter();
    const router = makeRouter(adapter);
    const session = fakeSession('s1');

    router.onSessionEvent(session, turnStartEvent(0));
    router.onSessionEvent(session, turnEndEvent(0));

    await vi.waitFor(() => {
      expect(router.activeSessions()).toEqual([]);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(created).toHaveLength(0);
  });

  it('delivers an assistant/message fallback when no deltas flowed', async () => {
    const { adapter, created } = makeEditAdapter();
    const router = makeRouter(adapter);
    const session = fakeSession('s1');

    router.onSessionEvent(session, turnStartEvent(0));
    router.onSessionEvent(session, assistantMessageEvent(0, 'final answer'));
    router.onSessionEvent(session, turnEndEvent(0));

    await vi.waitFor(() => {
      expect(created[0]?.finishCalls).toHaveLength(1);
    });
    expect(created[0]?.finishCalls[0]).toBe('final answer');
  });
});

describe('ReplyRouter message-id → claimed → turn correlation (no cross-wire)', () => {
  it('binds two messages A/B with distinct ids and turns to their OWN targets', async () => {
    // A target-aware adapter records the replyToMessageId each send sees.
    const sent: { target: unknown; text?: string }[] = [];
    const adapter = {
      id: 'target-aware',
      capabilities: {
        text: true,
        image: false,
        file: false,
        audio: false,
        video: false,
        markdown: true,
        cards: false,
        reactions: false,
        threads: false,
        streaming: 'buffered',
      },
      start: async () => {},
      stop: async () => {},
      send: async (target: unknown, message: { text?: string }) => {
        sent.push({ target, text: message.text });
        return { delivered: true };
      },
    };
    const store = new ReplyContextStore();
    const router = new ReplyRouter({
      config: {
        updateIntervalMs: 0,
        maxTextLength: undefined,
        splitParagraphs: true,
        splitCodeBlocks: true,
        finalFlush: true,
      },
      getAdapter: () => adapter as unknown as ChannelAdapter,
      getBinding: () => makeBinding(),
      replyContexts: store,
      logger: silentLogger,
    });
    const session = fakeSession('s1');

    // Message A registers by its own Harness message id; `agent/inbox/claimed`
    // moves it to active turn 1 before any chunk flows.
    store.register('harness_A', {
      sessionId: 's1',
      context: { conversationType: 'dm', replyToMessageId: 'qq_A' },
    });
    store.claim({ sessionId: 's1', messageId: 'harness_A', turn: 1 });
    router.onSessionEvent(session, turnStartEvent(1));
    router.onSessionEvent(session, chunkEvent(1, 'reply for A'));
    router.onSessionEvent(session, turnEndEvent(1));
    await vi.waitFor(() => {
      expect(sent).toHaveLength(1);
    });
    expect(sent[0]?.target).toMatchObject({ replyToMessageId: 'qq_A' });
    expect(store.getTurn('s1', 1)).toBeUndefined(); // released at turn/end

    // Message B, a different id and turn, must target qq_B — never qq_A.
    store.register('harness_B', {
      sessionId: 's1',
      context: { conversationType: 'group', replyToMessageId: 'qq_B' },
    });
    store.claim({ sessionId: 's1', messageId: 'harness_B', turn: 2 });
    router.onSessionEvent(session, turnStartEvent(2));
    router.onSessionEvent(session, chunkEvent(2, 'reply for B'));
    router.onSessionEvent(session, turnEndEvent(2));
    await vi.waitFor(() => {
      expect(sent).toHaveLength(2);
    });
    expect(sent[1]?.target).toMatchObject({
      conversationType: 'group',
      replyToMessageId: 'qq_B',
    });
  });
});

describe('ReplyRouter outbound gate (ReplyContext required)', () => {
  it('does not route a non-channel turn back to channel', async () => {
    const sent: { text?: string }[] = [];
    const adapter = {
      id: 'no-ctx',
      capabilities: {
        text: true,
        image: false,
        file: false,
        audio: false,
        video: false,
        markdown: true,
        cards: false,
        reactions: false,
        threads: false,
        streaming: 'buffered',
      },
      start: async () => {},
      stop: async () => {},
      send: async (_target: unknown, message: { text?: string }) => {
        sent.push(message);
        return { delivered: true };
      },
    };
    // SessionBinding exists (session once belonged to this channel), but there
    // is NO ReplyContext: the turn was triggered by another surface.
    const router = new ReplyRouter({
      config: {
        updateIntervalMs: 0,
        maxTextLength: undefined,
        splitParagraphs: true,
        splitCodeBlocks: true,
        finalFlush: true,
      },
      getAdapter: () => adapter as unknown as ChannelAdapter,
      getBinding: () => makeBinding(),
      replyContexts: new ReplyContextStore(),
      logger: silentLogger,
    });
    const session = fakeSession('s1');

    router.onSessionEvent(session, turnStartEvent(0));
    router.onSessionEvent(session, chunkEvent(0, 'hello'));
    router.onSessionEvent(session, turnEndEvent(0));

    // Give any (wrong) async delivery a chance to run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(0);
  });
});