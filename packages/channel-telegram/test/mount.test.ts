/**
 * channel-telegram transactional-mount rollback test (doc §5 / R2).
 *
 * Proves that when the adapter mounted by apply() fails its start(), the
 * shared mountChannelAdapter rolls back: the registry no longer contains the
 * adapter, the abort signal created for the adapter is aborted, and stop()
 * was best-effort called.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, type ChannelAdapterContext } from '@wsz987/channel-core';
import { Config, TelegramAdapter, apply } from '../src/index.ts';
import type { TelegramConfig } from '../src/config.ts';

function makeConfig(overrides: Partial<TelegramConfig> = {}): TelegramConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    baseUrl: 'http://fake',
    tokenRef: 'TELEGRAM_BOT_TOKEN',
      token: undefined,
    timeoutMs: 1000,
    longPollTimeoutMs: 1000,
    reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
    dedup: { enabled: true, windowMs: 5000 },
      streaming: { enabled: true, placeholder: '…' },
      maxDownloadBytes: 20 * 1024 * 1024,
    ...overrides,
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('channel-telegram transactional mount', () => {
  it('start() rejection rolls back: registry empty, signal aborted, stop() called', async () => {
    const ctx = new Context();
    new ChannelService(ctx);

          (ctx as Context & { credentials: unknown }).credentials = {
        resolve: async () => ({ value: 'TEST_BOT_TOKEN_123', source: 'test' }),
        describe: async () => ({ configured: true, writable: true }),
        set: async () => undefined,
      };
      let capturedSignal: AbortSignal | undefined;
    const stop = vi.spyOn(TelegramAdapter.prototype, 'stop').mockImplementation(async function () {
      return undefined;
    });
    vi.spyOn(TelegramAdapter.prototype, 'start').mockImplementation(
      async function (this: TelegramAdapter, adapterCtx: ChannelAdapterContext) {
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
        await tick();
        await tick();

      expect(ctx.channels.get('telegram')).toBeUndefined();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
