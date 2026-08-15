/**
 * Session binding persistence (doc H0.3 / §32).
 *
 * Adapters never touch this store; only the bridge does. The store carries a
 * schema version (`SessionBinding.schemaVersion: 2`) and performs a one-time
 * migration on load: a v1 entry (no `schemaVersion`, has `agentId`) is
 * converted to v2 by mapping `agentId` -> `route: { model: agentId }` (v1
 * used the agent id as the model), stamping `schemaVersion: 2`, and logging
 * a migration notice. Old fields are NEVER silently reinterpreted as the new
 * semantics.
 *
 * `FileBindingStore` is the default (persists a plain JSON file, written
 * atomically via a temp file + rename and read once into a cache map) and
 * persists the migrated file after a load-time migration. `MemoryBindingStore`
 * is opt-in for non-persistent deployments and applies the same migration on
 * get/put.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveDefaultBindingStorePath } from './dsh-home.js';
import { bindingKey, SESSION_BINDING_SCHEMA_VERSION, type SessionBinding } from './session-router.js';

export interface SessionBindingStore {
  get(key: string): Promise<SessionBinding | undefined>;
  put(binding: SessionBinding): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The v1 binding shape that must be migrated (never used as-is). */
export interface SessionBindingV1 {
  channelId: string;
  accountId: string;
  conversationId: string;
  threadId?: string;
  agentId?: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
}

/** Whether a raw stored value is a v1 binding needing migration. */
export function isV1Binding(value: unknown): value is SessionBindingV1 {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === undefined &&
    typeof record.agentId === 'string' &&
    typeof record.sessionId === 'string'
  );
}

/**
 * Normalize any stored binding into the current v2 shape. A v1 entry is
 * migrated (`route: { model: agentId }`) and its `agentId` is dropped; every
 * migrated entry is stamped `schemaVersion: 2`. Already-v2 values are returned
 * unchanged. The migration NEVER reinterprets `agentId` as the new identity.
 */
export function migrateBinding(value: unknown): SessionBinding {
  if (isV1Binding(value)) {
    const v1: SessionBindingV1 = value;
    const migrated: SessionBinding = {
      channelId: v1.channelId,
      accountId: v1.accountId,
      conversationId: v1.conversationId,
      ...(typeof v1.threadId === 'string' ? { threadId: v1.threadId } : {}),
      sessionId: v1.sessionId,
      // v1 used agentId as the model — preserve that meaning explicitly.
      route: { model: v1.agentId },
      schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
      createdAt: v1.createdAt,
      updatedAt: v1.updatedAt,
    };
    return migrated;
  }
  return value as SessionBinding;
}

function migratedNotice(sessionId: string): void {
  // Overriding console is intentional: no logger is injected and the migration
  // must be visible (doc H0.3: "log a migration notice").
  // eslint-disable-next-line no-console
  console.error(
    `[channel-harness] binding for session '${sessionId}' migrated from v1 (agentId) to v2 (route.model)`,
  );
}

export class MemoryBindingStore implements SessionBindingStore {
  private readonly store = new Map<string, SessionBinding>();

  get(key: string): Promise<SessionBinding | undefined> {
    const raw = this.store.get(key);
    if (!raw) return Promise.resolve(undefined);
    if (isV1Binding(raw)) {
      const migrated = migrateBinding(raw);
      migratedNotice(migrated.sessionId);
      this.store.set(key, migrated);
      return Promise.resolve(migrated);
    }
    return Promise.resolve(raw);
  }

  async put(binding: SessionBinding): Promise<void> {
    this.store.set(bindingKey(binding), migrateBinding(binding));
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/**
 * Single-file JSON binding store. Loads once into memory; writes are
 * serialized through a promise chain and land atomically (temp + rename).
 * On load, any v1 entries are migrated to v2 (in memory) and the migrated
 * file is re-persisted immediately.
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
    let migratedAny = false;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (value && typeof value === 'object') {
            const migrated = migrateBinding(value);
            this.cache.set(key, migrated);
            if (isV1Binding(value)) {
              migratedAny = true;
              migratedNotice(key);
            }
          }
        }
      }
    } catch {
      // Corrupt file — start fresh; the single-file store has no better recovery.
    }
    // Persist the migrated file so a later load does not re-run migration.
    if (migratedAny) {
      await this.persist();
    }
  }

  async get(key: string): Promise<SessionBinding | undefined> {
    await this.load();
    const value = this.cache.get(key);
    if (value && isV1Binding(value)) {
      const migrated = migrateBinding(value);
      migratedNotice(migrated.sessionId);
      this.cache.set(key, migrated);
      await this.persist();
      return migrated;
    }
    return value;
  }

  async put(binding: SessionBinding): Promise<void> {
    await this.load();
    this.cache.set(bindingKey(binding), migrateBinding(binding));
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

/** Build the store selected by configuration (file without a path falls back to the default). */
export function createBindingStore(config: {
  type: 'memory' | 'file';
  path?: string;
}): SessionBindingStore {
  if (config.type === 'file') {
    return new FileBindingStore(config.path ?? resolveDefaultBindingStorePath());
  }
  return new MemoryBindingStore();
}
