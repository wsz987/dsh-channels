/**
 * Secret store handed to adapters.
 *
 * Adapters never receive credentials from plugin config in plaintext logs;
 * they resolve them through this interface. The default in-memory
 * implementation keeps values out of logs and debug dumps.
 */

export interface SecretStore {
  /** Read a secret by name; resolves `undefined` when absent. */
  get(name: string): Promise<string | undefined>;
  /** Store (or replace) a secret by name. */
  set(name: string, value: string): Promise<void>;
  /** Remove a secret by name. */
  delete(name: string): Promise<void>;
}

export interface MemorySecretStoreOptions {
  /** Initial secrets; names are lower-cased for lookup. */
  initial?: Record<string, string>;
}

/** Default in-memory secret store used when an adapter config provides none. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  constructor(options: MemorySecretStoreOptions = {}) {
    if (options.initial) {
      for (const [name, value] of Object.entries(options.initial)) {
        this.values.set(name.toLowerCase(), value);
      }
    }
  }

  async get(name: string): Promise<string | undefined> {
    return this.values.get(name.toLowerCase());
  }

  async set(name: string, value: string): Promise<void> {
    this.values.set(name.toLowerCase(), value);
  }

  async delete(name: string): Promise<void> {
    this.values.delete(name.toLowerCase());
  }
}
