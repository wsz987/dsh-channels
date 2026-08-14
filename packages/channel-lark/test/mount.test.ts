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
