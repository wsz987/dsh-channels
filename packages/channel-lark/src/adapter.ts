/**
 * Lark channel adapter.
 *
 * Maps the Lark/Feishu platform (through the OFFICIAL `@larksuiteoapi/node-sdk`
 * driver stack) to the Channel Contract. All network/lifecycle resources live
 * behind the upstream driver and are aborted via the adapter context signal.
 * The adapter never touches Harness Agent APIs.
 *
 * The upstream is ALWAYS the official SDK:
 * - inbound → `LarkSdkUpstream`: WSClient + EventDispatcher
 *   (`im.message.receive_v1` + `card.action.trigger`), outbound delegated to
 *   the official OpenAPI client (`LarkOpenApiOutbound`). The WS client comes
 *   from `deps.sdkClient` / `deps.sdkClientFactory`, the OpenAPI client from
 *   `deps.openApiClient` / `deps.openApiClientFactory`, each defaulting to a
 *   real client built from the RESOLVED `deps.appId` / `deps.appSecret`,
 *   resolved via ctx.credentials (the adapter never reads secrets from config).
 *   Missing credentials fail start loudly, not construction.
 *
 * There is no transport injection and no gateway: offline tests inject fake
 * WS + OpenAPI clients instead.
 *
 * Auth is connection-state driven: the upstream driver owns the platform
 * credentials, so the adapter derives its auth state from the connection
 * (connected → authenticated).
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
import type { LarkOutbound, LarkUpstream } from './upstream.js';
import {
  LarkSdkUpstream,
  type LarkSdkClient,
  type LarkSdkUpstreamOptions,
} from './lark-sdk-upstream.js';
import { LarkOpenApiOutbound, type LarkOpenApiClient } from './openapi-outbound.js';
import { LarkOpenApiMediaPort, type LarkMediaClient, type LarkMediaPort } from './upstream/media-port.js';
import { InboundProcessor } from './inbound.js';
import { OutboundSender } from './outbound.js';
import { LarkCardReply } from './card.js';
import { manifest as larkManifest, type LarkManifest } from './manifest.js';

export interface LarkAdapterDeps {
  /**
   * Resolved Lark AppId (a plain config string resolved by the plugin and
   * handed in for the default client builders; never a secret).
   */
  appId?: string;
  /**
   * Resolved Lark AppSecret (resolved via `ctx.credentials` by the plugin;
   * never present in profile config / logs).
   */
  appSecret?: string;
  /**
   * Pre-built WS long-connection client (offline tests). Overrides
   * `sdkClientFactory`; when neither is given a real `WSClient` is built from
   * `appId`/`appSecret` at start time.
   */
  sdkClient?: LarkSdkClient;
  /** Lazy WS client factory; overrides the default WSClient. */
  sdkClientFactory?: (config: LarkConfig) => LarkSdkClient;
  /**
   * Pre-built official OpenAPI client (offline tests). Overrides
   * `openApiClientFactory`; when neither is given a real `Client` is built
   * from `appId`/`appSecret` at start time.
   */
  openApiClient?: LarkOpenApiClient;
  /** Lazy OpenAPI client factory. */
  openApiClientFactory?: (config: LarkConfig) => LarkOpenApiClient;
  /**
   * Injectable media port for inbound media hydration. When absent, the
   * adapter builds a default LarkOpenApiMediaPort from the same resolved
   * OpenAPI client used for outbound.
   */
  mediaPort?: LarkMediaPort;
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
    interactiveActions: true,
    reactions: true,
    threads: true,
    streaming: 'edit',
    // Directional media precision. Inbound: image/file/audio/video are all
    // hydrated to real bytes before emit — the official `message.resource`
    // API documents audio/video downloads, so every binary kind the mapper
    // produces routes its file_key through `messageResource.get` into
    // localData. Outbound: image (`sendMedia` → im.image.create) and file
    // (`sendFile` → im.file.create) upload real bytes; there is no audio/video
    // send path — audio/video outbound parts fall back to `[audio]`/`[video]`
    // text placeholders, so outbound audio/video are 'unsupported'.
    media: {
      inbound: {
        image: 'bytes',
        file: 'bytes',
        audio: 'bytes',
        video: 'bytes',
      },
      outbound: {
        image: 'bytes',
        file: 'bytes',
        audio: 'unsupported',
        video: 'unsupported',
      },
    },
  };

  private ctx?: ChannelAdapterContext;
  /** Built in `start()` (driver selection needs the resolved deps/credentials). */
  private upstream!: LarkUpstream;
  private readonly deps: LarkAdapterDeps;
  private inbound!: InboundProcessor;
  private outbound!: OutboundSender;
  /** Media port used for inbound media hydration (built in start). */
  private mediaPort?: LarkMediaPort;
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
  }

  async start(ctx: ChannelAdapterContext): Promise<void> {
    if (this.started) return;
    this.ctx = ctx;
    this.stopped = false;
    this.buildUpstream();
    this.stopController = new AbortController();
    this.receiveSignal = AbortSignal.any([ctx.signal, this.stopController.signal]);
    this.mediaPort = this.resolveMediaPort();
    this.inbound = new InboundProcessor({
      ctx,
      meta: { channel: this.id as never, accountId: this.config.accountId as never },
      dedupEnabled: this.config.dedup.enabled,
      dedupWindowMs: this.config.dedup.windowMs,
      now: this.now,
      mediaPort: this.mediaPort,
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

  async edit(target: ChannelTarget, messageId: string, message: OutboundMessage): Promise<SendResult> {
    if (!this.started || !this.outbound) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'lark adapter is not started');
    }
    return this.outbound.edit(target, messageId, message);
  }

  async startTypingForTarget(target: ChannelTarget): Promise<void> {
    if (this.config.card.typingIndicator === false || !target.replyToMessageId) return;
    await this.upstream.startTyping?.(String(target.replyToMessageId));
  }

  async stopTypingForTarget(target: ChannelTarget): Promise<void> {
    if (this.config.card.typingIndicator === false || !target.replyToMessageId) return;
    await this.upstream.stopTyping?.(String(target.replyToMessageId));
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

  /** WS long-connection receive loop with exponential backoff on failure. */
  startReceiveLoop(): void {
    if (this.receiveLoop) return;
    this.receiveLoop = this.runReceiveLoop();
  }

  /** Build the official-SDK upstream driver. */
  private buildUpstream(): void {
    const outbound = this.resolveOpenApiOutbound();
    const options: LarkSdkUpstreamOptions = {
      client: this.resolveSdkClient(),
      outbound,
      resolveChatType: (conversationId) => outbound.getChatType?.(conversationId) ?? Promise.resolve(undefined),
      onConnected: () => this.markConnected(),
    };
    this.upstream = new LarkSdkUpstream(options);
  }

  /** Select the official OpenAPI outbound driver. */
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

  /**
   * Select the media port for inbound media hydration. An explicit dep wins;
   * otherwise the adapter builds a default `LarkOpenApiMediaPort` from the
   * same resolved OpenAPI client used for outbound.
   */
  private resolveMediaPort(): LarkMediaPort | undefined {
    if (this.deps.mediaPort) return this.deps.mediaPort;
    // The resolved client is the real SDK `Client`, which structurally
    // satisfies the wider `LarkMediaClient` surface (message resource + image
    // + file). When a caller injects a fake typed only as `LarkOpenApiClient`,
    // hydration still safely degrades: a missing messageResource surfaces as
    // a runtime failure that the hydrator marks.
    const client = this.deps.openApiClient
      ?? (this.deps.openApiClientFactory && this.deps.openApiClientFactory(this.config))
      ?? createDefaultOpenApiClient(this.deps.appId, this.deps.appSecret, this.config);
    return new LarkOpenApiMediaPort({ client: client as unknown as LarkMediaClient });
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
        // follows the connection state (the driver owns credentials). The WS
        // driver reports connectivity via onConnected.
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
      'lark upstream requires resolved appId and appSecret credentials',
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
      'lark upstream requires resolved appId and appSecret credentials',
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
