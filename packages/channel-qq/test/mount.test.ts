/**
 * channel-qq transactional mount + shared runtime resources (doc §5 / R3).
 *
 * Proves the QQ mount uses the ChannelService shared runtime resources
 * (createAdapterContext) instead of hand-rolling per-mount Memory stores:
 * the ChannelAdapterContext handed to start() shares the exact
 * ctx.channels.resources.secrets / ctx.channels.resources.storage
 * instances, so QQ no longer bypasses the unified persistence backend.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, type ChannelAdapterContext } from '@wsz987/channel-core';
import { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials';
import { Config, QQAdapter, apply } from '../src/index.ts';
import type { QQConfig } from '../src/config.ts';

/** Minimal in-memory credentials provider for the QQ apply() path. */
class FakeCredentials extends CredentialProvider {
  async resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return { value: 'test-secret', source: 'test' };
  }

  async describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: true, writable: false, source: 'test' };
  }

  async set(_ref: CredentialRef, _value: string): Promise<void> {}

  async unset(_ref: CredentialRef): Promise<void> {}
}

function makeConfig(overrides: Partial<QQConfig> = {}): QQConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    appId: 'dummy-app-id',
    appSecretRef: 'QQBOT_APP_SECRET',
    markdownSupport: false,
    streaming: { enabled: true, throttleMs: 500 },
    dedup: { enabled: true, windowMs: 5000 },
    startupTimeoutMs: 15000,
    ...overrides,
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('channel-qq transactional mount + shared resources', () => {
  it('start() receives the ChannelService shared secrets/storage', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    new FakeCredentials(ctx);

    let capturedCtx: ChannelAdapterContext | undefined;
    vi.spyOn(QQAdapter.prototype, 'stop').mockImplementation(async function () {
      return undefined;
    });
    vi.spyOn(QQAdapter.prototype, 'start').mockImplementation(
      async function (this: QQAdapter, adapterCtx: ChannelAdapterContext) {
        capturedCtx = adapterCtx;
        return undefined;
      },
    );

    try {
      apply(ctx, makeConfig());
      await tick();
      await tick();
      await tick();

      expect(capturedCtx).toBeDefined();
      expect(capturedCtx!.secrets).toBe(ctx.channels.resources.secrets);
      expect(capturedCtx!.storage).toBe(ctx.channels.resources.storage);
      expect(ctx.channels.get('qq')).toBeInstanceOf(QQAdapter);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('start() rejection rolls back: registry empty, signal aborted, stop() called', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    new FakeCredentials(ctx);

    let capturedSignal: AbortSignal | undefined;
    const stop = vi.spyOn(QQAdapter.prototype, 'stop').mockImplementation(async function () {
      return undefined;
    });
    vi.spyOn(QQAdapter.prototype, 'start').mockImplementation(
      async function (this: QQAdapter, adapterCtx: ChannelAdapterContext) {
        capturedSignal = adapterCtx.signal;
        throw new Error('start boom');
      },
    );

    try {
      apply(ctx, makeConfig());
      await tick();
      await tick();
      await tick();

      expect(ctx.channels.get('qq')).toBeUndefined();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
