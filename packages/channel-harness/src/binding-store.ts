/**
 * Session binding persistence (doc H0.3 / §32).
 *
 * Adapters never touch this store; only the bridge does. The store carries a
 * schema version (`SessionBinding.schemaVersion: 3`) and performs a one-time
 * migration on load:
 *
 * - a v1 entry (no `schemaVersion`, has `agentId`) is converted to v2 by
 *   mapping `agentId` -> `route: { model: agentId }`, then chained to v3;
 * - a v2 entry (has `route` + `sessionId`, no `conversationType`) is converted
 *   to v3 by adding the documented legacy default `conversationType: 'dm'`
 *   (v2 did not model group vs dm) and leaving `senderId` unset, then stamped
 *   `schemaVersion: 3` and logged. Bindings without the later optional
 *   `durability` policy are treated as durable by the bridge (fail closed).
 *
 * Old fields are NEVER silently reinterpreted as the new semantics: `agentId`
 * is explicitly carried into `route.model` (never onto the identity), and a v2
 * binding is only ever promoted from an entry that truly lacks a
 * `conversationType`.
 *
 * `FileBindingStore` is the default (persists a plain JSON file, written
 * atomically via a temp file + rename and read once into a cache map) and
 * persists the migrated file after a load-time migration. `MemoryBindingStore`
 * is opt-in for non-persistent deployments and applies the same migration on
 * get/put.
 *
 * §59: both stores expose `findBySessionId` so a durable channel can resolve
 * the "WHERE does a reply to session S go" question from the binding
 * authority. When more than one CURRENT binding maps to the same session, they
 * fail CLOSED with `AmbiguousBindingError` (code `OUTBOX_AMBIGUOUS_BINDING`)
 * instead of guessing.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { resolveDefaultBindingStorePath } from './dsh-home.js';
import { bindingKey, SESSION_BINDING_SCHEMA_VERSION, type SessionBinding } from './session-router.js';
import type { AgentRouteSpec } from './agent-router.js';

export interface SessionBindingStore {
  get(key: string): Promise<SessionBinding | undefined>;
  put(binding: SessionBinding): Promise<void>;
  delete(key: string): Promise<void>;
  /** Resolve the single current binding for a session id (plan §59). */
  findBySessionId(sessionId: string): Promise<SessionBinding | undefined>;
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

/** The v2 binding shape that must be promoted to v3 (never used as-is). */
export interface SessionBindingV2 {
  channelId: string;
  accountId: string;
  conversationId: string;
  threadId?: string;
  sessionId: string;
  route: AgentRouteSpec;
  createdAt: number;
  updatedAt: number;
}

/**
 * Raised by `findBySessionId` when one session id maps to more than one
 * CURRENT binding (plan §59). The durable binding authority fails closed
 * rather than guessing which conversation "owns" the session.
 */
export class AmbiguousBindingError extends Error {
  static readonly code = 'OUTBOX_AMBIGUOUS_BINDING' as const;
  readonly code = AmbiguousBindingError.code;
  readonly sessionId: string;
  readonly bindingCount: number;
  constructor(sessionId: string, bindingCount: number) {
    super("session '" + sessionId + "' maps to " + bindingCount
      + " current channel bindings; expected exactly one (OUTBOX_AMBIGUOUS_BINDING)");
    this.name = 'AmbiguousBindingError';
    this.sessionId = sessionId;
    this.bindingCount = bindingCount;
  }
}

/**
 * Structural v1 shape used to detect a legacy stored binding: it carries
 * `agentId` + `sessionId`, and `schemaVersion` is absent (or explicitly
 * undefined). A v2/v3 entry fails this schema, so it is never misread as v1.
 */
const V1_BINDING_SCHEMA = z.object({
  channelId: z.string(),
  accountId: z.string(),
  conversationId: z.string(),
  threadId: z.string().optional(),
  agentId: z.string(),
  sessionId: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  schemaVersion: z.undefined().optional(),
}).loose();

/** Whether a raw stored value is a v1 binding needing migration. */
export function isV1Binding(value: unknown): value is SessionBindingV1 {
  return V1_BINDING_SCHEMA.safeParse(value).success;
}

// Reused record guard (zod/TS-safe).
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a raw stored value is a v2 binding needing promotion to v3: a
 * current binding carrying `route` + `sessionId` but NO `conversationType`
 * (v2 never modeled group vs dm). A v3 entry always has `conversationType`,
 * so it is never misread as v2.
 */
export function isV2Binding(value: unknown): value is SessionBindingV2 {
  if (!isRecord(value) || isV1Binding(value)) return false;
  if (value.conversationType !== undefined) return false;
  if (typeof value.sessionId !== 'string') return false;
  if (!isRecord(value.route)) return false;
  return typeof value.channelId === 'string' && typeof value.accountId === 'string'
    && typeof value.conversationId === 'string';
}

/**
 * Normalize any stored binding into the current v3 shape.
 *
 * - v1 -> migrate to v2 (`route: { model: agentId }`, drop `agentId`), then
 *   chain into v3;
 * - v2 -> promote to v3 with the documented legacy default
 *   `conversationType: 'dm'` and no `senderId`.
 *
 * Already-v3 values are returned unchanged (same reference). Migration NEVER
 * reinterprets `agentId` as the new identity, and never fabricates a
 * conversation type for an entry that already carries one.
 */
export function migrateBinding(value: unknown): SessionBinding {
  if (isV1Binding(value)) {
    const v1: SessionBindingV1 = value;
    // v1 only knew an agent id, used as the model — carry that meaning forward.
    const v2: SessionBindingV2 = {
      channelId: v1.channelId,
      accountId: v1.accountId,
      conversationId: v1.conversationId,
      ...(typeof v1.threadId === 'string' ? { threadId: v1.threadId } : {}),
      sessionId: v1.sessionId,
      route: { model: v1.agentId },
      createdAt: v1.createdAt,
      updatedAt: v1.updatedAt,
    };
    return promoteV2ToV3(v2);
  }
  if (isV2Binding(value)) {
    return promoteV2ToV3(value);
  }
  return value as SessionBinding;
}

/** v2 -> v3: add the legacy-default dm conversation type (plan §55/§56). */
function promoteV2ToV3(v2: SessionBindingV2): SessionBinding {
  const migrated: SessionBinding = {
    channelId: v2.channelId,
    accountId: v2.accountId,
    conversationId: v2.conversationId,
    // Legacy default: v2 did not model dm vs group, so a promoted entry is a
    // DM unless the caller later upgrades it. Documented in the plan.
    conversationType: 'dm',
    ...(typeof v2.threadId === 'string' ? { threadId: v2.threadId } : {}),
    sessionId: v2.sessionId,
    route: v2.route,
    schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
    createdAt: v2.createdAt,
    updatedAt: v2.updatedAt,
  };
  return migrated;
}

function migratedNotice(sessionId: string, from: 'v1' | 'v2'): void {
  const origin = from === 'v1' ? 'v1 (agentId) -> v2 (route.model) -> v3' : 'v2 -> v3 (dm default)';
  // Overriding console is intentional: no logger is injected and the migration
  // must be visible (doc H0.3: "log a migration notice").
  // eslint-disable-next-line no-console
  console.error("[channel-harness] binding for session '" + sessionId + "' migrated from " + origin);
}

export class MemoryBindingStore implements SessionBindingStore {
  private readonly store = new Map<string, SessionBinding>();
  /** sessionId -> bindable key index (plan §59). */
  private readonly bySession = new Map<string, string>();

  get(key: string): Promise<SessionBinding | undefined> {
    const raw = this.store.get(key);
    if (!raw) return Promise.resolve(undefined);
    const migrated = migrateBinding(raw);
    if (migrated !== raw) {
      migratedNotice(migrated.sessionId, isV1Binding(raw) ? 'v1' : 'v2');
      this.index(migrated);
      this.store.set(key, migrated);
    }
    return Promise.resolve(migrated);
  }

  async put(binding: SessionBinding): Promise<void> {
    const key = bindingKey(binding);
    const value = migrateBinding(binding);
    // If this key previously held a DIFFERENT session's binding, drop that
    // session's stale reverse mapping before re-pointing it.
    const prev = this.store.get(key);
    if (prev && prev.sessionId !== value.sessionId && this.bySession.get(prev.sessionId) === key) {
      this.bySession.delete(prev.sessionId);
    }
    this.bySession.set(value.sessionId, key);
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    const binding = this.store.get(key);
    if (binding && this.bySession.get(binding.sessionId) === key) {
      this.bySession.delete(binding.sessionId);
    }
    this.store.delete(key);
  }

  async findBySessionId(sessionId: string): Promise<SessionBinding | undefined> {
    const keys = new Set<string>();
    if (this.bySession.has(sessionId)) {
      const k = this.bySession.get(sessionId)!;
      if (this.store.has(k)) keys.add(k);
    }
    for (const [key, binding] of this.store) {
      if (binding.sessionId === sessionId) keys.add(key);
    }
    if (keys.size === 0) return undefined;
    if (keys.size > 1) throw new AmbiguousBindingError(sessionId, keys.size);
    const key = Array.from(keys)[0]!;
    const raw = this.store.get(key)!;
    const migrated = migrateBinding(raw);
    if (migrated !== raw) {
      migratedNotice(migrated.sessionId, isV1Binding(raw) ? 'v1' : 'v2');
      this.bySession.set(migrated.sessionId, bindingKey(migrated));
      this.store.set(key, migrated);
    }
    return migrated;
  }

  private index(binding: SessionBinding): void {
    this.bySession.set(binding.sessionId, bindingKey(binding));
  }
}

/**
 * Single-file JSON binding store. Loads once into memory; writes are
 * serialized through a promise chain and land atomically (temp + rename).
 * On load, any v1/v2 entries are migrated to v3 (in memory) and the migrated
 * file is re-persisted immediately. A `sessionId -> key` index is built
 * alongside the cache for `findBySessionId`.
 */
export class FileBindingStore implements SessionBindingStore {
  private readonly cache = new Map<string, SessionBinding>();
  /** sessionId -> bindable key index (plan §59). */
  private readonly bySession = new Map<string, string>();
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private index(key: string, binding: SessionBinding): void {
    this.cache.set(key, binding);
    this.bySession.set(binding.sessionId, key);
  }

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
            this.index(key, migrated);
            if (migrated !== value) {
              migratedAny = true;
              migratedNotice(migrated.sessionId, isV1Binding(value) ? 'v1' : 'v2');
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
    const raw = this.cache.get(key);
    if (!raw) return undefined;
    const migrated = migrateBinding(raw);
    if (migrated !== raw) {
      migratedNotice(migrated.sessionId, isV1Binding(raw) ? 'v1' : 'v2');
      this.index(key, migrated);
      await this.persist();
    }
    return migrated;
  }

  async put(binding: SessionBinding): Promise<void> {
    await this.load();
    const key = bindingKey(binding);
    const value = migrateBinding(binding);
    const prev = this.cache.get(key);
    if (prev && prev.sessionId !== value.sessionId && this.bySession.get(prev.sessionId) === key) {
      this.bySession.delete(prev.sessionId);
    }
    this.index(key, value);
    await this.persist();
  }

  async delete(key: string): Promise<void> {
    await this.load();
    const binding = this.cache.get(key);
    if (binding && this.bySession.get(binding.sessionId) === key) {
      this.bySession.delete(binding.sessionId);
    }
    if (this.cache.delete(key)) {
      await this.persist();
    }
  }

  async findBySessionId(sessionId: string): Promise<SessionBinding | undefined> {
    await this.load();
    const keys = new Set<string>();
    if (this.bySession.has(sessionId)) {
      const k = this.bySession.get(sessionId)!;
      if (this.cache.has(k)) keys.add(k);
    }
    for (const [key, binding] of this.cache) {
      if (binding.sessionId === sessionId) keys.add(key);
    }
    if (keys.size === 0) return undefined;
    if (keys.size > 1) throw new AmbiguousBindingError(sessionId, keys.size);
    const key = Array.from(keys)[0]!;
    const raw = this.cache.get(key)!;
    const migrated = migrateBinding(raw);
    if (migrated !== raw) {
      migratedNotice(migrated.sessionId, isV1Binding(raw) ? 'v1' : 'v2');
      this.index(key, migrated);
      await this.persist();
    }
    return migrated;
  }

  private persist(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
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
