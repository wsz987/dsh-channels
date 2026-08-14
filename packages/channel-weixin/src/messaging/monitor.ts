/**
 * WeixinMonitor — the getUpdates loop (doc §16-18).
 *
 * Flow per round:
 *   load cursor -> getUpdates(cursor, timeout, signal)
 *     -> for each msg: capture context_token, dedup, map, emit message.received
 *     -> THEN commit the new cursor
 *
 * The next long-poll timeout is dynamically updated from the server's
 * `longpolling_timeout_ms`. Reconnect uses exponential backoff per the
 * reconnect config. On AbortSignal it exits cleanly. Notify lifecycle
 * (notifystart/notifystop) is best-effort.
 */
import type { ChannelAdapterContext, ChannelId } from '@dsh/channel-core';
import type { ILinkClient } from '../ilink/client.js';
import type { ILinkMessage, WeixinInboundMeta } from '../ilink/types.js';
import type { SyncCursorStore } from '../storage/sync-cursor.js';
import type { ContextTokenStore } from '../storage/context-token.js';
import { DedupWindow, dedupKey } from './dedup.js';
import { mapInbound } from './mapper.js';

export interface MonitorReconnectConfig {
  enabled: boolean;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface WeixinMonitorOptions {
  client: ILinkClient;
  cursor: SyncCursorStore;
  contextTokens: ContextTokenStore;
  ctx: ChannelAdapterContext;
  meta: WeixinInboundMeta;
  /** Dispatch an inbound message event into the pipeline. Injectable for tests. */
  emit?: (event: ReturnType<typeof mapInbound>) => Promise<void>;
  reconnect: MonitorReconnectConfig;
  /** Initial long-poll timeout. */
  longPollTimeoutMs: number;
  /** Dedup window in ms. */
  dedupWindowMs: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Called on health/connection transitions. */
  onConnectionChange?: (state: 'connected' | 'reconnecting' | 'disconnected') => void;
}

export class WeixinMonitor {
  private readonly client: ILinkClient;
  private readonly cursor: SyncCursorStore;
  private readonly contextTokens: ContextTokenStore;
  private readonly ctx: ChannelAdapterContext;
  private readonly meta: WeixinInboundMeta;
  private readonly emitMsg: (event: ReturnType<typeof mapInbound>) => Promise<void>;
  private readonly reconnect: MonitorReconnectConfig;
  private readonly dedup: DedupWindow;
  private readonly now: () => number;
  private readonly onConnectionChange?: (state: 'connected' | 'reconnecting' | 'disconnected') => void;

  private running = false;
  private loop?: Promise<void>;
  private nextLongPollTimeoutMs: number;

  constructor(options: WeixinMonitorOptions) {
    this.client = options.client;
    this.cursor = options.cursor;
    this.contextTokens = options.contextTokens;
    this.ctx = options.ctx;
    this.meta = options.meta;
    this.emitMsg = options.emit ?? ((event) => this.ctx.emit(event));
    this.reconnect = options.reconnect;
    this.dedup = new DedupWindow({ windowMs: options.dedupWindowMs, now: options.now ?? Date.now });
    this.now = options.now ?? Date.now;
    this.onConnectionChange = options.onConnectionChange;
    this.nextLongPollTimeoutMs = options.longPollTimeoutMs;
  }

  /** Start the monitor loop. Best-effort notifystart first. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.client.notifyStart();
    } catch {
      // best effort
    }
    this.loop = this.runLoop(this.ctx.signal);
  }

  /** Abort the loop and best-effort notifystop. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    try {
      await this.client.notifyStop();
    } catch {
      // best effort
    }
  }

  /** Wait for the current loop iteration to finish (used by tests/teardown). */
  async join(): Promise<void> {
    if (this.loop) await this.loop.catch(() => undefined);
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    let attempt = 0;
    let cursor = await this.cursor.load().catch(() => '');
    this.onConnectionChange?.('connected');

    while (this.running && !signal.aborted) {
      try {
        const result = await this.client.getUpdates({
          getUpdatesBuf: cursor,
          longPollTimeoutMs: this.nextLongPollTimeoutMs,
          signal,
        });
        if (this.nextLongPollTimeoutMs !== undefined) {
          const t = result.nextLongPollTimeoutMs;
          if (typeof t === 'number' && t > 0) {
            this.nextLongPollTimeoutMs = t;
          }
        }
        attempt = 0;
        this.onConnectionChange?.('connected');

        // Process each message; then commit the cursor AFTER the round.
        if (result.msgs && result.msgs.length > 0) {
          for (const msg of result.msgs) {
            if (signal.aborted) break;
            await this.handleMessage(msg);
          }
          // Persist only after the inbound round is processed (§18).
          if (result.get_updates_buf !== undefined) {
            cursor = result.get_updates_buf;
            await this.cursor.set(result.get_updates_buf).catch((e) => {
              this.ctx.logger.error('[channel-weixin] failed to commit sync cursor', e);
            });
          }
        }
        // A client-side long-poll timeout is normal control flow; retry.
      } catch (error) {
        if (signal.aborted || !this.running) break;
        this.onConnectionChange?.('reconnecting');
        attempt += 1;
        if (!this.reconnect.enabled) break;
        const delay = Math.min(
          this.reconnect.baseDelayMs * 2 ** Math.min(attempt - 1, 8),
          this.reconnect.maxDelayMs,
        );
        this.ctx.logger.warn(`[channel-weixin] getUpdates error; retry in ${delay}ms`, error);
        await sleep(delay, signal);
      }
    }

    this.onConnectionChange?.('disconnected');
  }

  private async handleMessage(msg: ILinkMessage): Promise<void> {
    const key = dedupKey(msg);
    if (!this.dedup.check(key)) {
      this.ctx.logger.debug(`[channel-weixin] dropped duplicate message '${key}'`);
      return;
    }
    if (msg.context_token && msg.from_user_id) {
      await this.contextTokens.set(msg.from_user_id, msg.context_token);
    }
    const event = mapInbound(msg, this.meta);
    await this.emitMsg(event);
  }

  /** Current long-poll timeout (dynamic). */
  get longPollTimeout(): number {
    return this.nextLongPollTimeoutMs;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
