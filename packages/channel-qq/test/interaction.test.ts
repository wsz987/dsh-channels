/**
 * QQ interaction round-trip tests (fully offline): `emitInteraction` on the
 * Fake SDK client → adapter emits a canonical `interaction.received` and
 * ACKs the interaction; malformed / ambiguous interactions are dropped
 * (fail closed) without emitting.
 */
import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, type ChannelEvent } from '@wsz987/channel-core';
import type { InteractionReceived } from '@wsz987/channel-core';
import { createTestContext } from '@wsz987/channel-testkit';
import { Config, QQAdapter } from '../src/index.ts';
import { FakeQQSdkClient, type QQInteractionLike } from '../src/sdk-client.ts';
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

/** C2C button press — conversation = user_openid, sender = user_openid. */
function c2cInteraction(overrides: Partial<QQInteractionLike> = {}): QQInteractionLike {
  return {
    id: 'inter_1',
    chat_type: 1,
    user_openid: 'user_openid_1',
    data: { resolved: { button_data: 'uq_abc', button_id: 'uq_abc' } },
    ...overrides,
  };
}

/** Group button press — conversation = group_openid, sender = group_member_openid. */
function groupInteraction(overrides: Partial<QQInteractionLike> = {}): QQInteractionLike {
  return {
    id: 'inter_2',
    chat_type: 2,
    group_openid: 'group_openid_1',
    group_member_openid: 'member_openid_1',
    data: { resolved: { button_data: 'uq_def', button_id: 'uq_def' } },
    ...overrides,
  };
}

async function setupAdapter() {
  const service = new ChannelService(new Context());
  const ctx = createTestContext(service);
  const fake = new FakeQQSdkClient();
  fake.autoReady = true;
  const adapter = new QQAdapter(makeConfig(), { sdkClient: fake, now: () => Date.now() });
  await adapter.start(ctx);
  const interactions: InteractionReceived[] = [];
  const off = service.on((e: ChannelEvent) => {
    if (e.type === 'interaction.received') interactions.push(e as InteractionReceived);
  });
  return { service, ctx, fake, adapter, interactions, off };
}

describe('QQAdapter interaction round-trip', () => {
  it('C2C button press → interaction.received with dm conversation + ACK', async () => {
    const { fake, adapter, interactions, off } = await setupAdapter();

    fake.emitInteraction(c2cInteraction());

    // The emit path is async (handler awaits ctx.emit); give it a microtask.
    await flush();

    expect(interactions).toHaveLength(1);
    const ev = interactions[0]!;
    expect(ev.channel).toBe('qq' as never);
    expect(ev.accountId).toBe('main' as never);
    expect(ev.conversation).toEqual({ id: 'user_openid_1', type: 'dm' });
    expect(ev.sender).toEqual({ id: 'user_openid_1' });
    expect(ev.interactionId).toBe('inter_1');
    expect(ev.action).toBe('uq_abc');

    // The interaction must be ACKed with the event id (fire-and-forget).
    expect(fake.acknowledgeCalls).toEqual([{ id: 'inter_1', code: 0, data: undefined }]);

    off();
    await adapter.stop();
  });

  it('group button press → interaction.received with group conversation + group_member sender', async () => {
    const { fake, adapter, interactions, off } = await setupAdapter();

    fake.emitInteraction(groupInteraction());
    await flush();

    expect(interactions).toHaveLength(1);
    const ev = interactions[0]!;
    expect(ev.channel).toBe('qq' as never);
    expect(ev.accountId).toBe('main' as never);
    expect(ev.conversation).toEqual({ id: 'group_openid_1', type: 'group' });
    expect(ev.sender).toEqual({ id: 'member_openid_1' });
    expect(ev.interactionId).toBe('inter_2');
    expect(ev.action).toBe('uq_def');

    expect(fake.acknowledgeCalls).toEqual([{ id: 'inter_2', code: 0, data: undefined }]);

    off();
    await adapter.stop();
  });

  it('button_data is the preferred action carrier; button_id is the fallback', async () => {
    const { fake, adapter, interactions, off } = await setupAdapter();

    fake.emitInteraction(c2cInteraction({ data: { resolved: { button_id: 'uq_fallback' } } }));
    await flush();
    expect(interactions[0]?.action).toBe('uq_fallback');

    off();
    await adapter.stop();
  });

  it('malformed interaction (no identifiable openid) is dropped without emitting or ACKing', async () => {
    const { fake, adapter, interactions, off } = await setupAdapter();

    // No user_openid / group openids → ambiguous conversation → fail closed.
    fake.emitInteraction(c2cInteraction({ user_openid: undefined }));
    await flush();

    expect(interactions).toHaveLength(0);
    // ACK still happens (fire-and-forget) as required by the platform.
    expect(fake.acknowledgeCalls).toEqual([{ id: 'inter_1', code: 0, data: undefined }]);

    off();
    await adapter.stop();
  });

  it('interaction missing both button_data and button_id is dropped (unable to recover action)', async () => {
    const { fake, adapter, interactions, off } = await setupAdapter();

    fake.emitInteraction(c2cInteraction({ data: { resolved: {} } }));
    await flush();

    expect(interactions).toHaveLength(0);

    off();
    await adapter.stop();
  });

  it('malformed payload (no id) is dropped without emitting', async () => {
    const { fake, adapter, interactions, off } = await setupAdapter();

    fake.emitInteraction(c2cInteraction({ id: undefined }));
    await flush();

    expect(interactions).toHaveLength(0);
    // No ack issued because there is no interaction id to ack.
    expect(fake.acknowledgeCalls).toEqual([]);

    off();
    await adapter.stop();
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}