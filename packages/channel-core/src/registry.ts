/**
 * Adapter registry owned by `ChannelService`.
 *
 * Registration returns a disposer, duplicate ids fail loudly, and adapters
 * are keyed by a stable string id.
 */
import { ChannelDuplicateError, ChannelError } from './errors.js';
import type { ChannelAdapter } from './adapter.js';

export class AdapterRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();

  /** Register an adapter; throws on duplicate id. Returns an unregister disposer. */
  register(adapter: ChannelAdapter): () => void {
    const { id } = adapter;
    if (this.adapters.has(id)) {
      throw new ChannelDuplicateError(`adapter '${id}' is already registered`);
    }
    this.adapters.set(id, adapter);
    return () => {
      this.adapters.delete(id);
    };
  }

  get(id: string): ChannelAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  /** Assert an adapter exists, or raise a stable channel error. */
  require(id: string): ChannelAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new ChannelError('CHANNEL_ERROR', `adapter '${id}' is not registered`);
    }
    return adapter;
  }
}
