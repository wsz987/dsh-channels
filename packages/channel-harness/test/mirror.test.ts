/**
 * Issue #5 — opt-in mirroring of non-channel turns.
 *
 * A turn on a channel-bound session initiated OUTSIDE the channel (web/CLI)
 * has no Channel ReplyContext and must never auto-route — unless the owner
 * flipped `/mirror on`, which persists `mirror: true` on the durable binding.
 * The router then tracks the turn as a BUFFERED mirror (final text only, no
 * streaming preview) and delivers it to the bound conversation.
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Session } from '@deepseek-ai/dsh-session';
import type { ChannelAdapter, ChannelTarget } from '@wsz987/channel-core';
import { ReplyContextStore } from '../src/reply-context-store.ts';
import { ReplyRouter } from '../src/reply-router.ts';
import type { SessionBinding } from '../src/session-router.ts';
import type { ChannelWorkspaceResolver } from '../src/workspace-resolver.ts';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const noopResolver: ChannelWorkspaceResolver = { resolve: async () => ({}) };
void noopResolver;

function binding(mirror: boolean | undefined): SessionBinding {
  return {
    channelId: 'weixin',
    accountId: 'main',
    conversationId: 'user_123',
    conversationType: 'dm',
    sessionId: 'session-1',
    ...(mirror === undefined ? {} : { mirror }),
    route: {},
    schemaVersion: 3,
    createdAt: 0,
    updatedAt: 0,
  };
}

class RecordingAdapter {
  readonly id = 'weixin';
  readonly capabilities = {
    text: true, image: false, file: false, audio: false, video: false,
    markdown: false, cards: false, reactions: false, threads: false,
    streaming: 'buffered',
  } as const;
  readonly sent: { text?: string }[] = [];
  readonly createdReplies = 0;
  async start() {}
  async stop() {}
  async send(_target: ChannelTarget, message: { text?: string }) {
    this.sent.push(message);
    return { delivered: true };
  }
  async createReply(): Promise<never> {
    throw new Error('mirror must be buffered — createReply is never allowed');
  }
}

function makeRouter(binding: SessionBinding, adapter: RecordingAdapter) {
  return new ReplyRouter({
    config: {
      updateIntervalMs: 0,
      maxTextLength: undefined,
      splitParagraphs: true,
      splitCodeBlocks: true,
      finalFlush: true,
    },
    getAdapter: () => adapter as unknown as ChannelAdapter,
    getBinding: (sessionId) => (sessionId === 'session-1' ? binding : undefined),
    replyContexts: new ReplyContextStore(),
    logger: silentLogger,
  });
}

function fakeSession(): Session {
  return { id: SessionId('session-1') } as unknown as Session;
}

/** Drive one full non-channel turn: no ReplyContext is ever registered. */
async function runWebTurn(router: ReplyRouter, text: string, turn = 0): Promise<void> {
  const session = fakeSession();
  router.onSessionEvent(session, { type: 'turn/start', data: { turn }, seq: 1, time: Date.now() } as never);
  router.onSessionEvent(session, {
    type: 'assistant/message',
    data: {
      turn,
      step: 0,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      stream: [{ type: 'text-chunks', time0: Date.now(), index: 0, dt: [0], texts: [text] }],
    },
    seq: 2,
    time: Date.now(),
  } as never);
  router.onSessionEvent(session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } }, seq: 3, time: Date.now() } as never);
  // turn/end finalization is fire-and-forget async — let it settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('issue #5: mirror of web-initiated turns', () => {
  it('delivers the final text buffered to the bound conversation when mirror is on', async () => {
    const adapter = new RecordingAdapter();
    const router = makeRouter(binding(true), adapter);
    await runWebTurn(router, 'web 端的回复');

    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.text).toContain('web 端的回复');
  });

  it('never routes a non-channel turn when mirror is unset or off (default gate)', async () => {
    for (const mirror of [undefined, false]) {
      const adapter = new RecordingAdapter();
      const router = makeRouter(binding(mirror), adapter);
      await runWebTurn(router, '不应送达');
      expect(adapter.sent).toHaveLength(0);
    }
  });

  it('mirror replies are strictly buffered (no streaming reply handle)', async () => {
    const adapter = new RecordingAdapter();
    const createReply = vi.spyOn(adapter, 'createReply');
    const router = makeRouter(binding(true), adapter);
    await runWebTurn(router, '最终文本');
    expect(createReply).not.toHaveBeenCalled();
    expect(adapter.sent.map((s) => s.text)).toEqual(['最终文本']);
  });

  it('an unrouted session (no binding) stays silent even with mirror semantics', async () => {
    const adapter = new RecordingAdapter();
    const router = new ReplyRouter({
      config: {
        updateIntervalMs: 0,
        maxTextLength: undefined,
        splitParagraphs: true,
        splitCodeBlocks: true,
        finalFlush: true,
      },
      getAdapter: () => adapter as unknown as ChannelAdapter,
      getBinding: () => undefined,
      replyContexts: new ReplyContextStore(),
      logger: silentLogger,
    });
    await runWebTurn(router, '无绑定');
    expect(adapter.sent).toHaveLength(0);
  });
});
