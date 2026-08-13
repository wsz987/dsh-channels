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
import type { ChannelAdapter } from '@dsh/channel-core';
import { ReplyRouter } from '../src/reply-router.ts';
import type { SessionBinding } from '../src/session-router.ts';

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
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeRouter(
  adapter: ChannelAdapter,
  reply: Partial<{ updateIntervalMs: number; maxTextLength: number }> = {},
): ReplyRouter {
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
