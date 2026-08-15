/**
 * Lark channel adapter.
 *
 * Maps the Lark/Feishu platform (through the upstream driver) to the Channel
 * Contract. All network/lifecycle resources live behind the upstream driver
 * and are aborted via the adapter context signal. The adapter never touches
 * Harness Agent APIs.
 *
 * The upstream driver is selected by `config.upstream.mode`:
 * - 'sdk'     → `LarkSdkUpstream`: inbound via the official
 *   `@larksuiteoapi/node-sdk` WS long-connection, outbound via the official
 *   OpenAPI client (`LarkOpenApiOutbound`) — no localhost gateway. The WS
 *   client comes from `deps.sdkClient` / `deps.sdkClientFactory`, the OpenAPI
 *   client from `deps.openApiClient` / `deps.openApiClientFactory`, each
 *   defaulting to a real client built from the RESOLVED `deps.appId` / `deps.appSecret`,
 *   resolved via ctx.credentials (the adapter never reads secrets from config).
 *   Missing credentials fail start loudly, not construction.
 * - 'gateway' → `HttpLarkUpstream` over the transport (legacy).
 *
 * Auth is connection-state driven: the upstream driver owns the platform
 * credentials, so the adapter derives its auth state from the connection
 * (connected → authenticated). `beginAuth`/`pollAuth` are intentionally not
 * implemented in M3 — a real OAuth/code flow can slot in later.
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
import { ChannelError } from '@wsz987/channel-core';
import { Client, Domain, WSClient } from '@larksuiteoapi/node-sdk';
import type { LarkConfig } from './config.js';
import { FetchTransport, type HttpTransport } from './transport.js';
import { HttpLarkUpstream, type LarkOutbound, type LarkUpstream } from './upstream.js';
import {
  LarkSdkUpstream,
  type LarkSdkClient,
  type LarkSdkUpstreamOptions,
} from './lark-sdk-upstream.js';
import { LarkOpenApiOutbound, type LarkOpenApiClient } from './openapi-outbound.js';
import { InboundProcessor } from './inbound.js';
import { OutboundSender } from './outbound.js';
import { LarkCardReply } from './card.js';
import { manifest as larkManifest, type LarkManifest } from './manifest.js';

export interface LarkAdapterDeps {
  transport?: HttpTransport;
  /**
   * Resolved Lark AppId for SDK mode (the plugin resolves it via
   * `ctx.credentials` and hands it in; direct config never carries it).
   */
  appId?: string;
  /**
   * Resolved Lark AppSecret for SDK mode (resolved via `ctx.credentials` by
   * the plugin; never present in profile config / logs).
   */
  appSecret?: string;
  /**
   * Pre-built WS long-connection client for SDK mode (offline tests).
   * Overrides `sdkClientFactory`; when neither is given a real `WSClient`
   * is built from `appId`/`appSecret` at start time.
   */
  sdkClient?: LarkSdkClient;
  /** Lazy WS client factory for SDK mode; overrides the default WSClient. */
  sdkClientFactory?: (config: LarkConfig) => LarkSdkClient;
  /**
   * Pre-built official OpenAPI client for SDK-mode outbound (offline tests).
   * Overrides `openApiClientFactory`; when neither is given a real `Client`
   * is built from `appId`/`appSecret` at start time.
   */
  openApiClient?: LarkOpenApiClient;
  /** Lazy OpenAPI client factory for SDK-mode outbound. */
  openApiClientFactory?: (config: LarkConfig) => LarkOpenApiClient;
  /** Injectable clock (tests). */
  now?: () => number;
}

export class LarkAdapter implements ChannelAdapter {
  readonly id = 'lark';

  /** Upstream compatibility manifest (read structurally by `channels doctor`). */
  readonly manifest: LarkManifest = larkManifest;

  readonly capabilities: ChannelCapabilities = {
    text: true,
    image: true,
    file: true,
    audio: true,
    video: false,
    markdown: true,
    cards: true,
    reactions: false,
    threads: true,
    streaming: 'edit',
  };

  private ctx?: ChannelAdapterContext;
  /** Built in `start()` (driver selection needs the resolved deps/credentials). */
  private upstream!: LarkUpstream;
  private readonly transport: HttpTransport;
  private readonly deps: LarkAdapterDeps;
  private inbound!: InboundProcessor;
  private outbound!: OutboundSender;
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

  constructor(private readonly config: LarkConfig, deps: LarkAdapterDeps = {}) {
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
      throw new ChannelError('CHANNEL_NOT_STARTED', 'lark adapter is not started');
    }
    return this.outbound.send(target, message);
  }

  async createReply(target: ChannelTarget, _options?: CreateReplyOptions): Promise<ReplyHandle> {
    if (!this.started || !this.ctx) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'lark adapter is not started');
    }
    return new LarkCardReply({
      upstream: this.upstream,
      target,
      logger: this.ctx.logger,
      createOnFirstDelta: this.config.card.createOnFirstDelta,
      now: this.now,
    });
  }

  async getHealth(): Promise<ChannelHealth> {
    if (!this.started) {
      return { status: 'down', detail: 'lark adapter is not started', authenticated: false };
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
    if (this.config.upstream.mode !== 'sdk') {
      this.upstream = new HttpLarkUpstream({
        transport: this.transport,
        longPollTimeoutMs: this.config.longPollTimeoutMs,
      });
      return;
    }
    const options: LarkSdkUpstreamOptions = {
      client: this.resolveSdkClient(),
      outbound: this.resolveOpenApiOutbound(),
      onConnected: () => this.markConnected(),
    };
    this.upstream = new LarkSdkUpstream(options);
  }

  /** Select the official OpenAPI outbound driver for SDK mode. */
  private resolveOpenApiOutbound(): LarkOutbound {
    if (this.deps.openApiClient) {
      return new LarkOpenApiOutbound({ client: this.deps.openApiClient });
    }
    if (this.deps.openApiClientFactory) {
      return new LarkOpenApiOutbound({ client: this.deps.openApiClientFactory(this.config) });
    }
    return new LarkOpenApiOutbound({
      client: createDefaultOpenApiClient(this.deps.appId, this.deps.appSecret, this.config),
    });
  }

  private resolveSdkClient(): LarkSdkClient {
    if (this.deps.sdkClient) return this.deps.sdkClient;
    if (this.deps.sdkClientFactory) return this.deps.sdkClientFactory(this.config);
    return createDefaultWSClient(this.deps.appId, this.deps.appSecret, this.config);
  }

  private async runReceiveLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped && !this.aborted()) {
      try {
        await this.upstream.receive(this.receiveSignal!, (raw) => {
          void this.inbound.handle(raw).catch((error) => {
            this.ctx!.logger.error('[channel-lark] inbound handling failed', error);
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
          this.ctx!.logger.warn('[channel-lark] reconnect budget exhausted');
          this.setAuth('failed');
          this.emitConnection('disconnected');
          break;
        }
        const delay = Math.min(
          this.config.reconnect.baseDelayMs * 2 ** Math.min(attempt - 1, 8),
          this.config.reconnect.maxDelayMs,
        );
        this.ctx!.logger.warn(`[channel-lark] receive loop error; retry in ${delay}ms`, error);
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

/** Build the real SDK WS client from resolved credentials; never logs them. */
function createDefaultWSClient(
  appId: string | undefined,
  appSecret: string | undefined,
  config: LarkConfig,
): LarkSdkClient {
  if (!appId || !appSecret) {
    throw new ChannelError(
      'CHANNEL_ERROR',
      'lark upstream mode "sdk" requires resolved appId and appSecret credentials',
    );
  }
  return new WSClient({
    appId,
    appSecret,
    domain: resolveDomain(config.upstream.domain ?? 'feishu'),
  });
}

/** Build the real SDK OpenAPI client from resolved credentials; never logs them. */
function createDefaultOpenApiClient(
  appId: string | undefined,
  appSecret: string | undefined,
  config: LarkConfig,
): LarkOpenApiClient {
  if (!appId || !appSecret) {
    throw new ChannelError(
      'CHANNEL_ERROR',
      'lark upstream mode "sdk" requires resolved appId and appSecret credentials',
    );
  }
  return new Client({
    appId,
    appSecret,
    domain: resolveDomain(config.upstream.domain ?? 'feishu'),
  });
}

/**
 * Resolve a config domain string to the SDK's `Domain` enum, preserving a
 * custom base domain verbatim (the SDK accepts `Domain | string`).
 */
export function resolveDomain(value: string): Domain | string {
  if (value === 'feishu') return Domain.Feishu;
  if (value === 'lark') return Domain.Lark;
  return value;
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