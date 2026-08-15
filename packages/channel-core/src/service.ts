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
import { MemorySecretStore } from './secrets.js';
import { MemoryStorage } from './storage.js';
import type { ChannelAdapterContext } from './context.js';
import type { ChannelRuntimeResources } from './runtime-resources.js';
import { channelEventEnvelopeSchema } from './schema.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    channels: ChannelService;
  }
}

export type ChannelEventListener = (event: ChannelEvent) => void | Promise<void>;

export interface ChannelServiceOptions {
  /**
   * Optional durable runtime resources. When omitted, the service falls back
   * to in-memory stores (tests / no persistence configured). Production wiring
   * resolves file-backed resources and passes them here.
   */
  resources?: Partial<ChannelRuntimeResources>;
}

export interface CreateAdapterContextOptions {
  /** Adapter id, used to namespace the logger (e.g. 'weixin' -> 'channel-weixin'). */
  channelId?: string;
  /** Exclusive per-adapter abort signal (owns the adapter's network lifetime). */
  signal: AbortSignal;
}

export class ChannelService extends Service {
  /** Stable registry of live adapters. */
  readonly registry = new AdapterRegistry();

  /** Durable SecretStore + ChannelStorage shared by every mounted adapter. */
  readonly resources: ChannelRuntimeResources;

  private readonly listeners = new Set<ChannelEventListener>();

  constructor(ctx: Context, options: ChannelServiceOptions = {}) {
    super(ctx, 'channels');
    this.resources = {
      secrets: options.resources?.secrets ?? new MemorySecretStore(),
      storage: options.resources?.storage ?? new MemoryStorage(),
    };
  }

  /**
   * Build a complete ChannelAdapterContext bound to this service's shared
   * resources. Adapters use this instead of hand-rolling emit/logger/secrets/
   * storage/signal so every platform mounts against the same durable backend.
   */
  createAdapterContext(options: CreateAdapterContextOptions): ChannelAdapterContext {
    const loggerName = options.channelId ? 'channel-' + options.channelId : 'channels';
    return {
      emit: (event) => this.emit(event),
      logger: this.ctx.logger(loggerName),
      secrets: this.resources.secrets,
      storage: this.resources.storage,
      signal: options.signal,
    };
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
  return channelEventEnvelopeSchema.safeParse(value).success;
}
