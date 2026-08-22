/**
 * WeixinChannelAdapter — maps the Weixin upstream facade to the stable Channel
 * Contract.
 *
 * This adapter holds ONLY the Channel-contract lifecycle + credential wiring:
 *   - start(): wired the upstream host env (secrets/storage/ctx) -> load
 *     credential -> unauthenticated if missing; else start the monitor.
 *   - send(): map an OutboundMessage to upstream.sendText / sendImage.
 *   - beginAuth/pollAuth/submitVerifyCode: QR login via the upstream facade.
 *   - stop(): stop the monitor.
 *
 * Endpoint knowledge (iLink endpoints, AES, getuploadurl, CDN query assembly)
 * lives inside the upstream facade layer — this adapter NEVER touches AES or
 * getuploadurl details (plan DoD #1 / §78). The upstream is the
 * `WeixinUpstream` port from `./upstream`.
 */
import type {
  AuthChallenge,
  AuthInput,
  AuthStatePoll,
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelCapabilities,
  ChannelHealth,
  ChannelTarget,
  OutboundMessage,
  SendResult,
  ImagePart,
  FilePart,
  VideoPart,
} from '@wsz987/channel-core';
import { ChannelError, collectText } from '@wsz987/channel-core';
import { redactMessage } from './ilink/errors.js';
import type { WeixinConfig } from './config.js';
import type { HttpTransport } from './transport.js';
import { createWeixinUpstream } from './upstream/index.js';
import type { WeixinUpstream } from './upstream/port.js';
import { manifest as weixinManifest, type WeixinManifest } from './manifest.js';

export interface WeixinAdapterDeps {
  /** Injectable transport (tests); defaults to FetchTransport. */
  transport?: HttpTransport;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable random source for X-WECHAT-UIN (tests). */
  rand?: () => number;
  /**
   * Injectable upstream (tests / plan §96). Defaults to the real
   * [createWeixinUpstream]. When supplied, the adapter drives this fake as its
   * protocol boundary.
   */
  upstream?: AdapterUpstreamLike;
}

/**
 * The upstream surface the adapter actually consumes. Narrower than the full
 * port to keep the fake easy to construct in tests.
 */
export type AdapterUpstreamLike = (
  & Pick<WeixinUpstream,
      | 'id' | 'beginQrAuth' | 'pollQrAuth' | 'submitVerifyCode'
      | 'sendText' | 'sendImage' | 'sendFile' | 'sendVideo'
      | 'downloadImage' | 'downloadFile' | 'downloadAudio' | 'downloadVideo' | 'hasCredential'>
  & {
    bind(env: import('./upstream/port.js').WeixinUpstreamHostEnv): void;
    loadCredential(): Promise<boolean>;
    startMonitor(): Promise<void>;
    stopMonitor(): Promise<void>;
    startTyping(peer: string): Promise<void>;
    stopTyping(peer: string): Promise<void>;
    getHealthInfo(): Promise<{ authenticated: boolean; connection: string }>;
    get_iLinkClient(): unknown;
  }
);

export class WeixinAdapter implements ChannelAdapter {
  readonly id = 'weixin';

  /** Upstream compatibility manifest (read structurally by `channels doctor`). */
  readonly manifest: WeixinManifest = weixinManifest;

  readonly capabilities: ChannelCapabilities = {
    text: true,
    image: true,
    file: true,
    audio: false,
    video: true,
    markdown: false,
    cards: false,
    reactions: false,
    threads: false,
    streaming: 'buffered',
  };

  private readonly config: WeixinConfig;
  private readonly upstream: AdapterUpstreamLike;

  private ctx?: ChannelAdapterContext;
  private started = false;
  private connected = false;
  private readonly startedAt: number;

  constructor(config: WeixinConfig, deps: WeixinAdapterDeps = {}) {
    this.config = config;
    this.startedAt = deps.now ? deps.now() : Date.now();
    this.upstream = deps.upstream ?? createWeixinUpstream({
      config,
      transport: deps.transport,
      now: deps.now,
      rand: deps.rand,
    });
  }

  private requireStarted(): void {
    if (!this.started || !this.ctx) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'weixin adapter is not started');
    }
  }

  async start(ctx: ChannelAdapterContext): Promise<void> {
    if (this.started) return;
    this.ctx = ctx;

    this.upstream.bind({
      ctx,
      secrets: ctx.secrets,
      storage: ctx.storage,
      onConnectionChange: (state) => this.onConnectionChange(state),
    });

    // Unauthenticated: allow beginAuth/pollAuth flow to configure later.
    const hasCredential = await this.upstream.loadCredential();
    if (!hasCredential) {
      this.started = true;
      this.emitConnection('disconnected');
      return;
    }

    await this.startMonitor(ctx);
    this.started = true;
  }

  /** Start the getUpdates monitor with the currently-wired credential. */
  private async startMonitor(ctx: ChannelAdapterContext): Promise<void> {
    await this.upstream.startMonitor();
    this.connected = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.upstream.stopMonitor();
    this.started = false;
    this.connected = false;
  }

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    this.requireStarted();
    const to = target.conversationId;
    const runId = target.runId;

    const media = outboundMediaParts(message.parts);
    try {
      if (hasUnsupportedMediaPart(message.parts)) {
        throw new ChannelError('CHANNEL_UNSUPPORTED', 'weixin outbound media requires local bytes; voice is not supported');
      }
      const text = message.text ?? collectText(message.parts ?? []);
      let result: SendResult | undefined;
      if (media.length > 0 && text) {
        result = await this.upstream.sendText({ to, runId, text });
      }
      for (const part of media) {
        if (part.type === 'image') {
          result = await this.upstream.sendImage({
            to,
            runId,
            data: part.localData,
            mimeType: part.mimeType,
          });
        } else if (part.type === 'file') {
          result = await this.upstream.sendFile({
            to,
            runId,
            data: part.localData,
            fileName: part.name ?? 'attachment',
            mimeType: part.mimeType,
          });
        } else {
          result = await this.upstream.sendVideo({
            to,
            runId,
            data: part.localData,
            mimeType: part.mimeType,
          });
        }
      }
      return result ?? this.upstream.sendText({ to, runId, text });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      throw new ChannelError('CHANNEL_SEND_FAILED', redactMessage(messageText), { cause: error });
    }
  }

  /** Begin QR login and return the Channel Contract AuthChallenge. */
  async beginAuth(): Promise<AuthChallenge> {
    this.requireStartedForAuth();
    const ticket = await this.upstream.beginQrAuth();
    return {
      id: ticket.id,
      instruction: ticket.instruction ?? '请使用微信扫描二维码',
      qrUrl: ticket.qrUrl,
      expiresAt: ticket.expiresAt,
    };
  }

  /** Poll the active QR challenge. */
  async pollAuth(challenge: AuthChallenge): Promise<AuthStatePoll> {
    this.requireStartedForAuth();
    const poll = await this.upstream.pollQrAuth(challenge.id);
    if (poll.state === 'authenticated') {
      // Persist the fresh credential on the upstream + (re)wire the sender.
      return { state: 'authenticated', detail: poll.detail };
    }
    return { state: poll.state, detail: poll.detail };
  }

  /** Submit a phone-verify code for the active QR challenge (adapter-specific). */
  submitVerifyCode(code: string): void {
    this.requireStartedForAuth();
    this.upstream.submitVerifyCode(code);
  }

  /** Generic auth-input hook: maps verification-code inputs to submitVerifyCode. */
  submitAuthInput(_challenge: AuthChallenge, input: AuthInput): void {
    if (input.kind === 'verification-code') {
      this.submitVerifyCode(input.value);
    }
  }

  async getHealth(): Promise<ChannelHealth> {
    if (!this.started) {
      return { status: 'down', detail: 'weixin adapter is not started', authenticated: false };
    }
    const info = await this.upstream.getHealthInfo();
    const { authenticated } = info;
    if (!authenticated) {
      return { status: 'down', detail: 'weixin not authenticated', connection: 'disconnected', authenticated: false };
    }
    return {
      status: this.connected ? 'ok' : 'degraded',
      detail: this.connected ? 'connected' : 'authenticated but receive loop down',
      connection: this.connected ? 'connected' : 'disconnected',
      authenticated: true,
    };
  }

  /** Expose the underlying upstream (tests introspection). */
  get_iLinkClient(): unknown {
    return this.upstream.get_iLinkClient();
  }

  /** Best-effort typing start (WX6). Failures never break the main flow. */
  async startTyping(conversationId: string): Promise<void> {
    await this.upstream.startTyping(conversationId);
  }

  /** Best-effort typing stop (WX6). Failures never break the main flow. */
  async stopTyping(conversationId: string): Promise<void> {
    await this.upstream.stopTyping(conversationId);
  }

  private requireStartedForAuth(): void {
    if (!this.ctx) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'weixin adapter is not started');
    }
  }

  private emitConnection(state: 'connected' | 'reconnecting' | 'disconnected'): void {
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

  private onConnectionChange(state: 'connected' | 'reconnecting' | 'disconnected'): void {
    this.connected = state === 'connected';
    this.emitConnection(state);
  }
}

type WeixinOutboundMediaPart = (ImagePart | FilePart | VideoPart) & { localData: Uint8Array };

function outboundMediaParts(parts: OutboundMessage['parts']): WeixinOutboundMediaPart[] {
  if (!parts) return [];
  return parts.filter((part): part is WeixinOutboundMediaPart =>
    (part.type === 'image' || part.type === 'file' || part.type === 'video') &&
    part.localData !== undefined &&
    part.localData.byteLength > 0,
  );
}

/** True when the message carries unsupported or non-uploadable media. */
function hasUnsupportedMediaPart(parts: OutboundMessage['parts']): boolean {
  if (!parts) return false;
  return parts.some((p) =>
    p.type === 'audio' ||
    ((p.type === 'image' || p.type === 'file' || p.type === 'video') && (!p.localData || p.localData.byteLength === 0)),
  );
}

/** Minimal token redaction for send-failure messages (no pattern dependency here). */
function redactSafe(message: string): string {
  return message.replace(/(token|authorization|aes_key|context_token)/gi, '<redacted>');
}
