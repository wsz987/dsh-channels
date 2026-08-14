/**
 * QQ E2E (offline): real `QQAdapter` (Fake QQSdkClient) + real `ReplyRouter`
 * + real `ReplyContextStore` from channel-harness.
 *
 * - C2C (dm + replyToMessageId) → native strategy → `createReply` → delta
 *   appends → `complete`.
 * - Group → buffered → exactly ONE `sendText` at `turn/end` with the full
 *   accumulated text (20 chunks → 1 send).
 */
import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService } from '@dsh/channel-core';
import { createTestContext } from '@dsh/channel-testkit';
import { ReplyRouter } from '../../channel-harness/src/reply-router.ts';
import { ReplyContextStore } from '../../channel-harness/src/reply-context-store.ts';
import type { SessionBinding } from '../../channel-harness/src/session-router.ts';
import { Config, QQAdapter } from '../src/index.ts';
import { FakeQQSdkClient } from '../src/sdk-client.ts';
import type { QQConfig } from '../src/config.ts';

function makeConfig(overrides: Partial<QQConfig> = {}): QQConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    appId: 'APP_ID',
    appSecretRef: 'QQBOT_APP_SECRET',
    markdownSupport: false,
    streaming: { enabled: true, throttleMs: 500 },
    dedup: { enabled: true, windowMs: 5000 },
    startupTimeoutMs: 15000,
    ...overrides,
  });
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function makeAdapter(fake: FakeQQSdkClient): QQAdapter {
  return new QQAdapter(makeConfig(), { sdkClient: fake, now: () => Date.now() });
}

function makeBinding(overrides: Partial<SessionBinding> = {}): SessionBinding {
  return {
    channelId: 'qq',
    accountId: 'main',
    conversationId: 'conv_1',
    sessionId: 's1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeRouter(
  adapter: QQAdapter,
  binding: SessionBinding,
  replyContexts: ReplyContextStore,
): ReplyRouter {
  return new ReplyRouter({
    config: {
      updateIntervalMs: 0, // flush on every delta for deterministic tests
      maxTextLength: undefined,
      splitParagraphs: true,
      splitCodeBlocks: true,
      finalFlush: true,
    },
    getAdapter: () => adapter,
    getBinding: () => binding,
    replyContexts,
    logger: silentLogger,
  });
}

function fakeSession(id: string): { id: string } {
  return { id };
}

function turnStartEvent(turn: number): never {
  return { type: 'turn/start', seq: 0, time: Date.now(), data: { turn } } as never;
}

function chunkEvent(turn: number, text: string): never {
  return {
    type: 'assistant/chunk',
    seq: 1,
    time: Date.now(),
    data: { turn, step: 0, chunk: { type: 'text-delta', index: 0, text } },
  } as never;
}

function turnEndEvent(turn: number): never {
  return {
    type: 'turn/end',
    seq: 3,
    time: Date.now(),
    data: { turn, reason: { kind: 'completed' } },
  } as never;
}

describe('QQ E2E: native C2C streaming', () => {
  it('dm + replyToMessageId → native strategy → createReply → append deltas → complete', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const fake = new FakeQQSdkClient();
    fake.autoReady = true;
    const adapter = makeAdapter(fake);
    await adapter.start(ctx);

    const binding = makeBinding();
    const replyContexts = new ReplyContextStore();
    const router = makeRouter(adapter, binding, replyContexts);
    const session = fakeSession('s1');

    // Register the reply context by Harness message id, then simulate the
    // `agent/inbox/claimed` correlation before chunks flow (mirrors the bridge
    // + lifecycle listener of v1.1).
    replyContexts.register('harness-msg-1', {
      sessionId: binding.sessionId,
      context: {
        conversationType: 'dm',
        replyToMessageId: 'msg_trigger_1',
      },
    });
    replyContexts.claim({ sessionId: binding.sessionId, messageId: 'harness-msg-1', turn: 0 });

    router.onSessionEvent(session, turnStartEvent(0));
    router.onSessionEvent(session, chunkEvent(0, '你'));
    router.onSessionEvent(session, chunkEvent(0, '好'));
    router.onSessionEvent(session, chunkEvent(0, '，'));
    router.onSessionEvent(session, chunkEvent(0, '世'));
    router.onSessionEvent(session, chunkEvent(0, '界'));

    // The native strategy must have opened a C2C stream anchored on the trigger.
    expect(fake.streamCalls).toEqual([
      {
        target: { scope: 'c2c', targetId: 'conv_1', msgId: 'msg_trigger_1' },
        options: { throttleMs: 500 },
      },
    ]);

    // Finish the turn; the reply handle completes the stream.
    router.onSessionEvent(session, turnEndEvent(0));
    await flush(20);

    const stream = fake.streamCalls[0]?.target;
    expect(stream).toBeDefined();
    // No buffered text send: native streaming never calls sendText.
    expect(fake.textCalls).toHaveLength(0);

    await adapter.stop();
  });

  it('stream.update calls carry the monotonic full text (replace semantics)', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const fake = new FakeQQSdkClient();
    fake.autoReady = true;
    const adapter = makeAdapter(fake);
    await adapter.start(ctx);

    const binding = makeBinding();
    const replyContexts = new ReplyContextStore();
    const router = makeRouter(adapter, binding, replyContexts);
    const session = fakeSession('s1');

    replyContexts.register('harness-msg-1', {
      sessionId: binding.sessionId,
      context: {
        conversationType: 'dm',
        replyToMessageId: 'msg_trigger_1',
      },
    });
    replyContexts.claim({ sessionId: binding.sessionId, messageId: 'harness-msg-1', turn: 0 });

    router.onSessionEvent(session, turnStartEvent(0));
    // Await between deltas so the native strategy's async flush drains each
    // chunk (mirrors real inter-chunk latency).
    for (const c of ['你', '好', '，', '世', '界']) {
      router.onSessionEvent(session, chunkEvent(0, c));
      await flush(5);
    }
    await flush(20);

    const stream = fake.streams[0] as { updates: string[]; completed: boolean };
    expect(stream?.updates).toContain('你好，世界');

    router.onSessionEvent(session, turnEndEvent(0));
    await flush(20);
    expect(stream?.completed).toBe(true);

    await adapter.stop();
  });
});

describe('QQ E2E: group buffered', () => {
  it('group → exactly ONE sendText at turn/end with the full 20-chunk text', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const fake = new FakeQQSdkClient();
    fake.autoReady = true;
    const adapter = makeAdapter(fake);
    await adapter.start(ctx);

    const binding = makeBinding({ conversationId: 'group_789' });
    const replyContexts = new ReplyContextStore();
    const router = makeRouter(adapter, binding, replyContexts);
    const session = fakeSession('s1');

    replyContexts.register('harness-msg-1', {
      sessionId: binding.sessionId,
      context: { conversationType: 'group' },
    });
    replyContexts.claim({ sessionId: binding.sessionId, messageId: 'harness-msg-1', turn: 0 });

    router.onSessionEvent(session, turnStartEvent(0));
    for (let i = 0; i < 20; i += 1) {
      router.onSessionEvent(session, chunkEvent(0, `chunk${i}`));
    }
    await flush(20);

    // Buffered strategy must NOT stream and must NOT send until turn/end.
    expect(fake.streamCalls).toHaveLength(0);
    expect(fake.textCalls).toHaveLength(0);

    router.onSessionEvent(session, turnEndEvent(0));
    await flush(20);

    expect(fake.textCalls).toHaveLength(1);
    expect(fake.textCalls[0]?.target).toEqual({ scope: 'group', targetId: 'group_789', msgId: undefined });
    expect(fake.textCalls[0]?.text).toBe(
      Array.from({ length: 20 }, (_, i) => `chunk${i}`).join(''),
    );

    await adapter.stop();
  });
});

function flush(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
