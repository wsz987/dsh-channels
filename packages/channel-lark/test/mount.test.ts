/**
 * channel-lark transactional-mount rollback test (doc §5 / R2).
 *
 * Proves that when the adapter mounted by apply() fails its start(), the
 * shared mountChannelAdapter rolls back: the registry no longer contains the
 * adapter, the abort signal created for the adapter is aborted, and stop()
 * was best-effort called.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, type ChannelAdapterContext } from '@wsz987/channel-core';
import { CredentialProvider } from '@deepseek-ai/dsh-credentials';
import type { CredentialInfo, CredentialRef, ResolvedCredential } from '@deepseek-ai/dsh-credentials';
import { Config, LarkAdapter, apply } from '../src/index.ts';
import type { LarkConfig } from '../src/config.ts';

function makeConfig(overrides: Partial<LarkConfig> = {}): LarkConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    baseUrl: 'http://fake',
    timeoutMs: 1000,
    longPollTimeoutMs: 1000,
    reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
    dedup: { enabled: true, windowMs: 5000 },
    card: { createOnFirstDelta: true },
    upstream: { mode: 'gateway' },
    ...overrides,
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Minimal in-memory credentials provider for the apply() credential path. */
class FakeCredentials extends CredentialProvider {
  constructor(
    ctx: Context,
    private readonly values: Record<string, string> = {},
  ) {
    super(ctx);
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values[ref];
    return value ? { value, source: 'test' } : undefined;
  }

  async describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return { configured: true, writable: true, source: 'test' };
  }

  async set(_ref: CredentialRef, _value: string): Promise<void> {}

  async unset(_ref: CredentialRef): Promise<void> {}
}

describe('channel-lark transactional mount', () => {
  it('start() rejection rolls back: registry empty, signal aborted, stop() called', async () => {
    const ctx = new Context();
    new ChannelService(ctx);

    let capturedSignal: AbortSignal | undefined;
    const stop = vi.spyOn(LarkAdapter.prototype, 'stop').mockImplementation(async function () {
      return undefined;
    });
    vi.spyOn(LarkAdapter.prototype, 'start').mockImplementation(
      async function (this: LarkAdapter, adapterCtx: ChannelAdapterContext) {
        capturedSignal = adapterCtx.signal;
        throw new Error('start boom');
      },
    );

    try {
      apply(ctx, makeConfig());
      // The mount effect registers the adapter, then start() rejects; the
      // rollback (abort + stop + unregister) runs as the rejection settles.
      await tick();
      await tick();

      expect(ctx.channels.get('lark')).toBeUndefined();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('channel-lark credential resolution (SDK mode, standalone fallback)', () => {
  it('resolves appSecret from ctx.credentials + appId from config and mounts the adapter', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    // AppId lives in config; AppSecret lives in credentials under the DSH ref.
    new FakeCredentials(ctx, { DSH_CHANNEL_LARK_MAIN_APP_SECRET: 'cli_secret' });
    const start = vi.spyOn(LarkAdapter.prototype, 'start').mockImplementation(async function () {
      return undefined;
    });

    try {
      apply(ctx, makeConfig({ upstream: { mode: 'sdk', appId: 'cli_appid' } }));
      await tick();
      await tick();
      await tick();

      expect(start).toHaveBeenCalledTimes(1);
      expect(ctx.channels.get('lark')).toBeInstanceOf(LarkAdapter);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not mount when the SDK AppSecret is missing (and does not throw)', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    new FakeCredentials(ctx); // empty — no DSH_CHANNEL_LARK_MAIN_APP_SECRET
    const start = vi.spyOn(LarkAdapter.prototype, 'start').mockImplementation(async function () {
      return undefined;
    });

    try {
      apply(ctx, makeConfig({ upstream: { mode: 'sdk', appId: 'cli_appid' } }));
      await tick();
      await tick();
      await tick();

      expect(start).not.toHaveBeenCalled();
      expect(ctx.channels.get('lark')).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
