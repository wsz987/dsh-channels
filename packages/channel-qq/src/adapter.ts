/**
 * QQ channel adapter.
 *
 * Maps the QQ platform (through the upstream driver) to the Channel Contract.
 * All network/lifecycle resources live behind the upstream driver and are
 * aborted via the adapter context signal. The adapter never touches Harness
 * Agent APIs.
 *
 * The upstream driver is selected by `config.upstream.mode`:
 * - 'sdk'     → `QQGatewayUpstream`: the official QQ 开放平台 WebSocket
 *   gateway protocol implemented in-source (no third-party SDK). Token auth
 *   (AppId + ClientSecret → access token), inbound C2C / group-@ dispatch,
 *   and outbound sends through the official v2 OpenAPI. The WS client comes
 *   from `deps.gatewayClientFactory`, defaulting to a real `ws` client;
 *   missing credentials fail start loudly (never construction).
 * - 'gateway' → `HttpQQUpstream` over the transport (legacy self-hosted
 *   gateway; QR auth via beginAuth/pollAuth).
 *
 * In 'sdk' mode auth is connection-state driven (the driver owns the
 * credentials): connected → authenticated. `beginAuth`/`pollAuth` are
 * gateway-mode only and reject in 'sdk' mode.
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
import type { QQConfig } from './config.js';
import { FetchTransport, type HttpTransport } from './transport.js';
import { HttpQQUpstream, type QQUpstream } from './upstream.js';
import {
  createDefaultGatewayClient,
  QQGatewayUpstream,
  type QQGatewayClient,
} from './qq-gateway-upstream.js';
import { InboundProcessor } from './inbound.js';
import { OutboundSender } from './outbound.js';
import { QQAuthManager } from './auth.js';
import { manifest as qqManifest, type QQManifest } from './manifest.js';

export interface QQAdapterDeps {
  transport?: HttpTransport;
  /**
   * WS gateway client factory for SDK mode (offline tests). Defaults to a
   * real `ws` client via `createDefaultGatewayClient`.
   */
  gatewayClientFactory?: (url: string) => QQGatewayClient;
  /** Injectable fetch for token/gateway/send calls in SDK mode (tests). */
  fetchImpl?: typeof fetch;
  /** Injectable clock (tests). */
  now?: () => number;
}

export class QQAdapter implements ChannelAdapter {
  readonly id = 'qq';

  /** Upstream compatibility manifest (read structurally by `channels doctor`). */
  readonly manifest: QQManifest = qqManifest;
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
    // QQ has no native streaming and no editable cards: accumulate chunks and
    // deliver once via `adapter.send` at turn/end.
    streaming: 'buffered',
  };

  private ctx?: ChannelAdapterContext;
  /** Built in `start()` (driver selection needs the resolved deps/credentials). */
  private upstream!: QQUpstream;
  /** QR auth manager — gateway mode only. */
  private auth?: QQAuthManager;
  private readonly transport: HttpTransport;
  private readonly deps: QQAdapterDeps;
  private inbound!: InboundProcessor;
  private outbound!: OutboundSender;
  private started = false;
  private stopped = false;
  private receiveLoop?: Promise<void>;
  private connected = false;
  /** Connection-state-driven auth in sdk mode; the driver owns credentials. */
  private authState: 'unknown' | 'authenticated' | 'failed' = 'unknown';
  private readonly now: () => number;
  /** Internal stop signal merged with the context signal for prompt teardown. */
  private stopController?: AbortController;
  private receiveSignal?: AbortSignal;

  constructor(private readonly config: QQConfig, deps: QQAdapterDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.deps = deps;
    this.transport = deps.transport ?? new FetchTransport(config.baseUrl, { timeoutMs: config.timeoutMs });
  }

  async start(ctx: ChannelAdapterContext): Promise<void> {
    if (this.started) return;
    this.ctx = ctx;
    this.stopped = false;
    this.buildUpstream();
    this.stopController = new AbortController();
    this.receiveSignal = AbortSignal.any([ctx.signal, this.stopController.signal]);
    this.inbound = new InboundProcessor({
      ctx,
      meta: { channel: this.id as never, accountId: this.config.accountId as never },
      dedupEnabled: this.config.dedup.enabled,
      dedupWindowMs: this.config.dedup.windowMs,
      now: this.now,
    });
    this.outbound = new OutboundSender(this.upstream, ctx.logger);

    if (this.config.upstream.mode === 'sdk') {
      // Connection-state-driven auth: the WS session owns the credentials, so
      // the receive loop starts immediately and reports connectivity.
      this.connected = false;
      this.authState = 'unknown';
      this.emitAuth(this.authState);
      this.emitConnection('connecting');
      this.startReceiveLoop();
    } else {
      this.auth = new QQAuthManager({
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
      await this.auth.load();
      this.emitAuth(this.auth.getState().status);
      if (this.auth.isAuthenticated) {
        // Restored auth: connect immediately without a fresh QR scan.
        this.connected = true;
        this.emitConnection('connected');
        this.startReceiveLoop();
      }
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    this.started = false;
    this.connected = false;
    // The owning fiber aborts the context signal first; the loop also exits
    // on our internal stop signal so stop() never depends on an external
    // abort (contract tests stop without disposing the context).
    this.stopController?.abort();
    const loop = this.receiveLoop;
    this.receiveLoop = undefined;
    if (loop) await loop.catch(() => undefined);
    this.emitConnection('closed');
  }

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    if (!this.started || !this.outbound) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'qq adapter is not started');
    }
    return this.outbound.send(target, message);
  }

  /** Begin QR auth (gateway mode only; sdk mode is token-based). */
  async beginAuth(): Promise<AuthChallenge> {
    if (!this.started) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'qq adapter is not started');
    }
    if (!this.auth) {
      throw new ChannelError('CHANNEL_ERROR', 'qq upstream mode "sdk" is token-based; QR auth is gateway-only');
    }
    return this.auth.beginAuth();
  }

  /** Poll the QR auth state; on success starts the receive loop (gateway mode). */
  async pollAuth(challenge: AuthChallenge): Promise<AuthStatePoll> {
    if (!this.started) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'qq adapter is not started');
    }
    if (!this.auth) {
      throw new ChannelError('CHANNEL_ERROR', 'qq upstream mode "sdk" is token-based; QR auth is gateway-only');
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
      return { status: 'down', detail: 'qq adapter is not started', authenticated: false };
    }
    if (this.config.upstream.mode === 'sdk') {
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
    if (this.auth?.isAuthenticated && this.connected) {
      return { status: 'ok', detail: 'connected', connection: 'connected', authenticated: true };
    }
    if (this.auth?.isAuthenticated) {
      return {
        status: 'degraded',
        detail: 'authenticated but receive loop down',
        connection: 'disconnected',
        authenticated: true,
      };
    }
    return { status: 'down', detail: 'not authenticated', authenticated: false };
  }

  /** Long-poll / gateway receive loop with exponential backoff on failure. */
  startReceiveLoop(): void {
    if (this.receiveLoop) return;
    this.receiveLoop = this.runReceiveLoop();
  }

  /** Select and build the upstream driver for the configured mode. */
  private buildUpstream(): void {
    const httpUpstream = new HttpQQUpstream({
      transport: this.transport,
      longPollTimeoutMs: this.config.longPollTimeoutMs,
    });
    if (this.config.upstream.mode !== 'sdk') {
      this.upstream = httpUpstream;
      return;
    }
    const { appId, clientSecret } = this.config.upstream;
    if (!appId || !clientSecret) {
      throw new ChannelError(
        'CHANNEL_ERROR',
        'qq upstream mode "sdk" requires upstream.appId and upstream.clientSecret',
      );
    }
    this.upstream = new QQGatewayUpstream({
      appId,
      clientSecret,
      requestTimeoutMs: this.config.timeoutMs,
      fetchImpl: this.deps.fetchImpl,
      gatewayClientFactory: this.deps.gatewayClientFactory ?? createDefaultGatewayClient,
      onConnected: () => this.markConnected(),
    });
  }

  private async runReceiveLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped && !this.aborted()) {
      try {
        await this.upstream.receive(this.receiveSignal!, (raw) => {
          void this.inbound.handle(raw).catch((error) => {
            this.ctx!.logger.error('[channel-qq] inbound handling failed', error);
          });
        });
        attempt = 0;
        // A completed receive cycle proves the upstream is reachable; auth
        // follows the connection state (the driver owns credentials). In sdk
        // mode the WS driver also reports connectivity via onConnected.
        this.markConnected();
      } catch (error) {
        if (this.stopped || this.aborted()) break;
        attempt += 1;
        this.connected = false;
        this.emitConnection('reconnecting');
        if (this.config.reconnect.enabled && attempt > this.config.reconnect.maxRetries) {
          this.ctx!.logger.warn('[channel-qq] reconnect budget exhausted');
          if (this.config.upstream.mode === 'sdk') this.setAuth('failed');
          this.emitConnection('disconnected');
          break;
        }
        const delay = Math.min(
          this.config.reconnect.baseDelayMs * 2 ** Math.min(attempt - 1, 8),
          this.config.reconnect.maxDelayMs,
        );
        this.ctx!.logger.warn(`[channel-qq] receive loop error; retry in ${delay}ms`, error);
        await sleep(delay, this.receiveSignal!);
      }
    }
    this.connected = false;
    if (!this.stopped && !this.aborted()) {
      this.emitConnection('disconnected');
    }
  }

  /** Flip connection/auth state once the upstream proves reachable. */
  private markConnected(): void {
    // Never report connected while stopping; an external abort is not
    // sufficient (a long-poll cycle may legitimately end on the abort while
    // having already proven reachability — see the gateway lifecycle tests).
    if (this.stopped) return;
    if (this.connected) return;
    this.connected = true;
    this.setAuth('authenticated');
    this.emitConnection('connected');
  }

  private aborted(): boolean {
    return this.receiveSignal?.aborted ?? true;
  }

  private setAuth(state: 'unknown' | 'authenticated' | 'failed'): void {
    if (this.authState === state) return;
    this.authState = state;
    this.emitAuth(state);
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
