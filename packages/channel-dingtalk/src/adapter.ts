/**
 * DingTalk channel adapter.
 *
 * Maps the DingTalk platform (through the upstream driver) to the Channel
 * Contract. All network/lifecycle resources live behind the upstream driver
 * and are aborted via the adapter context signal. The adapter never touches
 * Harness Agent APIs.
 *
 * The upstream driver is selected by `config.upstream.mode`:
 * - 'sdk'     → `DingTalkStreamUpstream`: inbound via the official
 *   `dingtalk-stream` SDK, outbound via DingTalk's official HTTP APIs. The stream
 *   client comes from `deps.sdkClient` / `deps.sdkClientFactory`, defaulting
 *   to a real `DWClient` built from `upstream.clientId` (AppKey) and the
 *   resolved AppSecret at start time (missing credentials fail start loudly).
 *   The AppSecret is resolved via `ctx.credentials` and injected as
 *   `deps.clientSecret` — it never lives in config and is never read from
 *   `config.upstream` (mirrors how channel-qq injects `deps.appSecret`).
 * - 'gateway' → `HttpDingTalkUpstream` over the transport (legacy).
 *
 * Auth is connection-state driven: the upstream driver owns the platform
 * credentials, so the adapter derives its auth state from the connection
 * (connected → authenticated). `beginAuth`/`pollAuth` are intentionally not
 * implemented in M2 — a real QR/token flow can slot in later.
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
} from '@wsz987/channel-core';
import { ChannelError, SecureRemoteMediaFetcher } from '@wsz987/channel-core';
import type { RemoteMediaFetchLike } from './image-hydrator.js';
import { DWClient } from 'dingtalk-stream';
import type { DingTalkConfig } from './config.js';
import { FetchTransport, type HttpTransport } from './transport.js';
import { HttpDingTalkUpstream, type DingTalkUpstream } from './upstream.js';
import { DingTalkOpenApiPortImpl } from './official-upstream.js';
import type { MediaResolverLike, OutboxCapabilities } from './openapi-port.js';
import {
  DingTalkStreamUpstream,
  type DingTalkStreamClient,
  type DingTalkStreamUpstreamOptions,
} from './stream-upstream.js';
import { InboundProcessor } from './inbound.js';
import { OutboundSender } from './outbound.js';
import { DingTalkCardReply } from './ai-card.js';
import { manifest as dingTalkManifest, type DingTalkManifest } from './manifest.js';

export interface DingTalkAdapterDeps {
  transport?: HttpTransport;
  /**
   * Resolved DingTalk AppSecret (SDK mode). Never from config — the plugin
   * resolves it via `ctx.credentials` (`upstream.clientSecretRef`) and
   * injects it here. Used only to build the default `DWClient`.
   */
  clientSecret?: string;
  /**
   * Pre-built stream client for SDK mode (offline tests). Overrides
   * `sdkClientFactory`; when neither is given a real `DWClient` is built
   * from `config.upstream.clientId` and `deps.clientSecret` at start time.
   */
  sdkClient?: DingTalkStreamClient;
  /** Lazy stream client factory for SDK mode; overrides the default DWClient. */
  sdkClientFactory?: (config: DingTalkConfig) => DingTalkStreamClient;
  /**
   * Secure remote media fetcher used to hydrate inbound image URLs (plan
   * §32A). Injectable for offline tests; defaults to a real
   * `SecureRemoteMediaFetcher` bound to the global fetch.
   */
  secureFetch?: RemoteMediaFetchLike;
  /**
   * DingTalk OpenAPI media resolver used to hydrate opaque file mediaIds into
   * trusted bytes during inbound file ingress (plan §32A / §86). Injectable for
   * offline tests; defaults to the running official port in sdk mode.
   */
  resolveMedia?: MediaResolverLike;
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
  /** Built in `start()` (driver selection needs the resolved deps/credentials). */
  private upstream!: DingTalkUpstream;
  private readonly transport: HttpTransport;
  private readonly deps: DingTalkAdapterDeps;
  private readonly secureFetch: RemoteMediaFetchLike;
  private inbound!: InboundProcessor;
  private outbound!: OutboundSender;
  /**
   * Official OpenAPI port built in sdk mode (proactive path for the outbox).
   * Undefined in gateway mode — proactive capabilities then fail CLOSED.
   */
  private officialPort?: DingTalkOpenApiPortImpl;
  /**
   * Proactive outbox capabilities (plan §71). Read by the harness outbox;
   * fails CLOSED (all-false) in gateway mode / when not wired.
   */
  private capProactive: OutboxCapabilities = { proactiveText: false, proactiveMedia: false };
  private started = false;
  private stopped = false;
  private receiveLoop?: Promise<void>;
  private connected = false;
  /** Connection-state-driven auth; the upstream driver owns credentials. */
  private authState: 'unknown' | 'authenticated' | 'failed' = 'unknown';
  private readonly now: () => number;
  /** Internal stop signal merged with the context signal for prompt teardown. */
  private stopController?: AbortController;
  private receiveSignal?: AbortSignal;

  constructor(private readonly config: DingTalkConfig, deps: DingTalkAdapterDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.deps = deps;
    this.secureFetch = deps.secureFetch ?? new SecureRemoteMediaFetcher();
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
      secureFetch: this.secureFetch,
      resolveMedia: this.deps.resolveMedia ?? this.officialPort,
    });
    // REPLY keeps the sessionWebhook upstream; PROACTIVE uses the official port.
    this.outbound = new OutboundSender({
      reply: this.upstream,
      logger: ctx.logger,
      proactive: this.officialPort,
      capabilities: this.capProactive,
    });

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

  /** Select and build the upstream driver for the configured mode. */
  private buildUpstream(): void {
    const httpUpstream = new HttpDingTalkUpstream({
      transport: this.transport,
      longPollTimeoutMs: this.config.longPollTimeoutMs,
    });
    if (this.config.upstream.mode !== 'sdk') {
      this.upstream = httpUpstream;
      // Gateway mode has no official proactive path — capabilities fail CLOSED.
      this.officialPort = undefined;
      this.capProactive = { proactiveText: false, proactiveMedia: false };
      return;
    }
    // The official OpenAPI port implements BOTH the `DingTalkUpstream` outbound
    // surface (sessionWebhook reply, plan §35) and the `DingTalkOpenApiPort`
    // proactive/media surface (plan §33). Proactive is implemented in sdk mode,
    // so the outbox capabilities are enabled (plan §69: capability true only when
    // actually implemented — never faked).
    this.officialPort = new DingTalkOpenApiPortImpl({
      transport: this.transport,
      clientId: this.config.upstream.clientId,
      clientSecret: this.deps.clientSecret,
      secureFetch: this.secureFetch,
      now: this.now,
    });
    this.capProactive = { proactiveText: true, proactiveMedia: true };
    const options: DingTalkStreamUpstreamOptions = {
      client: this.resolveStreamClient(),
      outbound: this.officialPort,
      onConnected: () => this.markConnected(),
    };
    this.upstream = new DingTalkStreamUpstream(options);
  }

  /**
   * Proactive outbox capabilities (plan §71) exposed for the harness outbox.
   * Fails CLOSED: all-false in gateway mode / when not wired.
   */
  get outboxCapabilities(): OutboxCapabilities {
    return { ...this.capProactive };
  }

  private resolveStreamClient(): DingTalkStreamClient {
    if (this.deps.sdkClient) return this.deps.sdkClient;
    if (this.deps.sdkClientFactory) return this.deps.sdkClientFactory(this.config);
    return createDefaultDWClient(this.config, this.deps.clientSecret);
  }

  private async runReceiveLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped && !this.aborted()) {
      try {
        await this.upstream.receive(this.receiveSignal!, (raw) => {
          void this.inbound.handle(raw).catch((error) => {
            this.ctx!.logger.error('[channel-dingtalk] inbound handling failed', error);
          });
        });
        attempt = 0;
        // A completed receive cycle proves the upstream is reachable; auth
        // follows the connection state (the driver owns credentials). In sdk
        // mode the stream driver also reports connectivity via onConnected.
        this.markConnected();
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

/**
 * Build the real SDK client from SDK-mode credentials; never logs them.
 *
 * Takes the RESOLVED AppSecret (injected by the plugin via ctx.credentials)
 * rather than reading it from config. A missing secret fails start loudly.
 */
function createDefaultDWClient(
  config: DingTalkConfig,
  clientSecret: string | undefined,
): DingTalkStreamClient {
  const { clientId } = config.upstream;
  if (!clientId || !clientSecret) {
    throw new ChannelError(
      'CHANNEL_ERROR',
      'dingtalk upstream mode "sdk" requires resolved clientId and clientSecret credentials',
    );
  }
  const client = new DWClient({ clientId, clientSecret, keepAlive: false });
  // The adapter owns retry/backoff. The SDK otherwise swallows a failed
  // connection and retries independently, which makes health unreliable.
  client.getConfig().autoReconnect = false;
  return client;
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
