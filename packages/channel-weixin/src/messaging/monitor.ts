/**
 * Classification: A — DSH glue getUpdates loop [keep].
 *
 * DSH's receive loop (cursor + dedup + context-token capture + dispatch). The
 * official monitor (monitor/monitor.js) is coupled to the OpenClaw channel
 * lifecycle (PluginRuntime) and is not reusable host-neutrally. This loop is
 * DSH orchestration, not a duplicated wire protocol. Keep; driven by
 * upstream/tencent-upstream.ts startMonitor().
 */
/**
 * WeixinMonitor — the getUpdates loop (doc §16-18).
 *
 * Flow per round:
 *   load cursor -> getUpdates(cursor, timeout, signal)
 *     -> for each msg: dedup.has -> capture context_token -> map -> emit -> dedup.commit
 *     -> THEN commit the new cursor
 *
 * R1 ordering guarantees:
 *   - a message becomes a committed dedup entry ONLY after a successful emit,
 *     so an emit failure replays it next round instead of dropping it forever;
 *   - the cursor is persisted only after the whole round succeeded, and a
 *     failed cursor write throws (CursorCommitError) so the loop retries
 *     instead of diverging the in-memory cursor from the durable one.
 *
 * The next long-poll timeout is dynamically updated from the server's
 * longpolling_timeout_ms. Reconnect uses exponential backoff per the
 * reconnect config. On AbortSignal it exits cleanly. Notify lifecycle
 * (notifystart/notifystop) is best-effort.
 */
import type { ChannelAdapterContext, MessagePart } from '@wsz987/channel-core';
import type { ILinkClient } from '../ilink/client.js';
import type { ILinkMessage, WeixinInboundMeta } from '../ilink/types.js';
import type { SyncCursorStore } from '../storage/sync-cursor.js';
import type { ContextTokenStore } from '../storage/context-token.js';
import { PersistentDedupStore, dedupKey, type DedupStore } from './dedup.js';
import { mapInbound } from './mapper.js';

export interface MonitorReconnectConfig {
  enabled: boolean;
  baseDelayMs: number;
  maxDelayMs: number;
}

/** Raised when the durable cursor write fails; the monitor loop retries. */
export class CursorCommitError extends Error {
  readonly cursor: string;

  constructor(cursor: string, options?: ErrorOptions) {
    super('failed to commit sync cursor', options);
    this.name = 'CursorCommitError';
    this.cursor = cursor;
  }
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
  /** Two-phase dedup store; defaults to a durable PersistentDedupStore. */
  dedup?: DedupStore;
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
  private readonly dedup: DedupStore;
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
    this.dedup = options.dedup ?? new PersistentDedupStore({
      storage: options.ctx.storage,
      accountId: options.meta.accountId,
      windowMs: options.dedupWindowMs,
      now: options.now ?? Date.now,
    });
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
        const t = result.nextLongPollTimeoutMs;
        if (typeof t === 'number' && t > 0) {
          this.nextLongPollTimeoutMs = t;
        }
        attempt = 0;
        this.onConnectionChange?.('connected');

        // Process each message; then commit the cursor AFTER the round.
        if (result.msgs && result.msgs.length > 0) {
          for (const msg of result.msgs) {
            if (signal.aborted) break;
            await this.handleMessage(msg);
          }
          // Persist only after the inbound round is processed (§18 / R1).
          if (result.get_updates_buf !== undefined) {
            cursor = await this.commitCursor(result.get_updates_buf);
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
        this.ctx.logger.warn('[channel-weixin] getUpdates error; retry in ' + delay + 'ms', error);
        await sleep(delay, signal);
      }
    }

    this.onConnectionChange?.('disconnected');
  }

  /**
   * Persist the new cursor. The local cursor is advanced only after the
   * durable write succeeds; on failure a CursorCommitError is thrown so the
   * loop retries with the previous cursor instead of silently diverging.
   */
  private async commitCursor(next: string): Promise<string> {
    try {
      await this.cursor.set(next);
    } catch (error) {
      throw new CursorCommitError(next, { cause: error });
    }
    return next;
  }

  private async handleMessage(msg: ILinkMessage): Promise<void> {
    const key = dedupKey(msg);
    if (await this.dedup.has(key)) {
      this.ctx.logger.debug("[channel-weixin] dropped duplicate message '" + key + "'");
      return;
    }
    // Capture the latest peer reply context before emit (idempotent on replay).
    if (msg.context_token && msg.from_user_id) {
      await this.contextTokens.set(msg.from_user_id, msg.context_token);
    }
    const event = mapInbound(msg, this.meta);
    await this.emitMsg(event);
    // The upstream callback hydrates media before dispatch. Log afterward so
    // localDataBytes reports the final adapter-visible state, not raw mapping.
    this.ctx.logger.info(
      `[channel-weixin] inbound message ${event.message.id} from ${event.sender.id} in ${event.conversation.id}`,
      { parts: summarizeParts(event.message.content) },
    );
    // Only after a successful emit is the message a committed dedup entry.
    await this.dedup.commit(key);
  }

  /** Current long-poll timeout (dynamic). */
  get longPollTimeout(): number {
    return this.nextLongPollTimeoutMs;
  }
}


/** Compact per-part summary for inbound message logs (debug diagnostics). */
function summarizeParts(parts: readonly MessagePart[]): unknown[] {
  return parts.map((part) => {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text.slice(0, 80) };
      case 'image':
        return {
          type: 'image',
          url: part.url,
          resourceRef: part.resourceRef,
          mimeType: part.mimeType,
          localDataBytes: part.localData?.byteLength,
          ingressFailure: part.ingressFailure,
        };
      case 'file':
        return {
          type: 'file',
          name: part.name,
          size: part.size,
          mimeType: part.mimeType,
          localDataBytes: part.localData?.byteLength,
          ingressFailure: part.ingressFailure,
        };
      case 'audio':
        return { type: 'audio', durationMs: part.durationMs, localDataBytes: part.localData?.byteLength };
      case 'video':
        return { type: 'video', durationMs: part.durationMs, localDataBytes: part.localData?.byteLength };
      default:
        return { type: part.type };
    }
  });
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
