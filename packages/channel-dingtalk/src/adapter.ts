/**
 * DingTalk channel adapter.
 *
 * Maps the DingTalk platform (through the upstream driver) to the Channel
 * Contract. All network/lifecycle resources live behind the upstream driver
 * and are aborted via the adapter context signal. The adapter never touches
 * Harness Agent APIs.
 *
 * Auth is connection-state driven: the self-hosted gateway owns the platform
 * credentials, so the adapter derives its auth state from the receive loop
 * (connected → authenticated). `beginAuth`/`pollAuth` are intentionally not
 * implemented in M2 — a real QR/token flow can slot in behind the same
 * optional contract methods later.
 */
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelCapabilities,
  ChannelHealth,
  ChannelTarget,
  CreateReplyOptions,
  OutboundMessage,
  ReplyHandle,
  SendResult,
} from '@dsh/channel-core';
import { ChannelError } from '@dsh/channel-core';
import type { DingTalkConfig } from './config.js';
import { FetchTransport, type HttpTransport } from './transport.js';
import { HttpDingTalkUpstream, type DingTalkUpstream } from './upstream.js';
import { InboundProcessor } from './inbound.js';
import { OutboundSender } from './outbound.js';
import { DingTalkCardReply } from './ai-card.js';
import { manifest as dingTalkManifest, type DingTalkManifest } from './manifest.js';

export interface DingTalkAdapterDeps {
  transport?: HttpTransport;
  /** Injectable clock (tests). */
  now?: () => number;
}

export class DingTalkAdapter implements ChannelAdapter {
  readonly id = 'dingtalk';

  /** Upstream compatibility manifest (read structurally by `channels doctor`). */
  readonly manifest: DingTalkManifest = dingTalkManifest;

  readonly capabilities: ChannelCapabilities = {
    text: true,
    image: true,
    file: true,
    audio: true,
    video: false,
    markdown: true,
    cards: true,
    reactions: false,
    threads: false,
    streaming: 'edit',
  };

  private ctx?: ChannelAdapterContext;
  private upstream: DingTalkUpstream;
  private inbound!: InboundProcessor;
  private outbound!: OutboundSender;
  private started = false;
  private stopped = false;
  private receiveLoop?: Promise<void>;
  private connected = false;
  /** Connection-state-driven auth; the gateway owns platform credentials. */
  private authState: 'unknown' | 'authenticated' | 'failed' = 'unknown';
  private readonly now: () => number;

  constructor(private readonly config: DingTalkConfig, deps: DingTalkAdapterDeps = {}) {
    this.now = deps.now ?? Date.now;
    const transport = deps.transport ?? new FetchTransport(config.baseUrl, { timeoutMs: config.timeoutMs });
    this.upstream = new HttpDingTalkUpstream({ transport, longPollTimeoutMs: config.longPollTimeoutMs });
  }

  async start(ctx: ChannelAdapterContext): Promise<void> {
    if (this.started) return;
    this.ctx = ctx;
    this.stopped = false;
    this.inbound = new InboundProcessor({
      ctx,
      meta: { channel: this.id as never, accountId: this.config.accountId as never },
      dedupEnabled: this.config.dedup.enabled,
      dedupWindowMs: this.config.dedup.windowMs,
      now: this.now,
    });
    this.outbound = new OutboundSender(this.upstream, ctx.logger);

    this.connected = false;
    this.authState = 'unknown';
    this.emitAuth(this.authState);
    this.emitConnection('connecting');
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
    this.emitConnection('closed');
  }

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    if (!this.started || !this.outbound) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'dingtalk adapter is not started');
    }
    return this.outbound.send(target, message);
  }

  async createReply(target: ChannelTarget, _options?: CreateReplyOptions): Promise<ReplyHandle> {
    if (!this.started || !this.ctx) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'dingtalk adapter is not started');
    }
    return new DingTalkCardReply({
      upstream: this.upstream,
      target,
      logger: this.ctx.logger,
      createOnFirstDelta: this.config.card.createOnFirstDelta,
      now: this.now,
    });
  }

  async getHealth(): Promise<ChannelHealth> {
    if (!this.started) {
      return { status: 'down', detail: 'dingtalk adapter is not started', authenticated: false };
    }
    if (this.connected) {
      return { status: 'ok', detail: 'connected', connection: 'connected', authenticated: true };
    }
    return {
      status: 'degraded',
      detail: 'receive loop down',
      connection: 'disconnected',
      authenticated: false,
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
            this.ctx!.logger.error('[channel-dingtalk] inbound handling failed', error);
          });
        });
        attempt = 0;
        if (!this.connected) {
          // A successful long-poll proves the gateway is reachable; auth
          // follows the connection state (the gateway owns credentials).
          this.connected = true;
          this.setAuth('authenticated');
          this.emitConnection('connected');
        }
      } catch (error) {
        if (this.stopped || this.aborted()) break;
        attempt += 1;
        this.connected = false;
        this.emitConnection('reconnecting');
        if (this.config.reconnect.enabled && attempt > this.config.reconnect.maxRetries) {
          this.ctx!.logger.warn('[channel-dingtalk] reconnect budget exhausted');
          this.setAuth('failed');
          this.emitConnection('disconnected');
          break;
        }
        const delay = Math.min(
          this.config.reconnect.baseDelayMs * 2 ** Math.min(attempt - 1, 8),
          this.config.reconnect.maxDelayMs,
        );
        this.ctx!.logger.warn(`[channel-dingtalk] receive loop error; retry in ${delay}ms`, error);
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

  private setAuth(state: 'unknown' | 'authenticated' | 'failed'): void {
    if (this.authState === state) return;
    this.authState = state;
    this.emitAuth(state);
  }

  private emitAuth(state: 'unknown' | 'authenticated' | 'failed'): void {
    if (!this.ctx) return;
    void this.ctx
      .emit({
        type: 'auth.changed',
        channel: this.id as never,
        accountId: this.config.accountId as never,
        state,
      })
      .catch(() => undefined);
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
