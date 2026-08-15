/**
 * Transactional adapter mount (doc §5, §22).
 *
 * Registers an adapter on the ChannelService and starts it inside ONE Cordis
 * effect. If `adapter.start()` throws, the mount rolls back best-effort —
 * the abort signal is fired, the adapter is told to stop, the registration is
 * removed, and the original error is rethrown, so a failed start can never
 * leave a partially-started adapter behind in the registry.
 *
 * The effect returns an actively-callable disposer which is also run on parent
 * fiber unload. `mountChannelAdapter` exposes it as a stable
 * `ChannelMountHandle` so a future control plane (doc §23
 * `ChannelControlService`) can stop/restart an adapter on demand while still
 * relying on Cordis fiber unload for automatic cleanup:
 *
 * ```text
 * ChannelControlService
 *   └─ Map<ChannelAccountKey, ChannelMountHandle>
 * ```
 *
 * On dispose (manual or fiber unload) the disposer aborts
 * `createContext`'s signal, awaits `adapter.stop()`, and unregisters the
 * adapter. Cordis guarantees the disposer is idempotent, so a manual dispose
 * followed by fiber unload never double-stops the adapter.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChannelAdapter } from './adapter.js';
import type { ChannelAdapterContext } from './context.js';

/**
 * Handle to one mounted adapter. Dispose it to stop the adapter and remove its
 * registration from the registry. Dispose is idempotent: calling it more than
 * once (or after the parent fiber unloads) is a no-op.
 */
export interface ChannelMountHandle {
  /** Stop the adapter and unregister it. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Mount (register + start) a channel adapter under a `ctx` fiber and return
 * an actively-callable `ChannelMountHandle`.
 *
 * `createContext(signal)` is called with the exclusive per-adapter abort
 * signal right before `adapter.start`, so the adapter's `ChannelAdapterContext`
 * is aborted both on a failed start (rollback) and on unload/dispose.
 *
 * The returned handle wraps the disposer returned by `ctx.effect`, so it both
 * supports on-demand disposal and still cleans up automatically when the
 * parent Cordis fiber unloads.
 */
export function mountChannelAdapter(
  ctx: Context,
  adapter: ChannelAdapter,
  createContext: (signal: AbortSignal) => ChannelAdapterContext,
): ChannelMountHandle {
  const dispose = ctx.effect(async () => {
    const abort = new AbortController();
    // Registration happens before start; on a start failure we must remove it.
    const unregister = ctx.channels.register(adapter);
    try {
      await adapter.start(createContext(abort.signal));
    } catch (error) {
      abort.abort();
      try {
        await adapter.stop();
      } catch {
        // Best-effort rollback of the network resources.
      }
      unregister();
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
  return { dispose: () => dispose() };
}
