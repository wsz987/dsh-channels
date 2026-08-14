/**
 * Dedup identity for inbound iLink messages.
 *
 * Priority: `message_id` (first-class) -> `seq` -> stable hash of the raw
 * payload. We NEVER primarily key on sender+content, so two identical `你好`
 * messages must not collide. The window covers at least the cursor
 * crash-replay window so a re-fetch after an uncommitted cursor is dropped.
 */
import type { ILinkMessage } from '../ilink/types.js';

/** Optional injectable clock for window pruning. */
export interface DedupOptions {
  /** Dedup window in ms. */
  windowMs: number;
  /** Injectable clock (tests). */
  now?: () => number;
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
    return `mid:${String(msg.message_id)}`;
  }
  if (msg?.seq !== undefined && msg.seq !== null) {
    return `seq:${String(msg.seq)}`;
  }
  // Final fallback — stable hash of the JSON shape. Two identical text
  // messages still get distinct ids because the platform assigns seq/message_id.
  return `hash:${stableHash(JSON.stringify(msg ?? {}))}`;
}

/**
 * A time-bounded dedup set. Uses an LRU-ish map keyed by dedup identity with a
 * per-key timestamp; entries older than `windowMs` are treated as not-seen and
 * pruned lazily.
 */
export class DedupWindow {
  private readonly seen = new Map<string, number>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: DedupOptions) {
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record an identity and return `true` when it should be forwarded
   * (i.e. it was not seen within the window). Returns `false` for a duplicate.
   */
  check(key: string): boolean {
    const now = this.now();
    this.prune(now);
    const last = this.seen.get(key);
    if (last !== undefined && now - last < this.windowMs) {
      return false;
    }
    this.seen.set(key, now);
    return true;
  }

  private prune(now: number): void {
    for (const [key, ts] of this.seen) {
      if (now - ts >= this.windowMs) this.seen.delete(key);
    }
  }
}
