/**
 * mountChannelAdapter transactional-mount tests (doc §5).
 *
 * Proves:
 * - `adapter.start()` rejection -> no residual adapter in the registry and
 *   `adapter.stop()` was rollback-called.
 * - normal plugin unload -> the adapter is unregistered and `stop()` awaited.
 * - the `createContext` signal fires on unload.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  ChannelService,
  mountChannelAdapter,
  type ChannelAdapter,
  type ChannelAdapterContext,
  type ChannelCapabilities,
} from '../src/index.js';

const capabilities: ChannelCapabilities = {
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
};

function makeAdapter(id: string, overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    id,
    capabilities,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => ({ delivered: true })),
    ...overrides,
  } as unknown as ChannelAdapter;
}

function makeContext(): ChannelAdapterContext {
  return {
    emit: vi.fn(async () => {}),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: {} as never,
    storage: {} as never,
    signal: new AbortController().signal,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('mountChannelAdapter', () => {
  it('start() rejection rolls back: registry empty after settle, stop() called', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    const stop = vi.fn(async () => {});
    const adapter = makeAdapter('boom', {
      start: async () => {
        throw new Error('start boom');
      },
      stop,
    });

    ctx.plugin((c) => {
      mountChannelAdapter(c, adapter, () => makeContext());
    });
    // The async mount effect registers first, then start() rejects; the rollback
    // (stop + unregister) runs as the rejection settles.
    await tick();
    await tick();

    expect(ctx.channels.get('boom')).toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('normal unload: adapter is unregistered, stop() awaited, signal aborted', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    const stop = vi.fn(async () => {});
    const start = vi.fn(async () => {});
    const signals: AbortSignal[] = [];
    const createContext = (signal: AbortSignal): ChannelAdapterContext => {
      signals.push(signal);
      return makeContext();
    };

    const fiber = ctx.plugin((c) => {
      mountChannelAdapter(c, makeAdapter('ok', { start, stop }), createContext);
    });
    await fiber;

    expect(ctx.channels.get('ok')).toBeDefined();
    expect(start).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);

    await fiber.dispose();

    expect(ctx.channels.get('ok')).toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(true);
  });
});
