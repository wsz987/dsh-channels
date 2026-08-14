/**
 * Telegram channel adapter.
 *
 * Maps the Telegram Bot API (through the upstream driver) to the Channel
 * Contract. All network/lifecycle resources live behind the upstream driver
 * and are aborted via the adapter context signal. The adapter never touches
 * Harness Agent APIs.
 *
 * Auth is token-driven: when `config.token` is present, `start` verifies it
 * with getMe() and launches the long-poll receive loop; without a token the
 * adapter reports health 'down' and skips the loop entirely (tests and
 * offline fixtures carry no token). `beginAuth`/`pollAuth` are intentionally
 * not implemented — there is no interactive flow in V1; token rotation can
 * slot in behind the same optional contract methods later.
 */
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelCapabilities,
  ChannelHealth,
  ChannelTarget,
  OutboundMessage,
  SendResult,
} from '@dsh/channel-core';
import { ChannelError } from '@dsh/channel-core';
import type { TelegramConfig } from './config.js';
import { FetchTransport, type HttpTransport } from './transport.js';
import { HttpTelegramUpstream, type TelegramUpstream } from './upstream.js';
import { InboundProcessor } from './inbound.js';
import { OutboundSender } from './outbound.js';
import { manifest as telegramManifest, type TelegramManifest } from './manifest.js';

export interface TelegramAdapterDeps {
  transport?: HttpTransport;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** Adapter-level auth state; emits AuthState 'unknown' when unauthenticated. */
type TelegramAuthState = 'unauthenticated' | 'authenticated' | 'failed';

export class TelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram';

  /** Upstream compatibility manifest (read structurally by `channels doctor`). */
  readonly manifest: TelegramManifest = telegramManifest;

  readonly capabilities: ChannelCapabilities = {
    text: true,
    image: true,
    file: true,
    audio: true,
    video: true,
    markdown: true,
    cards: false,
    reactions: true,
    threads: false,
    // Telegram can edit sent messages (editMessageText), so 'edit' streaming
    // is technically reachable; the V1 proof ships 'buffered' (accumulate and
    // deliver once) with edit streaming documented as a future capability.
    streaming: 'buffered',
  };

  private ctx?: ChannelAdapterContext;
  private upstream: TelegramUpstream;
  private inbound!: InboundProcessor;
  private outbound!: OutboundSender;
  private started = false;
  private stopped = false;
  private receiveLoop?: Promise<void>;
  private connected = false;
  private authState: TelegramAuthState = 'unauthenticated';
  /** getUpdates offset; acked by the upstream loop, resumed across reconnects. */
  private offset = 0;
  private readonly now: () => number;

  constructor(private readonly config: TelegramConfig, deps: TelegramAdapterDeps = {}) {
    this.now = deps.now ?? Date.now;
    const transport = deps.transport ?? new FetchTransport(config.baseUrl, { timeoutMs: config.timeoutMs });
    this.upstream = new HttpTelegramUpstream({
      transport,
      token: config.token,
      longPollTimeoutMs: config.longPollTimeoutMs,
    });
  }

  async start(ctx: ChannelAdapterContext): Promise<void> {
    if (this.started) return;
    this.ctx = ctx;
    this.stopped = false;
    this.connected = false;
    this.offset = 0;
    this.inbound = new InboundProcessor({
      ctx,
      meta: { channel: this.id as never, accountId: this.config.accountId as never },
      dedupEnabled: this.config.dedup.enabled,
      dedupWindowMs: this.config.dedup.windowMs,
      now: this.now,
    });
    this.outbound = new OutboundSender(this.upstream, ctx.logger);

    if (this.config.token) {
      try {
        await this.upstream.getMe();
        this.authState = 'authenticated';
        this.emitAuth('authenticated');
        this.emitConnection('connecting');
        this.startReceiveLoop();
        this.connected = true;
        this.emitConnection('connected');
      } catch (error) {
        this.authState = 'failed';
        this.connected = false;
        this.emitAuth('failed');
        this.ctx.logger.error(
          '[channel-telegram] auth check failed; receive loop disabled',
          error instanceof Error ? error.message : error,
        );
      }
    } else {
      this.authState = 'unauthenticated';
      this.emitAuth('unknown');
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
      throw new ChannelError('CHANNEL_NOT_STARTED', 'telegram adapter is not started');
    }
    return this.outbound.send(target, message);
  }

  async getHealth(): Promise<ChannelHealth> {
    if (!this.started) {
      return { status: 'down', detail: 'telegram adapter is not started', authenticated: false };
    }
    if (this.authState === 'authenticated' && this.connected) {
      return { status: 'ok', detail: 'connected', connection: 'connected', authenticated: true };
    }
    if (this.authState === 'authenticated') {
      return {
        status: 'down',
        detail: 'authenticated but receive loop down',
        connection: 'disconnected',
        authenticated: true,
      };
    }
    if (this.authState === 'failed') {
      return { status: 'down', detail: 'authentication failed', authenticated: false };
    }
    return { status: 'down', detail: 'not configured: no bot token', authenticated: false };
  }

  /** Long-poll receive loop with exponential backoff on failure. */
  private startReceiveLoop(): void {
    if (this.receiveLoop) return;
    this.receiveLoop = this.runReceiveLoop();
  }

  private async runReceiveLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped && !this.aborted()) {
      try {
        await this.upstream.getUpdates(this.offset, this.ctx!.signal, (raw) => {
          void this.inbound.handle(raw).catch((error) => {
            this.ctx!.logger.error('[channel-telegram] inbound handling failed', error);
          });
        });
        attempt = 0;
        if (!this.connected) {
          // A successful long-poll cycle proves the Bot API is reachable.
          this.connected = true;
          this.emitConnection('connected');
        }
      } catch (error) {
        if (this.stopped || this.aborted()) break;
        attempt += 1;
        this.connected = false;
        this.emitConnection('reconnecting');
        if (this.config.reconnect.enabled && attempt > this.config.reconnect.maxRetries) {
          this.ctx!.logger.warn('[channel-telegram] reconnect budget exhausted');
          this.emitConnection('disconnected');
          break;
        }
        const delay = Math.min(
          this.config.reconnect.baseDelayMs * 2 ** Math.min(attempt - 1, 8),
          this.config.reconnect.maxDelayMs,
        );
        this.ctx!.logger.warn(`[channel-telegram] receive loop error; retry in ${delay}ms`, error);
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
