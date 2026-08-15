/**
 * Classification: A — DSH glue [keep].
 *
 * Two-phase inbound dedup (message_id/seq/hash) + durable store + stable hash.
 * DSH-specific receive reliability, not a platform protocol. Keep.
 */
/**
 * Dedup identity for inbound iLink messages.
 *
 * Priority: message_id (first-class) -> seq -> stable hash of the raw payload.
 * We NEVER primarily key on sender+content, so two identical 'hello' messages
 * must not collide.
 *
 * The dedup store is TWO-PHASE (R1): a message only becomes a committed dedup
 * entry AFTER it has successfully entered the Channel pipeline (emit resolved).
 * This way a failed emit is replayed on the next round instead of being
 * dropped, while a crash after emit but before cursor commit is still dropped
 * on replay (no duplicate Agent trigger).
 */
import type { ChannelStorage } from '@wsz987/channel-core';
import type { ILinkMessage } from '../ilink/types.js';

/** Optional injectable clock for window pruning. */
export interface DedupOptions {
  /** Dedup window in ms. */
  windowMs: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** A committed dedup entry. */
export interface DedupRecord {
  key: string;
  committedAt: number;
}

/**
 * Stable hash (FNV-1a-ish) used as the final fallback for a missing
 * message_id/seq. Never the primary identity.
 */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Compute a dedup identity for a raw iLink message. */
export function dedupKey(raw: unknown): string {
  const msg = raw as ILinkMessage;
  if (msg?.message_id !== undefined && msg.message_id !== null) {
    return 'mid:' + String(msg.message_id);
  }
  if (msg?.seq !== undefined && msg.seq !== null) {
    return 'seq:' + String(msg.seq);
  }
  // Final fallback — stable hash of the JSON shape.
  return 'hash:' + stableHash(JSON.stringify(msg ?? {}));
}

/**
 * Two-phase dedup boundary (R1). has() answers "already committed?" without
 * recording anything; commit() records AFTER the caller has successfully
 * processed the message.
 */
export interface DedupStore {
  /** Whether the key was committed within the window. */
  has(key: string): Promise<boolean>;
  /** Persist the key as processed. */
  commit(key: string): Promise<void>;
}

/** Default cap on persistent dedup records (R1 recommends 1000..5000). */
const MAX_RECORDS = 5000;

/** In-memory two-phase dedup (tests / no persistence). */
export class MemoryDedupStore implements DedupStore {
  private readonly seen = new Map<string, number>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: DedupOptions) {
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
  }

  async has(key: string): Promise<boolean> {
    this.prune(this.now());
    const last = this.seen.get(key);
    return last !== undefined && this.now() - last < this.windowMs;
  }

  async commit(key: string): Promise<void> {
    const now = this.now();
    this.prune(now);
    this.seen.set(key, now);
  }

  private prune(now: number): void {
    for (const [key, ts] of this.seen) {
      if (now - ts >= this.windowMs) this.seen.delete(key);
    }
  }
}

export interface PersistentDedupStoreOptions extends DedupOptions {
  storage: ChannelStorage;
  /** Local DSH account alias; defaults to 'main'. */
  accountId?: string;
  /** Max entries persisted (defaults to 5000). */
  maxRecords?: number;
}

/**
 * Durable two-phase dedup store. Committed records survive a restart so a
 * cursor crash-replay window never re-triggers the Agent. State is a JSON
 * array of DedupRecord under weixin:dedup:<accountId>, loaded lazily and
 * rewritten (pruned + capped) on each commit.
 */
export class PersistentDedupStore implements DedupStore {
  private readonly storage: ChannelStorage;
  private readonly key: string;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly maxRecords: number;
  private records?: Map<string, number>;

  constructor(options: PersistentDedupStoreOptions) {
    this.storage = options.storage;
    this.key = 'weixin:dedup:' + (options.accountId ?? 'main');
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
    this.maxRecords = options.maxRecords ?? MAX_RECORDS;
  }

  private async load(): Promise<Map<string, number>> {
    if (this.records) return this.records;
    const map = new Map<string, number>();
    const raw = await this.storage.get(this.key);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as DedupRecord[];
        for (const rec of parsed) {
          if (rec && typeof rec.key === 'string' && typeof rec.committedAt === 'number') {
            map.set(rec.key, rec.committedAt);
          }
        }
      } catch {
        // Corrupt dedup window -> start fresh (worst case: a replay re-emits,
        // which is safer than dropping messages forever).
      }
    }
    this.records = map;
    return map;
  }

  private async persist(): Promise<void> {
    const records = this.records ?? new Map<string, number>();
    const now = this.now();
    const kept: DedupRecord[] = [];
    for (const [key, ts] of records) {
      if (now - ts >= this.windowMs) continue;
      kept.push({ key, committedAt: ts });
    }
    kept.sort((a, b) => b.committedAt - a.committedAt);
    const capped = kept.slice(0, this.maxRecords);
    await this.storage.set(this.key, JSON.stringify(capped));
    this.records = new Map(capped.map((r) => [r.key, r.committedAt]));
  }

  async has(key: string): Promise<boolean> {
    const map = await this.load();
    const last = map.get(key);
    if (last === undefined) return false;
    return this.now() - last < this.windowMs;
  }

  async commit(key: string): Promise<void> {
    const map = await this.load();
    map.set(key, this.now());
    await this.persist();
  }
}