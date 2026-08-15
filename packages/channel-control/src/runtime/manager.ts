/**
 * [ChannelRuntimeManager] — start/stop/restart/status for mounted channel
 * adapters (doc §21–§23, §25, §60; M2 Task 3 / M3 Task 6).
 *
 * Each mount lives in a Map keyed by `channelId:accountId` (default
 * account 'main'). Starting an already-mounted key disposes the old mount
 * first (restart semantics). The underlying mount is transactional — mirroring
 * channel-core's mountChannelAdapter: register → start → rollback on failure
 * (abort + stop + unregister + rethrow). Because the runtime must AWAIT
 * startup and capture start errors (the opaque core handle does not expose a
 * settle promise), the mount here drives the SAME Cordis effect directly and
 * exposes a `ChannelMountHandle`-shaped disposer, so a failed start never
 * leaves a residual registry entry and surfaces lastError via status().
 *
 * autoStartAll() mounts every registered definition whose autoStart is not
 * false and whose dynamic configured state is configured; unconfigured
 * channels are skipped silently (doc §25/§27) and a failing definition is
 * logged, never allowed to crash plugin activation.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChannelAdapter, ChannelHealth } from '@wsz987/channel-core';
import { ChannelDefinitionRegistry } from '../definitions/registry.js';
import type { CredentialSeam } from '../credentials/manager.js';
import type { ChannelRuntimeStatus } from '../types.js';
import type { ChannelMountHandle } from './mount-handle.js';

export interface ChannelRuntimeManagerOptions {
  ctx: Context;
  registry: ChannelDefinitionRegistry;
  credentials: CredentialSeam;
}

/** One mounted adapter plus the adapter instance for health/status queries. */
interface MountRecord {
  handle: ChannelMountHandle;
  adapter: ChannelAdapter;
}

const DEFAULT_ACCOUNT = 'main';

export class ChannelRuntimeManager {
  private readonly mounts = new Map<string, MountRecord>();
  private readonly errors = new Map<string, string>();
  private readonly ctx: Context;
  private readonly registry: ChannelDefinitionRegistry;
  private readonly credentials: CredentialSeam;

  constructor(options: ChannelRuntimeManagerOptions) {
    this.ctx = options.ctx;
    this.registry = options.registry;
    this.credentials = options.credentials;
  }

  key(channelId: string, accountId?: string): string {
    return `${channelId}:${accountId ?? DEFAULT_ACCOUNT}`;
  }

  async start(channelId: string, accountId?: string): Promise<void> {
    const key = this.key(channelId, accountId);
    const existing = this.mounts.get(key);
    if (existing) {
      await existing.handle.dispose();
      this.mounts.delete(key);
    }

    const definition = this.registry.require(channelId);
    const adapter = await definition.createAdapter();

    try {
      const { handle, settled } = this.mountTransactional(channelId, adapter);
      await settled;
      this.mounts.set(key, { handle, adapter });
      this.errors.delete(key);
    } catch (error) {
      // mountTransactional + core rollback already unregistered; record the
      // error so status() can surface it. A partial mount is never stored.
      this.errors.set(key, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async stop(channelId: string, accountId?: string): Promise<void> {
    const key = this.key(channelId, accountId);
    const record = this.mounts.get(key);
    if (!record) {
      this.errors.delete(key);
      return;
    }
    this.mounts.delete(key);
    await record.handle.dispose();
    this.errors.delete(key);
  }

  async restart(
    channelId: string,
    accountId?: string,
    rollback?: () => Promise<void> | void,
  ): Promise<void> {
    const key = this.key(channelId, accountId);
    const existing = this.mounts.get(key);
    const definition = this.registry.require(channelId);
    let candidate: ChannelAdapter;
    try {
      // Resolve credentials/build before touching the active connection.
      candidate = await definition.createAdapter();
    } catch (error) {
      try {
        await rollback?.();
      } catch (recoveryError) {
        this.errors.set(
          key,
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
        );
      }
      throw error;
    }

    if (existing) {
      await existing.handle.dispose();
      this.mounts.delete(key);
    }
    try {
      await this.mount(key, channelId, candidate);
      this.errors.delete(key);
    } catch (error) {
      try {
        // Restore setup before restarting the old instance: adapters retain a
        // reference to their definition's mutable config snapshot.
        await rollback?.();
        if (existing) await this.mount(key, channelId, existing.adapter);
      } catch (recoveryError) {
        this.errors.set(
          key,
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
        );
      }
      throw error;
    }
  }

  async status(channelId: string, accountId?: string): Promise<ChannelRuntimeStatus> {
    const key = this.key(channelId, accountId);
    const record = this.mounts.get(key);
    const lastError = this.errors.get(key) ?? null;

    if (!record) {
      return {
        mounted: false,
        running: false,
        connection: 'unknown',
        health: null,
        lastError,
      };
    }

    let health: ChannelHealth | null = null;
    if (record.adapter.getHealth) {
      try {
        health = (await record.adapter.getHealth()) ?? null;
      } catch {
        health = null;
      }
    }

    const connection =
      health?.connection === 'connected'
        ? 'connected'
        : health?.connection === 'disconnected'
          ? 'disconnected'
          : health?.status === 'down'
            ? 'disconnected'
            : health?.status === 'degraded'
              ? 'degraded'
              : 'unknown';

    return {
      mounted: true,
      running: true,
      connection,
      health,
      lastError,
    };
  }

  isRunning(channelId: string, accountId?: string): boolean {
    return this.mounts.has(this.key(channelId, accountId));
  }

  /**
   * The currently mounted adapter for a channel (doc §43: the Weixin
   * definition delegates beginAuth/pollAuth/submitAuthInput to the mounted
   * adapter so the M1 auth flow itself is unchanged). Returns undefined when
   * not mounted.
   */
  adapter(channelId: string, accountId?: string): ChannelAdapter | undefined {
    return this.mounts.get(this.key(channelId, accountId))?.adapter;
  }

  /**
   * Auto-start ONE definition when it is registered (doc §27). Skips
   * silently when autoStart is false or the channel is not configured; a
   * failing start is logged and never thrown (registration must not crash
   * the profile). Returns true when mounted.
   */
  async autoStartOne(channelId: string): Promise<boolean> {
    const definition = this.registry.get(channelId);
    if (!definition || !definition.enabled || definition.autoStart === false) return false;
    const logger = this.ctx.logger('channel-control');
    try {
      const configured = (await definition.getConfiguredState()).configured;
      if (!configured) {
        logger.info('[channel-control] \'' + channelId + '\' not configured; skipping autoStart');
        return false;
      }
      await this.start(channelId);
      logger.info('[channel-control] \'' + channelId + '\' auto-started');
      return true;
    } catch (error) {
      logger.error('[channel-control] \'' + channelId + '\' failed to auto-start', error);
      return false;
    }
  }

  /**
   * Mount every enabled+configured registered definition (doc §25, §27).
   * Unconfigured channels are skipped silently. A failing start is logged and
   * never propagates, so an unconfigured/broken channel cannot crash the
   * profile. Returns { started, skipped } counts.
   */
  async autoStartAll(): Promise<{ started: number; skipped: number; failed: number }> {
    let started = 0;
    let skipped = 0;
    let failed = 0;
    const logger = this.ctx.logger('channel-control');

    for (const definition of this.registry.list()) {
      if (!definition.enabled || definition.autoStart === false) {
        skipped += 1;
        continue;
      }
      let configured = false;
      try {
        configured = (await definition.getConfiguredState()).configured;
      } catch (error) {
        // A definition that cannot even describe its state must not crash the
        // profile; treat it as skipped and log.
        skipped += 1;
        logger.warn(
          `[channel-control] definition '${definition.id}' could not report configured state; skipping autoStart`,
          error,
        );
        continue;
      }
      if (!configured) {
        skipped += 1;
        logger.info(`[channel-control] '${definition.id}' not configured; skipping autoStart`);
        continue;
      }
      try {
        await this.start(definition.id);
        started += 1;
        logger.info(`[channel-control] '${definition.id}' auto-started`);
      } catch (error) {
        failed += 1;
        logger.error(`[channel-control] '${definition.id}' failed to auto-start`, error);
      }
    }
    return { started, skipped, failed };
  }

  /** Dispose and forget every mounted adapter. */
  async stopAll(): Promise<void> {
    const keys = [...this.mounts.keys()];
    for (const key of keys) {
      const sep = key.indexOf(':');
      const channelId = sep >= 0 ? key.slice(0, sep) : key;
      const rawAccount = sep >= 0 ? key.slice(sep + 1) : undefined;
      const accountId = rawAccount === DEFAULT_ACCOUNT ? undefined : rawAccount;
      await this.stop(channelId, accountId);
    }
  }

  private mountTransactional(
    channelId: string,
    adapter: ChannelAdapter,
  ): { handle: ChannelMountHandle; settled: Promise<void> } {
    const createContext = (signal: AbortSignal) =>
      this.ctx.channels.createAdapterContext({ channelId, signal });

    // Mirror channel-core's transactional mount on a Cordis effect so we can
    // await startup and capture start errors, while still returning a
    // ChannelMountHandle-shaped disposer stored in the mounts Map.
    let resolveSettled!: () => void;
    let rejectSettled!: (error: unknown) => void;
    const settled = new Promise<void>((resolve, reject) => {
      resolveSettled = resolve;
      rejectSettled = reject;
    });

    const dispose = this.ctx.effect(async () => {
      const abort = new AbortController();
      const unregister = this.ctx.channels.register(adapter);
      try {
        await adapter.start(createContext(abort.signal));
        resolveSettled();
      } catch (error) {
        abort.abort();
        try {
          await adapter.stop();
        } catch {
          // Best-effort rollback of network resources.
        }
        unregister();
        rejectSettled(error);
        throw error;
      }
      return async () => {
        abort.abort();
        try {
          await adapter.stop();
        } finally {
          unregister();
        }
      };
    });

    const handle: ChannelMountHandle = { dispose: () => dispose() };
    return { handle, settled };
  }

  private async mount(key: string, channelId: string, adapter: ChannelAdapter): Promise<void> {
    try {
      const { handle, settled } = this.mountTransactional(channelId, adapter);
      await settled;
      this.mounts.set(key, { handle, adapter });
    } catch (error) {
      this.errors.set(key, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
