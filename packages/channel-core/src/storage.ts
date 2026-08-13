/**
 * Small key/value storage handed to adapters for durable channel state
 * (e.g. cursor positions, dedup windows). The Harness bridge keeps its own
 * session-binding storage — adapters never touch that.
 */

export interface ChannelStorage {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Default in-memory storage (lost on restart). Adapters may provide a durable one. */
export class MemoryStorage implements ChannelStorage {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}
