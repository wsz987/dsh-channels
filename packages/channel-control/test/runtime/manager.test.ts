/**
 * ChannelRuntimeManager tests (doc §23, §25, §60 / M2 Task 3) with a fake
 * adapter + real ChannelService + fake definition.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import {
  ChannelService,
  type ChannelAdapter,
  type ChannelAdapterContext,
  type ChannelCapabilities,
  type ChannelHealth,
} from '@wsz987/channel-core';
import { ChannelDefinitionRegistry } from '../../src/definitions/registry.js';
import { ChannelRuntimeManager } from '../../src/runtime/manager.js';
import type { CredentialSeam } from '../../src/credentials/manager.js';
import type { ChannelDefinition } from '../../src/index.js';

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
    getHealth: vi.fn(async (): Promise<ChannelHealth> => ({ status: 'ok', connection: 'connected' })),
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

const seam: CredentialSeam = {
  async resolve() {
    return undefined;
  },
  async describe() {
    return { configured: false, writable: true };
  },
  async set() {},
  async unset() {},
};

function makeDef(id: string, overrides: Partial<ChannelDefinition> = {}): ChannelDefinition {
  return {
    id,
    enabled: true,
    setup: { fields: [], authMethods: ['credentials'] },
    getConfiguredState: async () => ({ configured: true, fields: {} }),
    saveConfig: async () => {},
    createAdapter: async () => {
      throw new Error('not used');
    },
    ...overrides,
  } as ChannelDefinition;
}

function harness(defs: ChannelDefinition[], adapters: Map<string, () => ChannelAdapter>) {
  const ctx = new Context();
  new ChannelService(ctx);
  const registry = new ChannelDefinitionRegistry();
  for (const def of defs) registry.register(def);

  const manager = new ChannelRuntimeManager({ ctx, registry, credentials: seam });

  // Point each definition's createAdapter at the fake adapter factory.
  for (const def of defs) {
    const factory = adapters.get(def.id);
    if (factory) {
      (def as ChannelDefinition).createAdapter = async () => factory();
    }
  }
  return { ctx, registry, manager };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ChannelRuntimeManager', () => {
  it('start mounts + registers in ctx.channels; status().mounted is true', async () => {
    const adapter = makeAdapter('fake');
    const { ctx, manager } = harness([makeDef('fake')], new Map([['fake', () => adapter]]));

    await manager.start('fake');

    expect(ctx.channels.get('fake')).toBeDefined();
    expect(ctx.channels.get('fake')).toBe(adapter);
    expect(await manager.status('fake')).toMatchObject({ mounted: true, running: true });
    await manager.stop('fake');
    await tick();
  });

  it('start when already mounted disposes the old adapter and registers the new one', async () => {
    const oldAdapter = makeAdapter('fake');
    const newAdapter = makeAdapter('fake');
    let cursor = oldAdapter;
    const { ctx, manager } = harness(
      [makeDef('fake')],
      new Map([['fake', () => cursor]]),
    );

    await manager.start('fake');
    expect(ctx.channels.get('fake')).toBe(oldAdapter);

    cursor = newAdapter;
    await manager.start('fake'); // restart semantics via dispose-first

    expect(oldAdapter.stop).toHaveBeenCalledTimes(1);
    expect(ctx.channels.get('fake')).toBe(newAdapter);
    await manager.stop('fake');
    await tick();
  });

  it('stop disposes the adapter exactly once, unregisters, and clears the map entry', async () => {
    const adapter = makeAdapter('fake');
    const { ctx, manager } = harness([makeDef('fake')], new Map([['fake', () => adapter]]));

    await manager.start('fake');
    expect(manager.isRunning('fake')).toBe(true);

    await manager.stop('fake');

    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(ctx.channels.get('fake')).toBeUndefined();
    expect(manager.isRunning('fake')).toBe(false);
    const status = await manager.status('fake');
    expect(status.mounted).toBe(false);
  });

  it('stop on a non-running channel is idempotent', async () => {
    const { manager } = harness([makeDef('fake')], new Map());
    await expect(manager.stop('fake')).resolves.toBeUndefined();
    await expect(manager.stop('fake')).resolves.toBeUndefined();
  });

  it('restart disposes the old adapter and registers a fresh one', async () => {
    const first = makeAdapter('fake');
    const second = makeAdapter('fake');
    let cursor = first;
    const { ctx, manager } = harness(
      [makeDef('fake')],
      new Map([['fake', () => cursor]]),
    );

    await manager.start('fake');
    expect(ctx.channels.get('fake')).toBe(first);

    cursor = second;
    await manager.restart('fake');

    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(ctx.channels.get('fake')).toBe(second);
    await manager.stop('fake');
    await tick();
  });

  it('restart restores the previous adapter when the replacement fails to start', async () => {
    const oldAdapter = makeAdapter('fake');
    const failingAdapter = makeAdapter('fake', {
      start: async () => {
        throw new Error('replacement start failed');
      },
    });
    let cursor = oldAdapter;
    const { ctx, manager } = harness(
      [makeDef('fake')],
      new Map([['fake', () => cursor]]),
    );

    await manager.start('fake');
    cursor = failingAdapter;
    let rolledBack = false;
    await expect(manager.restart('fake', undefined, () => { rolledBack = true; })).rejects.toThrow('replacement start failed');

    expect(rolledBack).toBe(true);
    expect(ctx.channels.get('fake')).toBe(oldAdapter);
    expect(manager.isRunning('fake')).toBe(true);
    expect(oldAdapter.stop).toHaveBeenCalledTimes(1);
    expect(oldAdapter.start).toHaveBeenCalledTimes(2);
    await manager.stop('fake');
    await tick();
  });

  it('keeps the candidate failure when rollback itself fails before replacement startup', async () => {
    const oldAdapter = makeAdapter('fake');
    const { ctx, manager, registry } = harness(
      [makeDef('fake')],
      new Map([['fake', () => oldAdapter]]),
    );
    await manager.start('fake');
    (registry.get('fake') as ChannelDefinition).createAdapter = async () => {
      throw new Error('candidate build failed');
    };

    await expect(
      manager.restart('fake', undefined, async () => { throw new Error('rollback failed'); }),
    ).rejects.toThrow('candidate build failed');

    expect(ctx.channels.get('fake')).toBe(oldAdapter);
    expect(manager.isRunning('fake')).toBe(true);
    await manager.stop('fake');
    await tick();
  });

  it('adapter start() throwing is surfaced with no residual registry entry and lastError set', async () => {
    const failing = makeAdapter('fake', {
      start: async () => {
        throw new Error('start boom');
      },
    });
    const { ctx, manager } = harness([makeDef('fake')], new Map([['fake', () => failing]]));

    await expect(manager.start('fake')).rejects.toThrow('start boom');

    // No residual registry entry (the transactional mount rolled back).
    expect(ctx.channels.get('fake')).toBeUndefined();
    expect(manager.isRunning('fake')).toBe(false);
    // status() surfaces the lastError without leaving a mounted entry.
    const status = await manager.status('fake');
    expect(status.mounted).toBe(false);
    expect(status.lastError).toContain('start boom');
  });

  it('autoStartAll mounts a configured definition and skips an unconfigured one', async () => {
    const running = makeAdapter('running');
    const { ctx, manager, registry } = harness(
      [makeDef('running'), makeDef('idle')],
      new Map([['running', () => running]]),
    );
    // Mark 'idle' as not configured.
    (registry.get('idle') as ChannelDefinition).getConfiguredState = async () => ({
      configured: false,
      fields: {},
    });

    const result = await manager.autoStartAll();

    expect(result.skipped).toBe(1);
    expect(result.started).toBe(1);
    expect(ctx.channels.get('running')).toBe(running);
    expect(ctx.channels.get('idle')).toBeUndefined();
    await manager.stop('running');
    await tick();
  });

  it('autoStartOne starts a configured definition and skips an unconfigured one', async () => {
    const running = makeAdapter('running');
    const { ctx, manager, registry } = harness(
      [makeDef('running'), makeDef('idle')],
      new Map([['running', () => running]]),
    );
    (registry.get('idle') as ChannelDefinition).getConfiguredState = async () => ({
      configured: false,
      fields: {},
    });

    // A definition whose configured state is false is skipped (no adapter).
    expect(await manager.autoStartOne('idle')).toBe(false);
    expect(ctx.channels.get('idle')).toBeUndefined();

    expect(await manager.autoStartOne('running')).toBe(true);
    expect(ctx.channels.get('running')).toBe(running);
    await manager.stop('running');
    await tick();
  });

  it('autoStartOne is a no-op for unknown/autoStart-false definitions and never throws', async () => {
    const failing = makeAdapter('boom', {
      start: async () => {
        throw new Error('boom');
      },
    });
    const { ctx, manager, registry } = harness(
      [makeDef('autoOff'), makeDef('boom')],
      new Map([['boom', () => failing]]),
    );
    (registry.get('autoOff') as ChannelDefinition).autoStart = false;

    expect(await manager.autoStartOne('nope')).toBe(false);
    expect(await manager.autoStartOne('autoOff')).toBe(false);
    // A failing start is logged, never thrown out of autoStartOne.
    expect(await manager.autoStartOne('boom')).toBe(false);
    expect(ctx.channels.get('boom')).toBeUndefined();
  });

  it('autoStartAll respects autoStart=false and a failing definition does not throw out', async () => {
    const failing = makeAdapter('boom', {
      start: async () => {
        throw new Error('boom');
      },
    });
    const { ctx, manager, registry } = harness(
      [
        makeDef('autoOff'),
        makeDef('boom'),
      ],
      new Map([['boom', () => failing]]),
    );
    (registry.get('autoOff') as ChannelDefinition).autoStart = false;

    // Should resolve (failure logged, not propagated) rather than reject.
    const result = await manager.autoStartAll();

    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(ctx.channels.get('boom')).toBeUndefined();
  });
});
