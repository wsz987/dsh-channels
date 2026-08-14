/**
 * `ChannelService` — the Cordis Service mounted at `ctx.channels`.
 *
 * Registry + typed event subscription for the whole channel runtime.
 * Per architecture §20, v1 keeps channel events inside the service (typed
 * listeners) instead of registering every platform behavior as a global
 * Cordis event; `channels/event` + `channels/status` global surfaces can be
 * added later when third-party observation is needed.
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import type { ChannelAdapter } from './adapter.js';
import type { ChannelEvent } from './events.js';
import { AdapterRegistry } from './registry.js';
import { conversationKey, type ChannelConversationKey } from './account.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    channels: ChannelService;
  }
}

export type ChannelEventListener = (event: ChannelEvent) => void | Promise<void>;

export class ChannelService extends Service {
  /** Stable registry of live adapters. */
  readonly registry = new AdapterRegistry();

  private readonly listeners = new Set<ChannelEventListener>();

  constructor(ctx: Context) {
    super(ctx, 'channels');
  }

  /** Register an adapter; returns an unregister disposer. */
  register(adapter: ChannelAdapter): () => void {
    return this.registry.register(adapter);
  }

  get(id: string): ChannelAdapter | undefined {
    return this.registry.get(id);
  }

  list(): ChannelAdapter[] {
    return this.registry.list();
  }

  /**
   * Subscribe to adapter events. The returned disposer removes the listener;
   * the listener set is also cleared when this service fiber unloads.
   */
  on(listener: ChannelEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Deliver one adapter event to every registered listener. Async listeners
   * are awaited; a sync throw or rejected promise never blocks the other
   * listeners, but every rejection is logged and the first one is rethrown
   * so the error surfaces to the caller instead of being lost.
   */
  async emit(event: ChannelEvent): Promise<void> {
    const results = await Promise.allSettled(
      [...this.listeners].map((listener) =>
        Promise.resolve().then(() => listener(event)),
      ),
    );
    let firstError: unknown;
    for (const result of results) {
      if (result.status !== 'rejected') continue;
      try {
        this.ctx.logger('channels').error(
          '[channels] listener failed while emitting an event',
          result.reason,
        );
      } catch {
        console.error('[channels] listener failed while emitting an event', result.reason);
      }
      if (firstError === undefined) firstError = result.reason;
    }
    if (firstError !== undefined) throw firstError;
  }

  /** Resolve the canonical conversation key (shared with the bridge). */
  key(conversation: ChannelConversationKey): string {
    return conversationKey(conversation);
  }
}

/** Runtime type guard for events entering the service. */
export function isChannelEvent(value: unknown): value is ChannelEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as Partial<ChannelEvent>;
  return (
    typeof event.type === 'string' &&
    typeof event.channel === 'string' &&
    typeof event.accountId === 'string'
  );
}
