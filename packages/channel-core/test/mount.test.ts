/**
 * mountChannelAdapter transactional-mount tests (doc §5, §22).
 *
 * Proves:
 * - `adapter.start()` rejection -> no residual adapter in the registry and
 *   `adapter.stop()` was rollback-called.
 * - normal plugin unload -> the adapter is unregistered and `stop()` awaited.
 * - the `createContext` signal fires on unload.
 *
 * And the M2A control-plane foundation (doc §51 Task 2, §60 Runtime Test
 * Matrix):
 * - manual `handle.dispose()` -> `adapter.stop()` exactly once + unregister.
 * - manual dispose then parent fiber unload -> no double-stop.
 * - parent fiber unload alone -> `stop()` exactly once + unregister.
 * - `start()` throws -> rollback (abort fired, stop called, unregistered,
 *   error rethrown, no residual registry adapter).
 * - `dispose()` twice -> second call is a no-op.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  ChannelService,
  mountChannelAdapter,
  type ChannelAdapter,
  type ChannelAdapterContext,
  type ChannelCapabilities,
  type ChannelMountHandle,
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

/** Mount an adapter and capture the returned handle once the fiber is up. */
async function mountIn(
  ctx: Context,
  adapter: ChannelAdapter,
  createContext: (signal: AbortSignal) => ChannelAdapterContext,
): Promise<{ fiber: Context & { dispose(): Promise<void> }; handle: ChannelMountHandle }> {
  let handle: ChannelMountHandle | undefined;
  const fiber = ctx.plugin((c) => {
    handle = mountChannelAdapter(c, adapter, createContext);
  });
  await fiber;
  expect(handle).toBeDefined();
  handle as ChannelMountHandle;
  return { fiber, handle: handle as unknown as ChannelMountHandle };
}

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

  it('manual dispose(): stop() exactly once, adapter unregistered, signal aborted', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    const stop = vi.fn(async () => {});
    const start = vi.fn(async () => {});
    const signals: AbortSignal[] = [];
    const createContext = (signal: AbortSignal): ChannelAdapterContext => {
      signals.push(signal);
      return makeContext();
    };

    const { handle } = await mountIn(ctx, makeAdapter('manual', { start, stop }), createContext);

    expect(ctx.channels.get('manual')).toBeDefined();
    expect(signals[0]?.aborted).toBe(false);

    await handle.dispose();

    expect(ctx.channels.get('manual')).toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('manual dispose then parent fiber unload: no double-stop', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    const stop = vi.fn(async () => {});
    const adapter = makeAdapter('twice', { stop });

    const { fiber, handle } = await mountIn(ctx, adapter, () => makeContext());
    expect(ctx.channels.get('twice')).toBeDefined();

    await handle.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(ctx.channels.get('twice')).toBeUndefined();

    // Parent fiber unload after manual dispose must be a no-op.
    await fiber.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(ctx.channels.get('twice')).toBeUndefined();
  });

  it('parent fiber unload alone: stop() exactly once, unregistered', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    const stop = vi.fn(async () => {});
    const adapter = makeAdapter('unloadOnly', { stop });

    const { fiber } = await mountIn(ctx, adapter, () => makeContext());
    expect(ctx.channels.get('unloadOnly')).toBeDefined();

    await fiber.dispose();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(ctx.channels.get('unloadOnly')).toBeUndefined();
  });

  it('start() rolls back fully: abort fired, stop called, unregistered, error rethrown', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    const stop = vi.fn(async () => {});
    const boom = new Error('start boom');
    const signals: AbortSignal[] = [];
    const createContext = (signal: AbortSignal): ChannelAdapterContext => {
      signals.push(signal);
      return makeContext();
    };
    const adapter = makeAdapter('rollback', {
      start: async () => {
        throw boom;
      },
      stop,
    });

    let handle: ChannelMountHandle | undefined;
    const fiber = ctx.plugin((c) => {
      handle = mountChannelAdapter(c, adapter, createContext);
    });
    await fiber;
    await tick();

    // The rollback rethrows the original start error through the effect
    // disposer; a successful mount is never exposed on failure.
    await expect(handle?.dispose()).rejects.toBe(boom);
    expect(signals[0]?.aborted).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(ctx.channels.get('rollback')).toBeUndefined();
  });

  it('dispose() twice: second call is a no-op (stop exactly once)', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    const stop = vi.fn(async () => {});
    const adapter = makeAdapter('idem', { stop });

    const { handle } = await mountIn(ctx, adapter, () => makeContext());
    expect(ctx.channels.get('idem')).toBeDefined();

    await handle.dispose();
    await handle.dispose();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(ctx.channels.get('idem')).toBeUndefined();
  });
});
