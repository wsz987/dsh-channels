/**
 * Weixin channel adapter.
 *
 * Maps the weixin platform (through the upstream driver) to the Channel
 * Contract. All network/lifecycle resources live behind the upstream driver
 * and are aborted via the adapter context signal. The adapter never touches
 * Harness Agent APIs.
 */
import type {
  AuthChallenge,
  AuthStatePoll,
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelCapabilities,
  ChannelHealth,
  ChannelTarget,
  OutboundMessage,
  SendResult,
} from '@dsh/channel-core';
import { ChannelError } from '@dsh/channel-core';
import type { WeixinConfig } from './config.js';
import { FetchTransport, type HttpTransport } from './transport.js';
import { HttpWeixinUpstream, type WeixinUpstream } from './upstream.js';
import { InboundProcessor } from './inbound.js';
import { OutboundSender } from './outbound.js';
import { WeixinAuthManager } from './auth.js';

export interface WeixinAdapterDeps {
  transport?: HttpTransport;
  /** Injectable clock (tests). */
  now?: () => number;
}

export class WeixinAdapter implements ChannelAdapter {
  readonly id = 'weixin';

  readonly capabilities: ChannelCapabilities = {
    text: true,
    image: true,
    file: false,
    audio: true,
    video: false,
    markdown: false,
    cards: false,
    reactions: false,
    threads: false,
    streaming: 'buffered',
  };

  private ctx?: ChannelAdapterContext;
  private upstream: WeixinUpstream;
  private auth!: WeixinAuthManager;
  private inbound!: InboundProcessor;
  private outbound!: OutboundSender;
  private started = false;
  private stopped = false;
  private receiveLoop?: Promise<void>;
  private connected = false;
  private readonly now: () => number;

  constructor(private readonly config: WeixinConfig, deps: WeixinAdapterDeps = {}) {
    this.now = deps.now ?? Date.now;
    const transport = deps.transport ?? new FetchTransport(config.baseUrl, { timeoutMs: config.timeoutMs });
    this.upstream = new HttpWeixinUpstream({ transport, longPollTimeoutMs: config.longPollTimeoutMs });
  }

  async start(ctx: ChannelAdapterContext): Promise<void> {
    if (this.started) return;
    this.ctx = ctx;
    this.stopped = false;
    this.auth = new WeixinAuthManager({
      upstream: this.upstream,
      statePath: this.config.auth.statePath,
      now: this.now,
      onAuthChange: (state) => {
        if (state.status === 'authenticated') {
          this.emitAuth('authenticated');
        } else if (state.status === 'expired') {
          this.emitAuth('expired');
        }
      },
    });
    this.inbound = new InboundProcessor({
      ctx,
      meta: { channel: this.id as never, accountId: this.config.accountId as never },
      dedupEnabled: this.config.dedup.enabled,
      dedupWindowMs: this.config.dedup.windowMs,
      now: this.now,
    });
    this.outbound = new OutboundSender(this.upstream, ctx.logger);

    await this.auth.load();
    this.emitAuth(this.auth.getState().status);
    if (this.auth.isAuthenticated) {
      this.connected = true;
      this.emitConnection('connected');
      this.startReceiveLoop();
    }
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
      throw new ChannelError('CHANNEL_NOT_STARTED', 'weixin adapter is not started');
    }
    return this.outbound.send(target, message);
  }

  async beginAuth(): Promise<AuthChallenge> {
    if (!this.auth) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'weixin adapter is not started');
    }
    return this.auth.beginAuth();
  }

  async pollAuth(challenge: AuthChallenge): Promise<AuthStatePoll> {
    if (!this.auth) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'weixin adapter is not started');
    }
    const result = await this.auth.pollAuth(challenge);
    if (result.state === 'authenticated') {
      this.connected = true;
      this.emitConnection('connected');
      this.startReceiveLoop();
    } else if (result.state === 'expired' || result.state === 'failed') {
      this.connected = false;
      this.emitConnection('disconnected');
    }
    return result;
  }

  async getHealth(): Promise<ChannelHealth> {
    if (!this.started) {
      return { status: 'down', detail: 'weixin adapter is not started', authenticated: false };
    }
    if (this.auth.isAuthenticated && this.connected) {
      return { status: 'ok', detail: 'connected', connection: 'connected', authenticated: true };
    }
    if (this.auth.isAuthenticated) {
      return {
        status: 'degraded',
        detail: 'authenticated but receive loop down',
        connection: 'disconnected',
        authenticated: true,
      };
    }
    return { status: 'down', detail: 'not authenticated', authenticated: false };
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
            this.ctx!.logger.error('[channel-weixin] inbound handling failed', error);
          });
        });
        attempt = 0;
      } catch (error) {
        if (this.stopped || this.aborted()) break;
        attempt += 1;
        this.connected = false;
        this.emitConnection('reconnecting');
        if (this.config.reconnect.enabled && attempt > this.config.reconnect.maxRetries) {
          this.ctx!.logger.warn('[channel-weixin] reconnect budget exhausted');
          this.emitConnection('disconnected');
          break;
        }
        const delay = Math.min(
          this.config.reconnect.baseDelayMs * 2 ** Math.min(attempt - 1, 8),
          this.config.reconnect.maxDelayMs,
        );
        this.ctx!.logger.warn(`[channel-weixin] receive loop error; retry in ${delay}ms`, error);
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

  private emitAuth(state: 'unknown' | 'pending' | 'authenticated' | 'expired' | 'failed'): void {
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
