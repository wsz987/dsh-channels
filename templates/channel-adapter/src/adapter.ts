/**
 * <ChannelName> channel adapter.
 *
 * Maps the platform (through the upstream driver) to the Channel Contract.
 * All network/lifecycle resources live behind the upstream driver and are
 * aborted via the adapter context signal. The adapter never touches Harness
 * Agent APIs.
 *
 * Rename the class (`ChannelNameAdapter` → `<ChannelName>Adapter`, e.g.
 * `TelegramAdapter`) and the `<channel>` id when scaffolding a real adapter.
 */
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelCapabilities,
  ChannelHealth,
  ChannelTarget,
  OutboundMessage,
  SendResult,
} from '@wsz987/channel-core';
import { ChannelError, ChannelSendError } from '@wsz987/channel-core';
import type { ChannelConfig } from './config.js';
import { FetchTransport, type HttpTransport } from './transport.js';
import { HttpChannelUpstream, type ChannelUpstream } from './upstream.js';
import { dedupKey, mapInbound, toTextPayload, type ChannelInboundMeta } from './mapper.js';

export interface ChannelAdapterDeps {
  transport?: HttpTransport;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** Upstream compatibility manifest (read structurally by `channels doctor`). */
export interface ChannelManifest {
  id: string;
  adapterVersion: string;
  upstream: {
    reference: string;
    testedVersion: string;
    versionRange: string;
    strategy: 'source';
  };
  status: 'tested' | 'compatible' | 'untested' | 'unsupported';
}

export class ChannelNameAdapter implements ChannelAdapter {
  readonly id = '<channel>';

  /**
   * Start as `untested` and promote to `tested` once the contract suite and
   * fixtures pass against a real upstream version (see docs/adapter-authoring.md).
   */
  readonly manifest: ChannelManifest = {
    id: '<channel>',
    adapterVersion: '0.1.0',
    upstream: {
      reference: '<channel> http gateway (self-hosted, protocol-level)',
      testedVersion: '0.0.0',
      versionRange: '*',
      strategy: 'source',
    },
    status: 'untested',
  };

  readonly capabilities: ChannelCapabilities = {
    text: true,
    image: true,
    file: true,
    audio: true,
    video: false,
    markdown: false,
    cards: false,
    reactions: false,
    threads: false,
    // No native streaming / editable cards yet: accumulate chunks and deliver
    // once via `adapter.send` at turn/end.
    streaming: 'buffered',
  };

  private ctx?: ChannelAdapterContext;
  private upstream: ChannelUpstream;
  private inbound = new InboundProcessor();
  private started = false;
  private stopped = false;
  private receiveLoop?: Promise<void>;
  private connected = false;
  private readonly now: () => number;

  constructor(private readonly config: ChannelConfig, deps: ChannelAdapterDeps = {}) {
    this.now = deps.now ?? Date.now;
    const transport = deps.transport ?? new FetchTransport(config.baseUrl, { timeoutMs: config.timeoutMs });
    this.upstream = new HttpChannelUpstream({ transport, longPollTimeoutMs: config.longPollTimeoutMs });
  }

  async start(ctx: ChannelAdapterContext): Promise<void> {
    if (this.started) return;
    this.ctx = ctx;
    this.stopped = false;
    this.inbound.configure({
      ctx,
      meta: { channel: this.id as never, accountId: this.config.accountId as never },
      dedupEnabled: this.config.dedup.enabled,
      dedupWindowMs: this.config.dedup.windowMs,
      now: this.now,
    });
    await this.upstream.start();
    this.connected = true;
    this.emitConnection('connected');
    this.startReceiveLoop();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    this.started = false;
    this.connected = false;
    // The owning fiber aborts the context signal first; the loop exits on it.
    const loop = this.receiveLoop;
    this.receiveLoop = undefined;
    if (loop) await loop.catch(() => undefined);
    await this.upstream.stop().catch(() => undefined);
    this.emitConnection('closed');
  }

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    if (!this.started) {
      throw new ChannelError('CHANNEL_NOT_STARTED', '<channel> adapter is not started');
    }
    try {
      const media = firstMedia(message.parts);
      if (media) {
        const response = await this.upstream.sendMedia(target.conversationId, media);
        return { delivered: true, raw: response };
      }
      const payload = toTextPayload(target, message);
      const response = await this.upstream.sendText(payload.to, payload.content);
      return { delivered: true, raw: response };
    } catch (error) {
      this.ctx?.logger.error(
        `[channel-<channel>] send failed to '${target.conversationId}'`,
        error instanceof Error ? error.message : error,
      );
      throw new ChannelSendError(
        `<channel> send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async getHealth(): Promise<ChannelHealth> {
    if (!this.started) {
      return { status: 'down', detail: '<channel> adapter is not started', authenticated: true };
    }
    if (this.connected) {
      return { status: 'ok', detail: 'connected', connection: 'connected', authenticated: true };
    }
    return {
      status: 'degraded',
      detail: 'receive loop down',
      connection: 'disconnected',
      authenticated: true,
    };
  }

  /** Long-poll receive loop with exponential backoff on failure. */
  startReceiveLoop(): void {
    if (this.receiveLoop) return;
    this.receiveLoop = this.runReceiveLoop();
  }

  private async runReceiveLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped && !this.aborted()) {
      try {
        await this.upstream.receive(this.ctx!.signal, (raw) => {
          void this.inbound.handle(raw).catch((error) => {
            this.ctx!.logger.error('[channel-<channel>] inbound handling failed', error);
          });
        });
        attempt = 0;
      } catch (error) {
        if (this.stopped || this.aborted()) break;
        attempt += 1;
        this.connected = false;
        this.emitConnection('reconnecting');
        if (this.config.reconnect.enabled && attempt > this.config.reconnect.maxRetries) {
          this.ctx!.logger.warn('[channel-<channel>] reconnect budget exhausted');
          this.emitConnection('disconnected');
          break;
        }
        const delay = Math.min(
          this.config.reconnect.baseDelayMs * 2 ** Math.min(attempt - 1, 8),
          this.config.reconnect.maxDelayMs,
        );
        this.ctx!.logger.warn(`[channel-<channel>] receive loop error; retry in ${delay}ms`, error);
        await sleep(delay, this.ctx!.signal);
      }
    }
    this.connected = false;
    if (!this.stopped && !this.aborted()) {
      this.emitConnection('disconnected');
    }
  }

  private aborted(): boolean {
    return this.ctx?.signal.aborted ?? false;
  }

  private emitConnection(state: 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'closed'): void {
    if (!this.ctx) return;
    void this.ctx
      .emit({
        type: 'connection.changed',
        channel: this.id as never,
        accountId: this.config.accountId as never,
        state,
      })
      .catch(() => undefined);
  }
}

/**
 * Inbound processing: dedup window + structured mapping + emit. Kept small on
 * purpose — swap in a dedicated `inbound.ts` module when the channel grows.
 */
export class InboundProcessor {
  private ctx?: ChannelAdapterContext;
  private meta?: ChannelInboundMeta;
  private dedupEnabled = false;
  private dedupWindowMs = 0;
  private now: () => number = Date.now;
  /** dedup key -> last-seen timestamp, pruned on every handle. */
  private readonly seen = new Map<string, number>();

  configure(options: {
    ctx: ChannelAdapterContext;
    meta: ChannelInboundMeta;
    dedupEnabled: boolean;
    dedupWindowMs: number;
    now?: () => number;
  }): void {
    this.ctx = options.ctx;
    this.meta = options.meta;
    this.dedupEnabled = options.dedupEnabled;
    this.dedupWindowMs = options.dedupWindowMs;
    this.now = options.now ?? Date.now;
  }

  /** Process one raw payload from the upstream; dedup then emit. */
  async handle(raw: unknown): Promise<void> {
    const key = dedupKey(raw);
    if (this.dedupEnabled) {
      const now = this.now();
      const last = this.seen.get(key);
      if (last !== undefined && now - last < this.dedupWindowMs) {
        this.ctx?.logger.debug(`[channel-<channel>] dropped duplicate message '${key}'`);
        return;
      }
      this.seen.set(key, now);
      this.prune(now);
    }
    const event = mapInbound(raw, this.meta!);
    await this.ctx!.emit(event);
  }

  private prune(now: number): void {
    for (const [key, ts] of this.seen) {
      if (now - ts >= this.dedupWindowMs) this.seen.delete(key);
    }
  }
}

/** First media part with a resolvable url, if any. */
function firstMedia(parts: OutboundMessage['parts']): { type: string; url: string } | undefined {
  if (!parts) return undefined;
  for (const part of parts) {
    if (part.type === 'image' && part.url) return { type: 'image', url: part.url };
    if (part.type === 'audio' && part.url) return { type: 'audio', url: part.url };
    if (part.type === 'file' && part.url) return { type: 'file', url: part.url };
  }
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
