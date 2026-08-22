/**
 * R1 reliability tests: two-phase dedup + cursor commit crash safety.
 *
 * Case A: emit failure does not commit dedup -> replay re-emits.
 * Case B: emit success + dedup commit + "crash" -> replay is skipped.
 * Case C: M1 success + M2 failure -> cursor not advanced -> M1 skipped, M2 retried.
 * Case D: cursor write failure -> monitor retries, local cursor not advanced.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  ChannelAdapterContext,
  ChannelStorage,
  SecretStore,
} from '@wsz987/channel-core';
import {
  ContextTokenStore,
  CursorCommitError,
  MemoryDedupStore,
  PersistentDedupStore,
  SyncCursorStore,
  WeixinMonitor,
  dedupKey,
  type DedupStore,
} from '../src/index.js';
import type { ILinkClient } from '../src/ilink/client.js';
import { StaleTokenError } from '../src/ilink/errors.js';

class FakeStorage implements ChannelStorage {
  private readonly map = new Map<string, string>();
  /** Key whose next set() should throw (cleared after one throw). */
  failNextFor: string | null = null;

  async get(key: string): Promise<string | undefined> {
    return this.map.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    if (this.failNextFor === key) {
      this.failNextFor = null;
      throw new Error('injected storage write failure for ' + key);
    }
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

interface ScriptedRound {
  msgs: unknown[];
  get_updates_buf?: string;
}

class FakeClient {
  private readonly scripts: ScriptedRound[];

  constructor(scripts: ScriptedRound[]) {
    this.scripts = scripts.slice();
  }

  async notifyStart(): Promise<unknown> {
    return {};
  }
  async notifyStop(): Promise<unknown> {
    return {};
  }
  async getUpdates(params: { getUpdatesBuf?: string }): Promise<ScriptedRound> {
    const next = this.scripts.shift();
    if (!next) {
      // Hold the long-poll with a small yield so the loop does not busy-spin.
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { msgs: [], get_updates_buf: params.getUpdatesBuf };
    }
    return next;
  }
}

function msg(id: number, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: id,
    from_user_id: 'user_' + id,
    create_time_ms: 1700000000000,
    item_list: [{ type: 1, text_item: { text } }],
    ...extra,
  };
}

interface Harness {
  monitor: WeixinMonitor;
  client: FakeClient;
  storage: FakeStorage;
  cursor: SyncCursorStore;
  emits: string[];
}

function makeHarness(opts: {
  scripts: ScriptedRound[];
  emit?: (event: { message: { id: string } }) => Promise<void>;
  dedup?: DedupStore;
  storage?: FakeStorage;
}): Harness {
  const storage = opts.storage ?? new FakeStorage();
  const client = new FakeClient(opts.scripts);
  const cursor = new SyncCursorStore({ storage, accountId: 'main' });
  const emits: string[] = [];
  const emit = opts.emit ?? (async (event: { message: { id: string } }) => {
    emits.push(event.message.id);
  });

  const controller = new AbortController();
  const ctx = {
    emit: async () => {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    secrets: {} as SecretStore,
    storage,
    signal: controller.signal,
  } as ChannelAdapterContext;

  const monitor = new WeixinMonitor({
    client: client as unknown as ILinkClient,
    cursor,
    contextTokens: new ContextTokenStore({ storage, accountId: 'main' }),
    ctx,
    meta: { channel: 'weixin' as never, accountId: 'main' },
    emit: emit as never,
    reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0 },
    longPollTimeoutMs: 1000,
    dedupWindowMs: 60_000,
    dedup: opts.dedup,
    now: () => 1700000000000,
  });

  return { monitor, client, storage, cursor, emits };
}

describe('PersistentDedupStore (Case B: crash replay)', () => {
  it('committed keys survive a restart and are skipped', async () => {
    const storage = new FakeStorage();
    const key = dedupKey({ message_id: 123, from_user_id: 'u' });

    const first = new PersistentDedupStore({ storage, accountId: 'main', windowMs: 60_000, now: () => 1000 });
    expect(await first.has(key)).toBe(false);
    await first.commit(key);

    // "restart": a fresh store over the same durable storage
    const second = new PersistentDedupStore({ storage, accountId: 'main', windowMs: 60_000, now: () => 1000 });
    expect(await second.has(key)).toBe(true);
  });

  it('has() never records; only commit() marks a key', async () => {
    const storage = new FakeStorage();
    const store = new PersistentDedupStore({ storage, accountId: 'main', windowMs: 60_000, now: () => 1000 });
    const key = dedupKey({ message_id: 7, from_user_id: 'u' });
    expect(await store.has(key)).toBe(false);
    expect(await store.has(key)).toBe(false); // has() is side-effect free
    await store.commit(key);
    expect(await store.has(key)).toBe(true);
  });
});

describe('WeixinMonitor reliability', () => {
  it('hydrates and logs a secret-free media summary before emitting', async () => {
    const storage = new FakeStorage();
    const order: string[] = [];
    const logs: unknown[] = [];
    const controller = new AbortController();
    const client = new FakeClient([{
      msgs: [{
        message_id: 10,
        from_user_id: 'user_10',
        item_list: [{
          type: 2,
          image_item: { media: { full_url: 'https://signed.example/private?token=secret' } },
        }],
      }],
    }]);
    const monitor = new WeixinMonitor({
      client: client as unknown as ILinkClient,
      cursor: new SyncCursorStore({ storage, accountId: 'main' }),
      contextTokens: new ContextTokenStore({ storage, accountId: 'main' }),
      ctx: {
        emit: async () => {},
        logger: {
          debug() {},
          info(_message: string, details: unknown) { order.push('log'); logs.push(details); },
          warn() {},
          error() {},
        },
        secrets: {} as SecretStore,
        storage,
        signal: controller.signal,
      } as ChannelAdapterContext,
      meta: { channel: 'weixin' as never, accountId: 'main' },
      beforeEmit: async (event) => {
        const image = event.message.content[0];
        if (image?.type === 'image') image.localData = new Uint8Array([1, 2, 3]);
      },
      emit: async () => { order.push('emit'); controller.abort(); },
      reconnect: { enabled: false, baseDelayMs: 0, maxDelayMs: 0 },
      longPollTimeoutMs: 1000,
      dedupWindowMs: 60_000,
    });

    await monitor.start();
    await monitor.join();
    expect(order).toEqual(['log', 'emit']);
    expect(JSON.stringify(logs)).toContain('"localDataBytes":3');
    expect(JSON.stringify(logs)).not.toContain('signed.example');
    expect(JSON.stringify(logs)).not.toContain('secret');
  });

  it('stops terminally on a stale token instead of reconnecting', async () => {
    const storage = new FakeStorage();
    const controller = new AbortController();
    let staleCalls = 0;
    const states: string[] = [];
    const client = {
      notifyStart: async () => ({}),
      notifyStop: async () => ({}),
      getUpdates: async () => { throw new StaleTokenError('main'); },
    } as unknown as ILinkClient;
    const monitor = new WeixinMonitor({
      client,
      cursor: new SyncCursorStore({ storage, accountId: 'main' }),
      contextTokens: new ContextTokenStore({ storage, accountId: 'main' }),
      ctx: {
        emit: async () => {}, logger: { debug() {}, info() {}, warn() {}, error() {} },
        secrets: {} as SecretStore, storage, signal: controller.signal,
      } as ChannelAdapterContext,
      meta: { channel: 'weixin' as never, accountId: 'main' },
      reconnect: { enabled: true, baseDelayMs: 0, maxDelayMs: 0 },
      longPollTimeoutMs: 1000,
      dedupWindowMs: 60_000,
      onConnectionChange: (state) => states.push(state),
      onStaleToken: () => { staleCalls += 1; },
    });

    await monitor.start();
    await vi.waitFor(() => expect(staleCalls).toBe(1));
    await monitor.join();
    expect(states).not.toContain('reconnecting');
    expect(states.at(-1)).toBe('disconnected');
  });

  it('Case A: emit failure does not commit the message (replay re-emits)', async () => {
    const m1 = msg(1, 'hi');
    const emits: string[] = [];
    let throwsLeft = 1;
    const h = makeHarness({
      scripts: [
        { msgs: [m1], get_updates_buf: 'next' },
        { msgs: [m1], get_updates_buf: 'next' },
        { msgs: [] },
      ],
      dedup: new MemoryDedupStore({ windowMs: 60_000, now: () => 1700000000000 }),
      emit: async (event) => {
        emits.push(event.message.id);
        if (throwsLeft > 0) {
          throwsLeft -= 1;
          throw new Error('emit boom');
        }
      },
    });

    await h.monitor.start();
    await vi.waitFor(() => {
      expect(emits).toEqual(['wx-1', 'wx-1']);
    }, { timeout: 3000 });
    await h.monitor.stop();
    await h.monitor.join();
    expect(await h.cursor.load()).toBe('next');
  });

  it('Case C: M1 success + M2 failure skips M1 on replay and retries M2', async () => {
    const m1 = msg(1, 'one');
    const m2 = msg(2, 'two');
    const emits: string[] = [];
    let m2ThrowsLeft = 1;
    const h = makeHarness({
      scripts: [
        { msgs: [m1, m2], get_updates_buf: 'next' },
        { msgs: [m1, m2], get_updates_buf: 'next' },
        { msgs: [] },
      ],
      dedup: new MemoryDedupStore({ windowMs: 60_000, now: () => 1700000000000 }),
      emit: async (event) => {
        emits.push(event.message.id);
        if (event.message.id === 'wx-2' && m2ThrowsLeft > 0) {
          m2ThrowsLeft -= 1;
          throw new Error('M2 boom');
        }
      },
    });

    await h.monitor.start();
    await vi.waitFor(() => {
      expect(emits).toEqual(['wx-1', 'wx-2', 'wx-2']);
    }, { timeout: 3000 });
    await h.monitor.stop();
    await h.monitor.join();
    expect(await h.cursor.load()).toBe('next');
  });

  it('Case D: cursor commit failure retries and does not advance until success', async () => {
    const m1 = msg(1, 'hi'); // no context_token -> no context-token write
    const storage = new FakeStorage();
    storage.failNextFor = 'weixin:sync-cursor:main';
    const emits: string[] = [];
    const h = makeHarness({
      scripts: [
        { msgs: [m1], get_updates_buf: 'next' },
        { msgs: [m1], get_updates_buf: 'next' },
        { msgs: [] },
      ],
      storage,
      dedup: new MemoryDedupStore({ windowMs: 60_000, now: () => 1700000000000 }),
      emit: async (event) => {
        emits.push(event.message.id);
      },
    });

    await h.monitor.start();
    await vi.waitFor(async () => {
      expect(await h.cursor.load()).toBe('next');
    }, { timeout: 3000 });
    // M1 emitted exactly once (dedup skipped the replay); cursor now durable.
    expect(emits).toEqual(['wx-1']);
    await h.monitor.stop();
    await h.monitor.join();
  });

  it('CursorCommitError carries the cursor and cause', () => {
    const cause = new Error('disk full');
    const err = new CursorCommitError('next', { cause });
    expect(err.cursor).toBe('next');
    expect(err.message).toContain('sync cursor');
    expect(err.cause).toBe(cause);
  });
});
