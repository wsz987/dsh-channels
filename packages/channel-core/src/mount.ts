/**
 * Transactional adapter mount (doc §5).
 *
 * Registers an adapter on the ChannelService and starts it inside ONE Cordis
 * effect. If `adapter.start()` throws, the mount rolls back best-effort —
 * the abort signal is fired, the adapter is told to stop, the registration is
 * removed, and the original error is rethrown, so a failed start can never
 * leave a partially-started adapter behind in the registry.
 *
 * On unload the effect disposer aborts `createContext`'s signal, awaits
 * `adapter.stop()`, and unregisters the adapter.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChannelAdapter } from './adapter.js';
import type { ChannelAdapterContext } from './context.js';

/**
 * Mount (register + start) a channel adapter under a `ctx` fiber.
 *
 * `createContext(signal)` is called with the exclusive per-adapter abort
 * signal right before `adapter.start`, so the adapter's `ChannelAdapterContext`
 * is aborted both on a failed start (rollback) and on unload.
 */
export function mountChannelAdapter(
  ctx: Context,
  adapter: ChannelAdapter,
  createContext: (signal: AbortSignal) => ChannelAdapterContext,
): void {
  ctx.effect(async () => {
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
}
