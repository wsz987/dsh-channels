/**
 * Lifecycle tests (fully offline): READY / RESUMED / ERROR / Abort / Stop /
 * repeated stop / startup timeout / invalid credentials — all via the Fake
 * QQSdkClient.
 */
import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, type ChannelEvent } from '@dsh/channel-core';
import { createTestContext } from '@dsh/channel-testkit';
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

function harness(ctx: ReturnType<typeof createTestContext>, client: FakeQQSdkClient) {
  const adapter = new QQAdapter(makeConfig(), { sdkClient: client, now: () => 1000 });
  return { adapter };
}

describe('QQAdapter lifecycle', () => {
  it('READY → health ok + auth/connection events', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeQQSdkClient();
    const { adapter } = harness(ctx, client);

    const events: ChannelEvent[] = [];
    const off = service.on((e) => events.push(e));

    const startPromise = adapter.start(ctx);
    // start() awaits the ready event; emit it after a tick.
    await Promise.resolve();
    client.emitReady();
    await startPromise;

    expect((await adapter.getHealth()).status).toBe('ok');

    const authStates = events.filter((e) => e.type === 'auth.changed').map((e) => (e as { state: string }).state);
    const connStates = events.filter((e) => e.type === 'connection.changed').map((e) => (e as { state: string }).state);
    expect(authStates).toContain('authenticated');
    expect(connStates).toContain('connected');

    off();
    await adapter.stop();
  });

  it('RESUMED → health ok + connection connected', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeQQSdkClient();
    const { adapter } = harness(ctx, client);

    const events: ChannelEvent[] = [];
    const off = service.on((e) => events.push(e));

    const startPromise = adapter.start(ctx);
    await Promise.resolve();
    client.emitReady();
    await startPromise;

    client.emitResumed();
    expect((await adapter.getHealth()).status).toBe('ok');
    expect(events.some((e) => e.type === 'connection.changed' && e.state === 'connected')).toBe(true);

    off();
    await adapter.stop();
  });

  it('ERROR → degraded health', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeQQSdkClient();
    const { adapter } = harness(ctx, client);

    const startPromise = adapter.start(ctx);
    await Promise.resolve();
    client.emitReady();
    await startPromise;

    client.emitError(new Error('boom'));
    const health = await adapter.getHealth();
    expect(health.status).toBe('degraded');

    await adapter.stop();
  });

  it('Abort ends the run promise and stop is idempotent', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeQQSdkClient();
    const { adapter } = harness(ctx, client);

    const startPromise = adapter.start(ctx);
    await Promise.resolve();
    client.emitReady();
    await startPromise;

    await adapter.stop();
    expect(client.stopped).toBe(true);
    await adapter.stop(); // idempotent — resolves without error
    await adapter.stop();
  });

  it('startup timeout when the fake never readies', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeQQSdkClient();
    const adapter = new QQAdapter(makeConfig({ startupTimeoutMs: 20 }), {
      sdkClient: client,
      now: () => 1000,
    });

    await expect(adapter.start(ctx)).rejects.toMatchObject({ code: 'CHANNEL_START_FAILED' });
    // Rollback ran: the half-started client was stopped and the run promise
    // was settled, so a subsequent stop() is a clean no-op.
    expect(client.stopped).toBe(true);
    await adapter.stop();
  });

  it('invalid credentials: a start rejection surfaces as a fail-fast start failure', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeQQSdkClient();
    // The SDK's `tokenPrefetch: 'sync'` surfaces credential errors; the fake
    // simulates this with a start rejection. start() must reject with that
    // error immediately (fail-fast) and roll back the half-started client —
    // not hang until the startup timeout.
    client.startError = new Error('invalid appId/secret');
    const adapter = new QQAdapter(makeConfig({ startupTimeoutMs: 500 }), {
      sdkClient: client,
      now: () => 1000,
    });

    await expect(adapter.start(ctx)).rejects.toThrow('invalid appId/secret');
    // Rollback ran: the half-started client was stopped.
    expect(client.stopped).toBe(true);
  });

  it('rejects send before start', async () => {
    const client = new FakeQQSdkClient();
    const adapter = new QQAdapter(makeConfig(), { sdkClient: client });
    await expect(
      adapter.send(
        { channelId: 'qq' as never, accountId: 'main' as never, conversationId: 'c' as never },
        { text: 'hi' },
      ),
    ).rejects.toMatchObject({ code: 'CHANNEL_NOT_STARTED' });
  });

  it('missing credential → real client build path throws ChannelError (v1.1 QQ-R5)', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    // No Fake client and no deps.appSecret: adapter.start() falls back to the
    // real TencentQQSdkClient build, which requires a resolved secret.
    const adapter = new QQAdapter(makeConfig({ startupTimeoutMs: 50 }), {
      now: () => 1000,
    });

    await expect(adapter.start(ctx)).rejects.toMatchObject({
      code: 'CHANNEL_ERROR',
      message: 'QQ credential "QQBOT_APP_SECRET" is not configured',
    });
    await adapter.stop();
  });
});
