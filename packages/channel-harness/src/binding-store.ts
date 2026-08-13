/**
 * Session binding persistence.
 *
 * Adapters never touch this store; only the bridge does (architecture §18).
 * `MemoryBindingStore` is the default; `FileBindingStore` persists a plain
 * JSON file, written atomically via a temp file + rename and read once into a
 * cache map.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { bindingKey, type SessionBinding } from './session-router.js';

export interface SessionBindingStore {
  get(key: string): Promise<SessionBinding | undefined>;
  put(binding: SessionBinding): Promise<void>;
  delete(key: string): Promise<void>;
}

export class MemoryBindingStore implements SessionBindingStore {
  private readonly store = new Map<string, SessionBinding>();

  get(key: string): Promise<SessionBinding | undefined> {
    return Promise.resolve(this.store.get(key));
  }

  async put(binding: SessionBinding): Promise<void> {
    this.store.set(bindingKey(binding), binding);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/**
 * Single-file JSON binding store. Loads once into memory; writes are
 * serialized through a promise chain and land atomically (temp + rename).
 */
export class FileBindingStore implements SessionBindingStore {
  private readonly cache = new Map<string, SessionBinding>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch {
      // No file yet — empty store.
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (value && typeof value === 'object') {
            this.cache.set(key, value as SessionBinding);
          }
        }
      }
    } catch {
      // Corrupt file — start fresh; the single-file store has no better recovery.
    }
  }

  async get(key: string): Promise<SessionBinding | undefined> {
    await this.load();
    return this.cache.get(key);
  }

  async put(binding: SessionBinding): Promise<void> {
    await this.load();
    this.cache.set(bindingKey(binding), binding);
    await this.persist();
  }

  async delete(key: string): Promise<void> {
    await this.load();
    if (this.cache.delete(key)) {
      await this.persist();
    }
  }

  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries(this.cache), null, 2), 'utf8');
      await rename(tmp, this.filePath);
    });
    return this.writeChain;
  }
}

/** Build the store selected by configuration (file requires a path). */
export function createBindingStore(config: {
  type: 'memory' | 'file';
  path?: string;
}): SessionBindingStore {
  if (config.type === 'file' && config.path) {
    return new FileBindingStore(config.path);
  }
  return new MemoryBindingStore();
}
