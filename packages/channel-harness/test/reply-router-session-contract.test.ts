/**
 * ReplyRouter × rc.2 Session contract tests (upgrade plan §9 / §21 P0-5).
 *
 * Locks the ReplyRouter against the REAL `@deepseek-ai/dsh-session`
 * `0.1.1-rc.2` event model — the fixtures are produced by the real
 * `SessionStore`/`Session.append` (surface metadata, seq contiguity and
 * `session/event` publication all validated/published by the official
 * runtime), not hand-typed shapes that could silently drift.
 *
 * rc.2 facts these tests pin (from `dsh-session` .d.ts, the authority):
 * - `SessionEvent` is a discriminated union over `type` with `seq`/`time`/
 *   `data` on the ENVELOPE (never in `data`).
 * - `sourceEventSeqs?: number[]` and `surfaceOp?: 'append' | { op: 'replace',
 *   start, end }` live on the envelope of the three SurfaceEventType variants
 *   ONLY (`user/message`, `assistant/message`, `tool/result`).
 * - `ignorable?: true` lives on the envelope of ANY event; it marks a record
 *   a reader may safely skip when it does not recognize `type`. It cannot be
 *   produced by `Session.append` (a newer-writer / restored-log envelope
 *   fact), so that fixture is hand-crafted and fed to the testable entry.
 * - `turn/end` carries `reason: TurnEndReason` (`completed` / `aborted` /
 *   `blocked` / `error` / `max-tokens` / `interrupted`).
 * - An aborted turn finalizes its streamed prefix as an `assistant/message`
 *   with `interrupted: true`; an aborted turn with no such event streamed no
 *   visible content.
 *
 * Boundary principle asserted throughout (rc.2 Session Surface contract):
 *   model-facing history  → `session.surface` (replacements shadow nodes);
 *   human transcript      → append-origin events in the raw log.
 * The ReplyRouter consumes ONLY the raw `session/event` firehose
 * (`assistant/chunk`, `assistant/message`, `turn/end`) — the correct
 * human-transcript source — and never reads `session.surface`.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, {
  SessionId,
  foldSurface,
  isAppendSurfaceEvent,
  isReplacementSurfaceEvent,
  type Session,
  type SessionEvent,
} from '@deepseek-ai/dsh-session';
import { CallId, MessageId, type AssistantMessage, type ToolResultMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { ChannelAdapter, ChannelTarget } from '@wsz987/channel-core';
import { ReplyRouter } from '../src/reply-router.ts';
import { SESSION_BINDING_SCHEMA_VERSION, type SessionBinding } from '../src/session-router.ts';
import { ReplyContextStore } from '../src/reply-context-store.ts';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// Fixture builders (rc.2 shapes; brand constructors where the type demands).
// ---------------------------------------------------------------------------

function userMessage(text: string): UserMessage {
  return {
    id: MessageId('m-user'),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    id: MessageId('m-assistant'),
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'fixture', model: 'fixture-model' },
  };
}

function toolResult(text: string): ToolResultMessage {
  return {
    id: MessageId('m-tool'),
    role: 'user',
    content: [
      { type: 'tool-result', toolCallId: CallId('call-1'), content: [{ type: 'text', text }] },
    ],
    source: { kind: 'tool', callId: CallId('call-1') },
  };
}

class BufferedAdapter {
  id = 'contract-fake';
  capabilities = {
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
  } as const;
  sent: { target: ChannelTarget; text?: string }[] = [];
  stopTypingForTargetCalls: ChannelTarget[] = [];
  sendFailure: Error | undefined;
  async start() {}
  async stop() {}
  async send(target: ChannelTarget, message: { text?: string }) {
    if (this.sendFailure) throw this.sendFailure;
    this.sent.push({ target, text: message.text });
    return { delivered: true };
  }
  async stopTypingForTarget(target: ChannelTarget) {
    this.stopTypingForTargetCalls.push(target);
  }
}

function makeBinding(sessionId: string): SessionBinding {
  return {
    channelId: 'contract-fake',
    accountId: 'main',
    conversationId: 'u1',
    conversationType: 'dm',
    sessionId,
    route: { preset: 'default' },
    schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
    createdAt: 1,
    updatedAt: 1,
  };
}

interface ContractFixture {
  ctx: Context;
  session: Session;
  router: ReplyRouter;
  adapter: BufferedAdapter;
  replyContexts: ReplyContextStore;
  detach: () => boolean;
}

/**
 * Real rc.2 stack: a `SessionStore`-published `Session` whose appends flow to
 * the ReplyRouter through the OFFICIAL `session/event` firehose (`attach`),
 * exactly like the production bridge.
 */
function makeFixture(
  sessionId = 'contract-1',
  turn = 0,
  seedReplyContext = true,
  logger = silentLogger,
): ContractFixture {
  const ctx = new Context();
  const sessions = new SessionStore(ctx);
  const session = sessions.create(SessionId(sessionId));
  const adapter = new BufferedAdapter();
  const replyContexts = new ReplyContextStore();
  if (seedReplyContext) {
    replyContexts.register(`harness_${turn}`, {
      sessionId,
      context: { conversationType: 'dm', replyToMessageId: `im_${turn}` },
    });
    replyContexts.claim({ sessionId, messageId: `harness_${turn}`, turn });
  }
  const router = new ReplyRouter({
    config: {
      updateIntervalMs: 0,
      maxTextLength: undefined,
      splitParagraphs: true,
      splitCodeBlocks: true,
      finalFlush: true,
    },
    getAdapter: () => adapter as unknown as ChannelAdapter,
    getBinding: () => makeBinding(sessionId),
    replyContexts,
    logger,
  });
  const detach = router.attach(ctx);
  return { ctx, session, router, adapter, replyContexts, detach };
}

/** Seed the channel ReplyContext for a NEW turn on an existing fixture. */
function seedTurn(replyContexts: ReplyContextStore, sessionId: string, turn: number): void {
  replyContexts.register(`harness_${turn}`, {
    sessionId,
    context: { conversationType: 'dm', replyToMessageId: `im_${turn}` },
  });
  replyContexts.claim({ sessionId, messageId: `harness_${turn}`, turn });
}

/** Append a full successful turn using ONLY real `Session.append` calls. */
function appendSuccessfulTurn(
  session: Session,
  turn: number,
  deltas: string[],
  finalText: string,
): void {
  session.append('turn/start', { turn });
  session.append('user/message', userMessage(`question ${turn}`), { surfaceOp: 'append' });
  session.append('step/start', { turn, step: 0 });
  const chunkSeqs: number[] = [];
  for (const delta of deltas) {
    chunkSeqs.push(
      session.append('assistant/chunk', {
        turn,
        step: 0,
        chunk: { type: 'text-delta', index: 0, text: delta },
      }).seq,
    );
  }
  session.append(
    'assistant/message',
    { turn, step: 0, message: assistantMessage(finalText) },
    { surfaceOp: 'append', sourceEventSeqs: chunkSeqs },
  );
  session.append('step/end', { turn, step: 0 });
  session.append('turn/end', { turn, reason: { kind: 'completed' } });
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

// ---------------------------------------------------------------------------
// Streaming → finalization.
// ---------------------------------------------------------------------------

describe('rc.2 contract: streaming chunks + final assistant/message', () => {
  it('delivers the concatenated chunk text exactly once (buffer wins, no duplication)', async () => {
    const { session, adapter, detach } = makeFixture();
    try {
      appendSuccessfulTurn(session, 0, ['你好', '，', '世界'], '你好，世界（final）');
      await vi.waitFor(() => {
        expect(adapter.sent).toHaveLength(1);
      });
      // The streamed buffer is authoritative; the assistant/message text is
      // only a fallback when no deltas flowed — never appended on top.
      expect(adapter.sent[0]?.text).toBe('你好，世界');
      expect(adapter.sent[0]?.target).toMatchObject({ replyToMessageId: 'im_0' });
    } finally {
      detach();
    }
  });

  it('assistant/message with NO prior deltas is the fallback final text', async () => {
    const { session, adapter, detach } = makeFixture();
    try {
      session.append('turn/start', { turn: 0 });
      session.append('step/start', { turn: 0, step: 0 });
      // Empty provider stream: rc.2 allows a present EMPTY sourceEventSeqs on
      // assistant/message.
      session.append(
        'assistant/message',
        { turn: 0, step: 0, message: assistantMessage('直接定稿') },
        { surfaceOp: 'append', sourceEventSeqs: [] },
      );
      session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
      await vi.waitFor(() => {
        expect(adapter.sent).toHaveLength(1);
      });
      expect(adapter.sent[0]?.text).toBe('直接定稿');
    } finally {
      detach();
    }
  });

  it('resume: a second turn on the SAME session delivers a second reply', async () => {
    const { session, adapter, replyContexts, detach } = makeFixture('contract-resume');
    try {
      appendSuccessfulTurn(session, 0, ['first ', 'turn'], 'first turn');
      // New inbound message on the same conversation → new ReplyContext,
      // next turn number (single-flight session continues).
      seedTurn(replyContexts, 'contract-resume', 1);
      appendSuccessfulTurn(session, 1, ['second ', 'turn'], 'second turn');
      await vi.waitFor(() => {
        expect(adapter.sent).toHaveLength(2);
      });
      expect(adapter.sent[0]?.text).toBe('first turn');
      expect(adapter.sent[1]?.text).toBe('second turn');
      expect(adapter.sent[1]?.target).toMatchObject({ replyToMessageId: 'im_1' });
      // Every turn context is released after turn/end — nothing hangs.
      expect(replyContexts.getActiveForSession('contract-resume')).toBeUndefined();
    } finally {
      detach();
    }
  });
});

// ---------------------------------------------------------------------------
// Append-origin assistant message (human-visible transcript source).
// ---------------------------------------------------------------------------

describe('rc.2 contract: append-origin assistant message (human transcript source)', () => {
  it('routes an append-origin assistant/message and pins the model-vs-human boundary', async () => {
    const { session, adapter, detach } = makeFixture();
    try {
      session.append('turn/start', { turn: 0 });
      session.append('user/message', userMessage('q'), { surfaceOp: 'append' });
      const chunk = session.append('assistant/chunk', {
        turn: 0,
        step: 0,
        chunk: { type: 'text-delta', index: 0, text: 'visible reply' },
      });
      const final = session.append(
        'assistant/message',
        { turn: 0, step: 0, message: assistantMessage('visible reply') },
        { surfaceOp: 'append', sourceEventSeqs: [chunk.seq] },
      );
      session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });

      // Boundary facts (rc.2 Surface contract): the assistant message is an
      // append-origin surface node — the human transcript's durable source —
      // and the router consumes it through the RAW event log, not the surface.
      expect(isAppendSurfaceEvent(final)).toBe(true);
      expect(isReplacementSurfaceEvent(final)).toBe(false);
      expect(final.sourceEventSeqs).toEqual([chunk.seq]);

      await vi.waitFor(() => {
        expect(adapter.sent).toHaveLength(1);
      });
      expect(adapter.sent[0]?.text).toBe('visible reply');
    } finally {
      detach();
    }
  });
});

// ---------------------------------------------------------------------------
// Turn error / aborted.
// ---------------------------------------------------------------------------

describe('rc.2 contract: turn error and aborted turns', () => {
  it('an errored turn with streamed partial content delivers the partial and a separate terminal notice', async () => {
    const { session, adapter, detach } = makeFixture();
    try {
      session.append('turn/start', { turn: 0 });
      session.append('assistant/chunk', {
        turn: 0,
        step: 0,
        chunk: { type: 'text-delta', index: 0, text: 'partial before failure' },
      });
      session.append('turn/end', {
        turn: 0,
        reason: {
          kind: 'error',
          error: { message: 'provider 500', code: 'UNKNOWN' },
        },
      });
      await vi.waitFor(() => {
        expect(adapter.sent).toHaveLength(2);
      });
      expect(adapter.sent[0]?.text).toBe('partial before failure');
      expect(adapter.sent[1]?.text).toBe('⚠️ 本轮运行失败\n\nprovider 500');
      expect(adapter.stopTypingForTargetCalls).toHaveLength(1);
    } finally {
      detach();
    }
  });

  it('an errored turn with no assistant output sends a terminal failure notice', async () => {
    const { session, adapter, replyContexts, detach } = makeFixture();
    try {
      session.append('turn/start', { turn: 0 });
      session.append('turn/end', {
        turn: 0,
        reason: { kind: 'error', error: { message: 'provider 500', code: 'UNKNOWN' } },
      });
      await vi.waitFor(() => {
        expect(replyContexts.getTurn('contract-1', 0)).toBeUndefined();
      });
      expect(adapter.sent).toHaveLength(1);
      expect(adapter.sent[0]?.text).toBe('⚠️ 本轮运行失败\n\nprovider 500');
      expect(adapter.stopTypingForTargetCalls).toHaveLength(1);
    } finally {
      detach();
    }
  });

  it('redacts raw AUTH provider diagnostics', async () => {
    const { session, adapter, detach } = makeFixture();
    try {
      session.append('turn/start', { turn: 0 });
      session.append('turn/end', {
        turn: 0,
        reason: {
          kind: 'error',
          error: {
            code: 'AUTH',
            message: '401 invalid key sk-THIS-MUST-NOT-LEAK',
          },
        },
      });
      await vi.waitFor(() => {
        expect(adapter.sent).toHaveLength(1);
      });
      expect(adapter.sent[0]?.text).toBe('⚠️ 本轮运行失败\n\nAPI key is invalid');
      expect(JSON.stringify(adapter.sent)).not.toContain('sk-THIS-MUST-NOT-LEAK');
    } finally {
      detach();
    }
  });

  it('prefers a validated provider JSON message and logs the full failure', async () => {
    const errors: unknown[][] = [];
    const logger = { ...silentLogger, error: (...args: unknown[]) => errors.push(args) };
    const { session, adapter, detach } = makeFixture('contract-429', 0, true, logger);
    const failure = {
      code: 'QUOTA',
      message: '429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 1 day."}',
      status: 429,
    };

    try {
      session.append('turn/start', { turn: 0 });
      session.append('turn/end', {
        turn: 0,
        reason: { kind: 'error', error: failure },
      });
      await vi.waitFor(() => {
        expect(adapter.sent).toHaveLength(1);
      });

      expect(adapter.sent[0]?.text).toBe(
        '⚠️ 本轮运行失败\n\nWeekly usage limit reached. Resets in 1 day.',
      );
      expect(errors).toContainEqual([
        "[channel-harness] Harness turn failed for session 'contract-429'",
        {
          turn: 0,
          code: 'QUOTA',
          status: 429,
          requestId: undefined,
          providerRetryAfterMs: undefined,
        },
      ]);
    } finally {
      detach();
    }
  });

  it('falls back to the Harness message when a QUOTA JSON envelope is invalid', async () => {
    const { session, adapter, detach } = makeFixture('contract-429-markdown');
    const message = '429: {"type":"GoUsageLimitError","message":"Weekly usage limit reached."}](https://opencode.ai/workspace/go)';
    try {
      session.append('turn/start', { turn: 0 });
      session.append('turn/end', {
        turn: 0,
        reason: {
          kind: 'error',
          error: {
            code: 'QUOTA',
            message,
          },
        },
      });
      await vi.waitFor(() => {
        expect(adapter.sent).toHaveLength(1);
      });

      expect(adapter.sent[0]?.text).toBe(`⚠️ 本轮运行失败\n\n${message}`);
    } finally {
      detach();
    }
  });

  it('an aborted (user /stop) turn delivers the interrupted streamed prefix exactly once', async () => {
    const { session, adapter, detach } = makeFixture();
    try {
      session.append('turn/start', { turn: 0 });
      const chunk = session.append('assistant/chunk', {
        turn: 0,
        step: 0,
        chunk: { type: 'text-delta', index: 0, text: '被打断之前已输出的' },
      });
      // rc.2: a turn cancelled mid-stream finalizes its delivered prefix as
      // an assistant/message carrying `interrupted: true`.
      session.append(
        'assistant/message',
        {
          turn: 0,
          step: 0,
          message: assistantMessage('被打断之前已输出的'),
          interrupted: true,
        },
        { surfaceOp: 'append', sourceEventSeqs: [chunk.seq] },
      );
      session.append('turn/end', {
        turn: 0,
        reason: { kind: 'aborted', reason: { kind: 'user' } },
      });
      await vi.waitFor(() => {
        expect(adapter.sent).toHaveLength(1);
      });
      expect(adapter.sent[0]?.text).toBe('被打断之前已输出的');
      // No trailing "extra" content after the aborted prefix.
      expect(adapter.sent).toHaveLength(1);
    } finally {
      detach();
    }
  });

  it('an aborted turn with NO interrupted assistant/message sends nothing but stops typing', async () => {
    const { session, adapter, replyContexts, detach } = makeFixture();
    try {
      session.append('turn/start', { turn: 0 });
      session.append('turn/end', {
        turn: 0,
        reason: { kind: 'aborted', reason: { kind: 'user' } },
      });
      await settled();
      expect(adapter.sent).toEqual([]);
      expect(replyContexts.getTurn('contract-1', 0)).toBeUndefined();
      expect(adapter.stopTypingForTargetCalls).toHaveLength(1);
    } finally {
      detach();
    }
  });

  it('a completed turn with no assistant output stops typing and releases its context', async () => {
    const { session, adapter, replyContexts, detach } = makeFixture();
    try {
      session.append('turn/start', { turn: 0 });
      session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
      await vi.waitFor(() => {
        expect(replyContexts.getTurn('contract-1', 0)).toBeUndefined();
      });
      expect(adapter.sent).toEqual([]);
      expect(adapter.stopTypingForTargetCalls).toHaveLength(1);
    } finally {
      detach();
    }
  });

  it('never routes a terminal error from a non-channel turn', async () => {
    const { session, adapter, detach } = makeFixture('contract-foreign-error', 0, false);
    try {
      session.append('turn/start', { turn: 0 });
      session.append('turn/end', {
        turn: 0,
        reason: { kind: 'error', error: { message: 'web-only provider failure', code: 'UNKNOWN' } },
      });
      await settled();
      expect(adapter.sent).toEqual([]);
      expect(adapter.stopTypingForTargetCalls).toEqual([]);
    } finally {
      detach();
    }
  });

  it('cleans up the terminal context and typing when error notice delivery fails', async () => {
    const { session, adapter, replyContexts, detach } = makeFixture();
    adapter.sendFailure = new Error('channel unavailable');
    try {
      session.append('turn/start', { turn: 0 });
      session.append('turn/end', {
        turn: 0,
        reason: { kind: 'error', error: { message: 'provider 500', code: 'UNKNOWN' } },
      });
      await vi.waitFor(() => {
        expect(replyContexts.getTurn('contract-1', 0)).toBeUndefined();
      });
      expect(adapter.sent).toEqual([]);
      expect(adapter.stopTypingForTargetCalls).toHaveLength(1);
    } finally {
      detach();
    }
  });
});

// ---------------------------------------------------------------------------
// Non-text / unknown events must not produce reply noise.
// ---------------------------------------------------------------------------

describe('rc.2 contract: non-text events never become replies', () => {
  it('user/message echo, todo/write, request/context, step boundaries and command lifecycle produce no output', async () => {
    const { session, adapter, replyContexts, detach } = makeFixture();
    try {
      session.append('turn/start', { turn: 0 });
      // The channel user's own prompt echoed onto the surface.
      session.append('user/message', userMessage('hello?'), { surfaceOp: 'append' });
      session.append('todo/write', {
        todos: [{ content: 'work', status: 'in_progress' }],
      });
      session.append('request/context', { provider: 'fixture', model: 'fixture-model' });
      session.append('step/start', { turn: 0, step: 0 });
      // Plugin-merged command lifecycle events (dsh-commands module
      // augmentation) — log-only, never model surface, never reply text.
      session.append('command/run', {
        commandId: 'cmd-1' as never,
        name: 'help',
        args: '',
        source: { kind: 'user' },
      });
      session.append('command/done', {
        commandId: 'cmd-1' as never,
        kind: 'success',
        text: 'done',
      });
      session.append('assistant/chunk', {
        turn: 0,
        step: 0,
        chunk: { type: 'text-delta', index: 0, text: 'only this text' },
      });
      session.append('step/end', { turn: 0, step: 0 });
      session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
      await vi.waitFor(() => {
        expect(adapter.sent).toHaveLength(1);
      });
      // Only the assistant chunk text is delivered — the surrounding
      // bookkeeping events contribute nothing to the reply.
      expect(adapter.sent[0]?.text).toBe('only this text');
      expect(replyContexts.getActiveForSession('contract-1')).toBeUndefined();
    } finally {
      detach();
    }
  });

  it('tool/call + tool/result during a live turn never leak into the final reply', async () => {
    const { session, adapter, detach } = makeFixture();
    try {
      session.append('turn/start', { turn: 0 });
      session.append('step/start', { turn: 0, step: 0 });
      session.append('assistant/chunk', {
        turn: 0,
        step: 0,
        chunk: { type: 'text-delta', index: 0, text: '先查一下：' },
      });
      session.append('tool/call', {
        turn: 0,
        step: 0,
        callId: CallId('call-1'),
        name: 'search',
        arguments: '{"q":"rc.2"}',
      });
      const result = session.append(
        'tool/result',
        { turn: 0, step: 0, message: toolResult('TOOL INTERNAL OUTPUT') },
        { surfaceOp: 'append' },
      );
      expect(isAppendSurfaceEvent(result)).toBe(true);
      session.append('assistant/chunk', {
        turn: 0,
        step: 0,
        chunk: { type: 'text-delta', index: 0, text: '结论' },
      });
      session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
      await vi.waitFor(() => {
        expect(adapter.sent).toHaveLength(1);
      });
      expect(adapter.sent[0]?.text).toBe('先查一下：结论');
      expect(adapter.sent[0]?.text).not.toContain('TOOL INTERNAL OUTPUT');
    } finally {
      detach();
    }
  });
});

// ---------------------------------------------------------------------------
// Unknown / ignorable events (vocabulary growth in newer runtimes).
// ---------------------------------------------------------------------------

describe('rc.2 contract: unknown and ignorable events', () => {
  it('an unknown event type marked ignorable is skipped without crash or reply noise', async () => {
    const { session, router, adapter, replyContexts } = makeFixture();
    // `ignorable: true` cannot be produced by Session.append (it is a
    // newer-writer / restored-log envelope fact), so this fixture is
    // hand-crafted to the .d.ts placement: on the ENVELOPE, beside seq/time.
    const ignorable: SessionEvent = {
      type: 'session/projection',
      seq: 99,
      time: Date.now(),
      data: { projection: 'opaque-future-payload' },
      ignorable: true,
    } as never;
    expect(() => router.onSessionEvent(session, ignorable)).not.toThrow();
    expect(adapter.sent).toEqual([]);
    expect(router.activeSessions()).toEqual([]);
    // The router neither consumed nor released the pending turn context.
    expect(replyContexts.getActiveForSession('contract-1')).toBeDefined();
  });

  it('an unknown REQUIRED (non-ignorable) event is also tolerated on the live firehose', async () => {
    // Reconstruction strictness (refuse unless ignorable) belongs to
    // PERSISTENCE readers (SessionFormatUnsupportedError). The ReplyRouter is
    // a live firehose consumer keyed on the three event types it needs; an
    // unrecognized type must not crash it either.
    const { session, router, adapter } = makeFixture();
    const unknown: SessionEvent = {
      type: 'session/telemetry',
      seq: 100,
      time: Date.now(),
      data: { metric: 1 },
    } as never;
    expect(() => router.onSessionEvent(session, unknown)).not.toThrow();
    expect(adapter.sent).toEqual([]);
    expect(router.activeSessions()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Compaction replacement (surfaceOp replace semantics).
// ---------------------------------------------------------------------------

describe('rc.2 contract: compaction replacement event', () => {
  it('a landed replacement shadows the model surface but produces no channel output', async () => {
    const { session, adapter, detach } = makeFixture();
    try {
      session.append('turn/start', { turn: 0 });
      const user = session.append('user/message', userMessage('长对话'), { surfaceOp: 'append' });
      session.append('step/start', { turn: 0, step: 0 });
      const chunk = session.append('assistant/chunk', {
        turn: 0,
        step: 0,
        chunk: { type: 'text-delta', index: 0, text: '原始长回答' },
      });
      const answer = session.append(
        'assistant/message',
        { turn: 0, step: 0, message: assistantMessage('原始长回答') },
        { surfaceOp: 'append', sourceEventSeqs: [chunk.seq] },
      );
      session.append('step/end', { turn: 0, step: 0 });
      session.append('turn/end', { turn: 0, reason: { kind: 'completed' } });
      await vi.waitFor(() => {
        expect(adapter.sent).toHaveLength(1);
      });
      expect(adapter.sent[0]?.text).toBe('原始长回答');

      // Compaction AFTER the turn: one assistant/message replacement node
      // covering [user, answer] (rc.2: sourceEventSeqs must include every
      // shadowed surface node). It carries a stale turn number and no live
      // ReplyContext — the router must treat it as pure log bookkeeping.
      const before = adapter.sent.length;
      const replacement = session.append(
        'assistant/message',
        { turn: 0, step: 0, message: assistantMessage('[compaction summary]') },
        {
          surfaceOp: { op: 'replace', start: user.seq, end: answer.seq },
          sourceEventSeqs: [user.seq, answer.seq],
        },
      );

      // Pin the real replacement semantics: the model-facing surface drops
      // the shadowed nodes, while the raw log (the human transcript source)
      // still contains the ORIGINAL append-origin events.
      expect(isReplacementSurfaceEvent(replacement)).toBe(true);
      const fold = foldSurface(session.events);
      expect(fold.nodes).not.toContain(user.seq);
      expect(fold.nodes).not.toContain(answer.seq);
      expect(fold.nodes).toContain(replacement.seq);
      expect(fold.replacements).toHaveLength(1);
      expect(session.events.filter(isAppendSurfaceEvent).map((e) => e.seq)).toContain(answer.seq);

      await settled();
      expect(adapter.sent).toHaveLength(before); // no extra channel reply
      expect(adapter.sent.map((s) => s.text)).not.toContain('[compaction summary]');
    } finally {
      detach();
    }
  });
});

// ---------------------------------------------------------------------------
// Unload before turn/end + durable-log reconcile (resume paths).
// ---------------------------------------------------------------------------

describe('rc.2 contract: unload before turn/end', () => {
  it('flushAll finalizes an unfinished turn exactly like turn/end (no content lost)', async () => {
    const { session, router, adapter, replyContexts, detach } = makeFixture();
    try {
      session.append('turn/start', { turn: 0 });
      session.append('assistant/chunk', {
        turn: 0,
        step: 0,
        chunk: { type: 'text-delta', index: 0, text: 'unload 时已产出' },
      });
      // No turn/end — the lifecycle drain calls flushAll() instead. Delivery
      // must still happen (or the reply handle fails); content is never lost.
      await router.flushAll();
      expect(adapter.sent).toHaveLength(1);
      expect(adapter.sent[0]?.text).toBe('unload 时已产出');
      expect(router.activeSessions()).toEqual([]);
      // The unfinished turn's context is released — no dangling active reply.
      expect(replyContexts.getActiveForSession('contract-1')).toBeUndefined();
    } finally {
      detach();
    }
  });
});

// ---------------------------------------------------------------------------
// Durable-log reconcile (listener detached — the resume/unload repair path).
// ---------------------------------------------------------------------------

describe('rc.2 contract: reconcileSession over the real durable log', () => {
  it('rebuilds and delivers the last unfinished turn from the raw event log', async () => {
    const ctx = new Context();
    const sessions = new SessionStore(ctx);
    const session = sessions.create(SessionId('contract-reconcile'));
    // Build an unfinished turn with NO live session/event listener attached.
    session.append('turn/start', { turn: 0 });
    session.append('assistant/chunk', {
      turn: 0,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: '崩溃前' },
    });
    session.append('assistant/chunk', {
      turn: 0,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: '的部分输出' },
    });

    const adapter = new BufferedAdapter();
    const replyContexts = new ReplyContextStore();
    seedTurn(replyContexts, 'contract-reconcile', 0);
    const router = new ReplyRouter({
      config: {
        updateIntervalMs: 0,
        maxTextLength: undefined,
        splitParagraphs: true,
        splitCodeBlocks: true,
        finalFlush: true,
      },
      getAdapter: () => adapter as unknown as ChannelAdapter,
      getBinding: () => makeBinding('contract-reconcile'),
      replyContexts,
      logger: silentLogger,
    });

    await router.reconcileSession(session);
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.text).toBe('崩溃前的部分输出');
    expect(replyContexts.getActiveForSession('contract-reconcile')).toBeUndefined();
  });

  it('reconcile never delivers a turn that was not channel-inbound (no ReplyContext)', async () => {
    const ctx = new Context();
    const sessions = new SessionStore(ctx);
    const session = sessions.create(SessionId('contract-reconcile-foreign'));
    session.append('turn/start', { turn: 0 });
    session.append('assistant/chunk', {
      turn: 0,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: 'web/cli driven turn' },
    });

    const adapter = new BufferedAdapter();
    const router = new ReplyRouter({
      config: {
        updateIntervalMs: 0,
        maxTextLength: undefined,
        splitParagraphs: true,
        splitCodeBlocks: true,
        finalFlush: true,
      },
      getAdapter: () => adapter as unknown as ChannelAdapter,
      getBinding: () => makeBinding('contract-reconcile-foreign'),
      replyContexts: new ReplyContextStore(),
      logger: silentLogger,
    });

    await router.reconcileSession(session);
    expect(adapter.sent).toEqual([]);
  });
});
