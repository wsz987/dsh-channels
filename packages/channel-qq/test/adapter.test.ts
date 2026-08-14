/**
 * Adapter contract + target-aware streaming tests (fully offline).
 *
 * The ChannelAdapter contract suite runs against `QQAdapter` with a Fake
 * QQSdkClient injected via deps (no network, no real credentials). Additional
 * tests cover `resolveStreamingMode`, `createReply` error paths, and that
 * `send` flows through the fake client.
 */
import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, ChannelError } from '@dsh/channel-core';
import type { ChannelTarget } from '@dsh/channel-core';
import {
  runChannelAdapterContract,
  createTestContext,
} from '@dsh/channel-testkit';
import { Config, QQAdapter, apply, inject } from '../src/index.ts';
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

function dmReplyTarget(): ChannelTarget {
  return {
    channelId: 'qq' as never,
    accountId: 'main' as never,
    conversationId: 'user_1' as never,
    conversationType: 'dm',
    replyToMessageId: 'msg_9' as never,
  };
}

describe('channel-qq plugin', () => {
  it('exports the cordis plugin shape', () => {
    expect(apply).toBeTypeOf('function');
  });

  it('declares inject [channels, credentials] (v1.1 QQ-R5)', () => {
    expect(inject).toEqual(['channels', 'credentials']);
  });

  it('adapter contract suite passes (Fake client, fully offline)', () => {
    const fake = new FakeQQSdkClient();
    fake.autoReady = true;
    runChannelAdapterContract(new QQAdapter(makeConfig(), { sdkClient: fake }));
  });
});

describe('QQAdapter streaming (target-aware)', () => {
  it('resolves native for dm + replyToMessageId', () => {
    const adapter = new QQAdapter(makeConfig(), { sdkClient: new FakeQQSdkClient() });
    expect(adapter.resolveStreamingMode(dmReplyTarget())).toBe('native');
  });

  it('resolves buffered for group', () => {
    const adapter = new QQAdapter(makeConfig(), { sdkClient: new FakeQQSdkClient() });
    expect(
      adapter.resolveStreamingMode({
        ...dmReplyTarget(),
        conversationType: 'group',
      }),
    ).toBe('buffered');
  });

  it('resolves buffered for dm without a reply message id', () => {
    const adapter = new QQAdapter(makeConfig(), { sdkClient: new FakeQQSdkClient() });
    expect(
      adapter.resolveStreamingMode({ ...dmReplyTarget(), replyToMessageId: undefined }),
    ).toBe('buffered');
  });

  it('capabilities stream buffered (conservative), markdown from config', () => {
    const adapter = new QQAdapter(makeConfig({ markdownSupport: true }), {
      sdkClient: new FakeQQSdkClient(),
    });
    expect(adapter.capabilities.streaming).toBe('buffered');
    expect(adapter.capabilities.markdown).toBe(true);
    expect(adapter.capabilities.video).toBe(true);
  });
});

describe('QQAdapter.createReply', () => {
  it('opens a c2c stream for a dm target with a message id', async () => {
    const fake = new FakeQQSdkClient();
    fake.autoReady = true;
    const adapter = new QQAdapter(makeConfig(), { sdkClient: fake });
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    await adapter.start(ctx);

    const handle = await adapter.createReply(dmReplyTarget());
    expect(fake.streamCalls).toEqual([
      {
        target: { scope: 'c2c', targetId: 'user_1', msgId: 'msg_9' },
        options: { throttleMs: 500 },
      },
    ]);
    expect(typeof handle.append).toBe('function');
    expect(typeof handle.finish).toBe('function');

    await adapter.stop();
  });

  it('throws ChannelError for a group target', async () => {
    const fake = new FakeQQSdkClient();
    fake.autoReady = true;
    const adapter = new QQAdapter(makeConfig(), { sdkClient: fake });
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    await adapter.start(ctx);

    await expect(
      adapter.createReply({ ...dmReplyTarget(), conversationType: 'group' }),
    ).rejects.toBeInstanceOf(ChannelError);
    expect(fake.streamCalls).toHaveLength(0);

    await adapter.stop();
  });

  it('throws ChannelError for a dm target without a message id', async () => {
    const fake = new FakeQQSdkClient();
    fake.autoReady = true;
    const adapter = new QQAdapter(makeConfig(), { sdkClient: fake });
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    await adapter.start(ctx);

    await expect(
      adapter.createReply({ ...dmReplyTarget(), replyToMessageId: undefined }),
    ).rejects.toBeInstanceOf(ChannelError);

    await adapter.stop();
  });
});

describe('QQAdapter.send', () => {
  it('send flows through the fake client', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const fake = new FakeQQSdkClient();
    fake.autoReady = true;
    const adapter = new QQAdapter(makeConfig(), { sdkClient: fake });

    await adapter.start(ctx);
    const result = await adapter.send(
      { channelId: 'qq' as never, accountId: 'main' as never, conversationId: 'c' as never },
      { text: 'hi' },
    );
    expect(result.delivered).toBe(true);
    expect(fake.textCalls).toHaveLength(1);
    await adapter.stop();
  });
});
