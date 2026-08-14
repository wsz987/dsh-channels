/**
 * WeixinChannelAdapter — direct Tencent Weixin iLink client.
 *
 * Maps the iLink protocol to the stable Channel Contract:
 * - start(): load credential -> unauthenticated if missing; else restore sync
 *   cursor + context tokens -> notifyStart (best effort) -> start monitor.
 * - send(): build the real sendmessage payload via OutboundSender.
 * - beginAuth/pollAuth/submitVerifyCode: QR login.
 * - stop(): abort monitor -> notifyStop (best effort).
 *
 * Endpoint knowledge lives behind the {@link ILinkClient}; this adapter owns
 * lifecycle and credential wiring only.
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
import { ILinkClient } from './ilink/client.js';
import type { HttpTransport } from './transport.js';
import { FetchTransport } from './transport.js';
import { AccountCredentialStore } from './auth/account-store.js';
import { WeixinQrAuth } from './auth/login.js';
import { SyncCursorStore } from './storage/sync-cursor.js';
import { ContextTokenStore } from './storage/context-token.js';
import { WeixinMonitor } from './messaging/monitor.js';
import { OutboundSender } from './messaging/send.js';
import { TypingController } from './messaging/typing.js';
import { downloadMedia } from './media/download.js';
import { manifest as weixinManifest, type WeixinManifest } from './manifest.js';
import type { ILinkCDNMedia, ILinkMessageItem } from './ilink/types.js';
import type { ImagePart, MessagePart } from '@dsh/channel-core';

export interface WeixinAdapterDeps {
  /** Injectable transport (tests); defaults to FetchTransport. */
  transport?: HttpTransport;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable random source for X-WECHAT-UIN (tests). */
  rand?: () => number;
}

export class WeixinAdapter implements ChannelAdapter {
  readonly id = 'weixin';

  /** Upstream compatibility manifest (read structurally by `channels doctor`). */
  readonly manifest: WeixinManifest = weixinManifest;

  readonly capabilities: ChannelCapabilities = {
    text: true,
    image: true,
    file: false,
    audio: false,
    video: false,
    markdown: false,
    cards: false,
    reactions: false,
    threads: false,
    streaming: 'buffered',
  };

  private readonly config: WeixinConfig;
  private readonly now: () => number;
  private readonly rand: () => number;
  private readonly transport: HttpTransport;

  private client?: ILinkClient;
  private qrAuth?: WeixinQrAuth;
  private credentialStore?: AccountCredentialStore;
  private cursorStore?: SyncCursorStore;
  private contextTokens?: ContextTokenStore;
  private sender?: OutboundSender;
  private monitor?: WeixinMonitor;
  private typing?: TypingController;
  /** Cached per-peer typing ticket (from getconfig). */
  private readonly typingTickets = new Map<string, string>();
  /** Peer the current ticket resolution is scoped to (single-flight turns). */
  private typingPeer?: string;

  private ctx?: ChannelAdapterContext;
  private started = false;
  private connected = false;
  private readonly startedAt: number;

  constructor(config: WeixinConfig, deps: WeixinAdapterDeps = {}) {
    this.config = config;
    this.now = deps.now ?? Date.now;
    this.rand = deps.rand ?? Math.random;
    this.transport = deps.transport ?? new FetchTransport({ timeoutMs: config.network?.timeoutMs ?? 15000 });
    this.startedAt = this.now();
  }

  private requireStarted(): void {
    if (!this.started || !this.client || !this.ctx) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'weixin adapter is not started');
    }
  }

  async start(ctx: ChannelAdapterContext): Promise<void> {
    if (this.started) return;
    this.ctx = ctx;

    const ilink = this.config.ilink ?? { baseUrl: 'https://ilinkai.weixin.qq.com' };
    this.client = new ILinkClient(
      {
        baseUrl: ilink.baseUrl,
        cdnBaseUrl: ilink.cdnBaseUrl,
        timeoutMs: this.config.network?.timeoutMs ?? 15000,
        longPollTimeoutMs: this.config.network?.longPollTimeoutMs ?? 35000,
        botAgent: ilink.botAgent ?? 'DeepSeekHarness/0.8.1',
        transport: this.transport,
        now: this.now,
        rand: this.rand,
      },
      this.config.accountId,
    );

    this.credentialStore = new AccountCredentialStore({
      secrets: ctx.secrets,
      storage: ctx.storage,
      accountId: this.config.accountId,
      now: this.now,
    });
    this.cursorStore = new SyncCursorStore({ storage: ctx.storage, accountId: this.config.accountId });
    this.contextTokens = new ContextTokenStore({ storage: ctx.storage, accountId: this.config.accountId });

    // The outbound path is always wired so `send()` can work even before a
    // credential is configured (the protocol omits the Authorization header).
    this.sender = new OutboundSender({
      client: this.client!,
      contextTokens: this.contextTokens,
      cdnBaseUrl: this.client!.cdnUrl,
      apiBaseUrl: this.client!.baseUrl,
    });

    // Best-effort typing controller (WX6). Typing ticket is fetched lazily via
    // getconfig and cached per peer; not configured means the indicator stays off.
    this.typing = new TypingController({
      client: this.client!,
      enabled: true,
      typingTicket: () => this.resolveTypingTicket(this.typingPeer),
    });

    const credential = await this.credentialStore.load();
    if (!credential) {
      // Unauthenticated: allow beginAuth/pollAuth flow to configure later.
      this.started = true;
      this.emitConnection('disconnected');
      return;
    }

    this.client.setToken(credential.token);
    if (credential.baseUrl) this.client.setBaseUrl(credential.baseUrl);

    // notifyStart best effort, then start the monitor.
    await this.startMonitor(ctx);

    this.started = true;
  }

  /** Start the getUpdates monitor with the currently-wired credential. */
  private async startMonitor(ctx: ChannelAdapterContext): Promise<void> {
    if (this.monitor) return;
    const monitor = new WeixinMonitor({
      client: this.client!,
      cursor: this.cursorStore!,
      contextTokens: this.contextTokens!,
      ctx,
      meta: { channel: this.id as never, accountId: this.config.accountId },
      reconnect: this.config.reconnect ?? { enabled: true, baseDelayMs: 2000, maxDelayMs: 30000 },
      longPollTimeoutMs: this.config.network?.longPollTimeoutMs ?? 35000,
      dedupWindowMs: 30_000,
      now: this.now,
      onConnectionChange: (state) => this.onConnectionChange(state),
      emit: async (event) => {
        // WX5.1 image: download + decrypt local bytes before dispatch so the
        // harness receives a genuine image attachment.
        await this.enrichInboundMedia(event);
        await ctx.emit(event);
      },
    });
    this.monitor = monitor;
    this.connected = true;
    await monitor.start();
  }

  /**
   * Download + decrypt inbound image parts and attach the plaintext bytes to
   * the mapped event's message content. Non-image parts are left untouched and
   * any download failure silently keeps the URL-only part (text fallback —
   * media download must never break message delivery).
   */
  private async enrichInboundMedia(event: {
    message: { content: MessagePart[] };
    raw?: unknown;
  }): Promise<void> {
    if (!this.client) return;
    const raw = event.raw as { item_list?: ILinkMessageItem[] } | undefined;
    const items = raw?.item_list ?? [];
    const parts = event.message.content;
    const cdnBaseUrl = this.client.cdnUrl;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as ImagePart | undefined;
      if (!part || part.type !== 'image') continue;
      const item = items[i];
      const img = item?.image_item;
      const media: ILinkCDNMedia | undefined = img?.media;
      if (!media) continue;
      try {
        const downloaded = await downloadMedia(media, {
          cdnBaseUrl,
          aesKey: img?.aeskey,
          mimeType: part.mimeType ?? 'image/jpeg',
        });
        part.localData = new Uint8Array(downloaded.data);
        part.mimeType = downloaded.mimeType ?? part.mimeType ?? 'image/jpeg';
      } catch {
        // best effort — keep the URL-only image part (text placeholder fallback).
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    const monitor = this.monitor;
    if (monitor) {
      try {
        await monitor.stop();
      } catch {
        // best effort
      }
    }
    this.monitor = undefined;
    this.started = false;
    this.connected = false;
  }

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    this.requireStarted();
    if (!this.sender) {
      throw new ChannelError('CHANNEL_SEND_FAILED', 'weixin adapter is not authenticated');
    }
    return this.sender.send(target, message);
  }

  /** Begin QR login and return the Channel Contract AuthChallenge. */
  async beginAuth(): Promise<AuthChallenge> {
    this.requireStartedForAuth();
    return this.qrAuth!.beginAuth();
  }

  /** Poll the active QR challenge. */
  async pollAuth(challenge: AuthChallenge): Promise<AuthStatePoll> {
    this.requireStartedForAuth();
    const result = await this.qrAuth!.pollAuth(challenge);
    if (result.state === 'authenticated') {
      await this.persistCredentialFromAuth();
    }
    return result;
  }

  /** Submit a phone-verify code for the active QR challenge (adapter-specific). */
  submitVerifyCode(code: string): void {
    this.requireStartedForAuth();
    this.qrAuth!.submitVerifyCode(code);
  }

  async getHealth(): Promise<ChannelHealth> {
    if (!this.started) {
      return { status: 'down', detail: 'weixin adapter is not started', authenticated: false };
    }
    if (!this.credentialStore) {
      return { status: 'down', detail: 'weixin adapter is not initialized', authenticated: false };
    }
    const credential = await this.credentialStore.load().catch(() => undefined);
    const authenticated = Boolean(credential?.token);
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

  /** Expose the underlying client (tests introspection). */
  get_iLinkClient(): ILinkClient | undefined {
    return this.client;
  }

  /** Best-effort typing start (WX6). Failures never break the main flow. */
  async startTyping(conversationId: string): Promise<void> {
    if (!this.typing) return;
    this.typingPeer = conversationId;
    try {
      await this.typing.start(conversationId);
    } catch {
      // best effort
    }
  }

  /** Best-effort typing stop (WX6). Failures never break the main flow. */
  async stopTyping(conversationId: string): Promise<void> {
    if (!this.typing) return;
    this.typingPeer = conversationId;
    try {
      await this.typing.stop(conversationId);
    } catch {
      // best effort
    }
  }

  /** Resolve + cache a per-peer typing ticket via getconfig (best effort). */
  private async resolveTypingTicket(peer?: string): Promise<string | undefined> {
    if (!peer || !this.client) return undefined;
    const cached = this.typingTickets.get(peer);
    if (cached) return cached;
    try {
      const config = await this.client.getConfig({ ilink_user_id: peer });
      if (config.typing_ticket) {
        this.typingTickets.set(peer, config.typing_ticket);
        return config.typing_ticket;
      }
    } catch {
      // best effort — no ticket means the indicator silently no-ops upstream.
    }
    return undefined;
  }

  /** Persist the QR-confirmed credential into the store. */
  private async persistCredentialFromAuth(): Promise<void> {
    const credential = this.qrAuth!.confirmedCredential;
    if (!credential || !this.credentialStore) return;
    await this.credentialStore.save({
      token: credential.token,
      ilinkBotId: credential.ilinkBotId,
      userId: credential.userId,
      baseUrl: credential.baseUrl || this.client!.baseUrl,
      savedAt: new Date(this.now()).toISOString(),
    });
    this.client!.setToken(credential.token);
    this.client!.setBaseUrl(credential.baseUrl || this.client!.baseUrl);
    // (Re)wire the send path now that we have a token.
    if (!this.sender && this.contextTokens) {
      this.sender = new OutboundSender({ client: this.client!, contextTokens: this.contextTokens, runId: undefined });
    }
    // Start the monitor after a fresh QR login.
    if (this.started && this.ctx) {
      await this.startMonitor(this.ctx);
    }
  }

  private requireStartedForAuth(): void {
    if (!this.ctx || !this.client) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'weixin adapter is not started');
    }
    if (!this.qrAuth) {
      this.qrAuth = new WeixinQrAuth({ client: this.client, now: this.now });
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
