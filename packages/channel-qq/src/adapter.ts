/**
 * QQ channel adapter — maps the Tencent SDK to the Channel Contract.
 *
 * The SDK owns Token acquisition/refresh, the WebSocket gateway (hello /
 * identify / heartbeat / RESUME / reconnect) and the OpenAPI REST surface.
 * The adapter only registers lifecycle handlers (`ready`/`resumed`/`error`/
 * `message`) and drives `start`/`stop`. It never runs its own receive or
 * reconnect loop (no double reconnect, no backoff).
 *
 * Streaming is target-aware: C2C + triggering `replyToMessageId` → native
 * (`createReply` → `QQStreamingReply`); everywhere else → buffered (reply
 * router accumulates and sends once at `turn/end`).
 *
 * The QQ AppSecret never lives in config: it is resolved via `ctx.credentials`
 * by the plugin (`appSecretRef`) and handed to the adapter as
 * `deps.appSecret`. Missing credential → startup fails loudly (QQ-R5).
 */
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelCapabilities,
  ChannelHealth,
  ChannelTarget,
  OutboundMessage,
  ReplyHandle,
  SendResult,
  StreamingMode,
} from '@wsz987/channel-core';
import { ChannelError, SecureRemoteMediaFetcher } from '@wsz987/channel-core';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { QQConfig } from './config.js';
import { InboundProcessor } from './inbound.js';
import { OutboundSender } from './outbound.js';
import { TencentQQSdkClient, type QQSdkClient } from './sdk-client.js';
import { QQStreamingReply } from './streaming-reply.js';
import { manifest as qqManifest, type QQManifest } from './manifest.js';

export interface QQAdapterDeps {
  /** SDK client (tests inject the Fake). Defaults to a real Tencent client. */
  sdkClient?: QQSdkClient;
  /** Resolved QQ AppSecret credential value (injected by the plugin). Tests using the Fake client may omit it. */
  appSecret?: string;
  /**
   * Optional secure remote media fetcher used to hydrate inbound image bytes
   * before emit (plan §23 / §79A). Tests inject a fake so the inbound path is
   * fully offline; production defaults to a real `SecureRemoteMediaFetcher`.
   * Configurable here (not in config) because it is a low-level seam, not a
   * user-facing knob.
   */
  secureFetch?: SecureRemoteMediaFetcher;
  /** Injectable clock (tests). */
  now?: () => number;
}

export class QQAdapter implements ChannelAdapter {
  readonly id = 'qq';

  /** Upstream compatibility manifest (read structurally by `channels doctor`). */
  readonly manifest: QQManifest = qqManifest;
  readonly capabilities: ChannelCapabilities;

  /**
   * Test-only accessor exposing the injected `appSecret` so unit tests can
   * assert the resolved credential reached the adapter without triggering the
   * real Tencent client build. Produces no value in any production path.
   */
  get testAppSecret(): string | undefined {
    return this.deps.appSecret;
  }

  private ctx?: ChannelAdapterContext;
  private readonly deps: QQAdapterDeps;
  private readonly now: () => number;
  private client!: QQSdkClient;
  private inbound!: InboundProcessor;
  private outbound!: OutboundSender;
  private started = false;
  private connected = false;
  private error?: Error;
  private runPromise?: Promise<void>;

  constructor(private readonly config: QQConfig, deps: QQAdapterDeps = {}) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.capabilities = {
      text: true,
      image: true,
      file: true,
      audio: true,
      video: true,
      markdown: config.markdownSupport,
      cards: false,
      reactions: false,
      threads: false,
      // Conservative default; `resolveStreamingMode` upgrades C2C+msgId to
      // native streaming.
      streaming: 'buffered',
    };
  }

  resolveStreamingMode(target: ChannelTarget): StreamingMode {
    // `streaming.enabled: false` is a hard off-switch: it forces the buffered
    // send-once strategy even for a C2C target with a reply message id.
    if (!this.config.streaming.enabled) {
      return 'buffered';
    }
    if (target.conversationType === 'dm' && target.replyToMessageId) {
      return 'native';
    }
    return 'buffered';
  }

  async start(ctx: ChannelAdapterContext): Promise<void> {
    if (this.started) return;
    this.ctx = ctx;
    this.connected = false;
    this.error = undefined;

    const ready = createDeferred<void>();

    this.client =
      this.deps.sdkClient ??
      new TencentQQSdkClient(this.config, ctx.logger, requireAppSecret(this.deps.appSecret, this.config));

    this.inbound = new InboundProcessor({
      ctx,
      meta: { channel: this.id as never, accountId: this.config.accountId as never },
      dedupEnabled: this.config.dedup.enabled,
      dedupWindowMs: this.config.dedup.windowMs,
      secureFetch: this.deps.secureFetch,
      now: this.now,
    });
    this.outbound = new OutboundSender(this.client, ctx.logger);

    this.client.onReady(() => {
      this.connected = true;
      void this.emitAuth('authenticated');
      void this.emitConnection('connected');
      ready.resolve();
    });

    this.client.onResumed(() => {
      this.connected = true;
      void this.emitConnection('connected');
    });

    this.client.onError((error) => {
      this.handleSdkError(error);
    });

    this.client.onMessage((message) => {
      void this.handleInbound(message);
    });

    // Never `await bot.start()` inline — it resolves only on stop/abort and
    // would block the Cordis plugin init. Track the raw promise and surface
    // failures through `handleSdkError`.
    this.runPromise = this.client.start(ctx.signal);

    // Fail-fast (QQ-R14): `tokenPrefetch: 'sync'` makes the SDK reject on bad
    // credentials before `ready`. Propagate that rejection to the startup
    // deferred instead of letting it hang until the timeout, and still record
    // the error for health/event reporting.
    this.runPromise.catch((error) => {
      this.handleSdkError(error);
      ready.reject(error);
    });

    try {
      await withTimeout(ready.promise, this.config.startupTimeoutMs);
      this.started = true;
    } catch (error) {
      // Rollback: stop the (possibly half-started) SDK client and settle the
      // run promise so a failed start never leaks a live client behind a
      // `started === false` adapter.
      this.client.stop();
      await this.runPromise?.catch(() => undefined);
      this.runPromise = undefined;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started && this.runPromise === undefined) return;
    this.started = false;
    this.connected = false;
    this.client.stop();
    await this.runPromise?.catch(() => undefined);
    this.runPromise = undefined;
    void this.emitConnection('closed');
  }

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    if (!this.started || !this.outbound) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'qq adapter is not started');
    }
    return this.outbound.send(target, message);
  }

  async createReply(target: ChannelTarget): Promise<ReplyHandle> {
    if (target.conversationType !== 'dm' || !target.replyToMessageId) {
      throw new ChannelError(
        'CHANNEL_ERROR',
        'QQ native streaming requires a C2C reply target with message id',
      );
    }
    const stream = this.client.openStream(
      { scope: 'c2c', targetId: target.conversationId, msgId: target.replyToMessageId },
      { throttleMs: this.config.streaming.throttleMs },
    );
    return new QQStreamingReply(stream);
  }

  async getHealth(): Promise<ChannelHealth> {
    if (!this.started) {
      return { status: 'down', detail: 'qq adapter is not started', authenticated: false };
    }
    if (this.error) {
      return {
        status: 'degraded',
        detail: 'sdk error',
        connection: this.connected ? 'connected' : 'disconnected',
        authenticated: this.connected,
        error: this.error.message,
      };
    }
    if (this.connected) {
      return {
        status: 'ok',
        detail: 'connected',
        connection: 'connected',
        authenticated: true,
      };
    }
    return {
      status: 'degraded',
      detail: 'sdk not ready',
      connection: 'disconnected',
      authenticated: false,
    };
  }

  private handleSdkError(error: Error): void {
    this.error = error;
    this.connected = false;
    this.ctx?.logger.error('[channel-qq] sdk error', error);
    void this.emitConnection('disconnected');
  }

  private handleInbound(message: QQBotInboundMessage): Promise<void> {
    return this.inbound.handle(message);
  }

  private emitAuth(state: 'authenticated' | 'expired' | 'failed' | 'pending' | 'unknown'): Promise<void> {
    if (!this.ctx) return Promise.resolve();
    return this.ctx
      .emit({
        type: 'auth.changed',
        channel: this.id as never,
        accountId: this.config.accountId as never,
        state,
      })
      .then(() => undefined);
  }

  private emitConnection(state: 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'closed'): Promise<void> {
    if (!this.ctx) return Promise.resolve();
    return this.ctx
      .emit({
        type: 'connection.changed',
        channel: this.id as never,
        accountId: this.config.accountId as never,
        state,
      })
      .then(() => undefined);
  }
}

/** Minimal deferred primitive. */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Resolve a promise or reject after `timeoutMs`. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ChannelError('CHANNEL_START_FAILED', 'qq adapter startup timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Fail loudly when the resolved QQ AppSecret credential is missing/empty —
 * the adapter must not construct a real Tencent client with an empty secret
 * (v1.1 QQ-R5). The Fake client path never reaches this helper.
 */
function requireAppSecret(appSecret: string | undefined, config: QQConfig): string {
  if (!appSecret) {
    throw new ChannelError(
      'CHANNEL_ERROR',
      `QQ credential "${config.appSecretRef}" is not configured`,
    );
  }
  return appSecret;
}
