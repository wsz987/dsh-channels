import { z } from 'zod';

const getConfigResponseSchema = z.object({
  typing_ticket: z.string().trim().min(1).max(4096).optional(),
}).passthrough();

export interface WeixinConfigManagerOptions {
  /** Fetches peer config from iLink. The response is untrusted. */
  fetchConfig(peer: string): Promise<unknown>;
  /** Injectable clock and entropy source for deterministic tests. */
  now?: () => number;
  rand?: () => number;
  /** Defaults match Tencent's bounded refresh/backoff policy. */
  minRefreshMs?: number;
  refreshJitterMs?: number;
  initialRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

interface CachedPeerConfig {
  typingTicket?: string;
  nextFetchAt: number;
  retryDelayMs: number;
  everSucceeded: boolean;
}

const DEFAULT_MIN_REFRESH_MS = 12 * 60 * 60 * 1000;
const DEFAULT_REFRESH_JITTER_MS = 12 * 60 * 60 * 1000;
const DEFAULT_INITIAL_RETRY_DELAY_MS = 2_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

/**
 * Per-peer iLink config cache. Typing remains best-effort: it uses a prior
 * ticket during a failed refresh and retries unavailable config with backoff.
 */
export class WeixinConfigManager {
  private readonly fetchConfig: (peer: string) => Promise<unknown>;
  private readonly now: () => number;
  private readonly rand: () => number;
  private readonly minRefreshMs: number;
  private readonly refreshJitterMs: number;
  private readonly initialRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly cache = new Map<string, CachedPeerConfig>();
  private readonly pending = new Map<string, Promise<string | undefined>>();

  constructor(options: WeixinConfigManagerOptions) {
    this.fetchConfig = options.fetchConfig;
    this.now = options.now ?? Date.now;
    this.rand = options.rand ?? Math.random;
    this.minRefreshMs = options.minRefreshMs ?? DEFAULT_MIN_REFRESH_MS;
    this.refreshJitterMs = options.refreshJitterMs ?? DEFAULT_REFRESH_JITTER_MS;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? DEFAULT_INITIAL_RETRY_DELAY_MS;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  }

  /** Resolve a valid ticket, preserving a prior ticket while a refresh backs off. */
  async resolveTypingTicket(peer: string | undefined): Promise<string | undefined> {
    const normalizedPeer = peer?.trim();
    if (!normalizedPeer) return undefined;

    const current = this.cache.get(normalizedPeer);
    if (current && this.now() < current.nextFetchAt) return current.typingTicket;

    const existing = this.pending.get(normalizedPeer);
    if (existing) return existing;

    const request = this.refresh(normalizedPeer, current).finally(() => {
      this.pending.delete(normalizedPeer);
    });
    this.pending.set(normalizedPeer, request);
    return request;
  }

  /** Clear one peer or all entries after a credential or base URL transition. */
  clear(peer?: string): void {
    const normalizedPeer = peer?.trim();
    if (normalizedPeer) {
      this.cache.delete(normalizedPeer);
      this.pending.delete(normalizedPeer);
      return;
    }
    this.cache.clear();
    this.pending.clear();
  }

  private async refresh(peer: string, prior?: CachedPeerConfig): Promise<string | undefined> {
    const now = this.now();
    try {
      const parsed = getConfigResponseSchema.safeParse(await this.fetchConfig(peer));
      if (!parsed.success || !parsed.data.typing_ticket) throw new Error('typing ticket unavailable');

      const typingTicket = parsed.data.typing_ticket;
      this.cache.set(peer, {
        typingTicket,
        nextFetchAt: now + this.nextRefreshDelay(),
        retryDelayMs: this.initialRetryDelayMs,
        everSucceeded: true,
      });
      return typingTicket;
    } catch {
      const retryDelayMs = Math.min(
        prior?.retryDelayMs ?? this.initialRetryDelayMs,
        this.maxRetryDelayMs,
      );
      this.cache.set(peer, {
        typingTicket: prior?.typingTicket,
        nextFetchAt: now + retryDelayMs,
        retryDelayMs: Math.min(retryDelayMs * 2, this.maxRetryDelayMs),
        everSucceeded: prior?.everSucceeded ?? false,
      });
      return prior?.typingTicket;
    }
  }

  private nextRefreshDelay(): number {
    const boundedRandom = Math.min(1, Math.max(0, this.rand()));
    return this.minRefreshMs + Math.floor(this.refreshJitterMs * boundedRandom);
  }
}
