/**
 * tencent-upstream.ts — DSH-hosted Weixin iLink source-port.
 *
 * Tencent's published @tencent-weixin/openclaw-weixin plugin couples its
 * runtime to OpenClaw. It is retained as a source reference only: importing
 * its internal dist paths or installing its OpenClaw peer dependency would
 * violate the DSH host boundary. Protocol orchestration and AES therefore stay
 * in this adapter behind the WeixinUpstream port.
 *
 * ZERO-REGRESSION contract (plan §78):
 *   Weixin image → localData → saveImage() → ImageBlock unchanged.
 *   downloadImage() returns the SAME decrypted bytes legacy media/download.ts
 *   produced. URL resolution keeps the legacy shape because the Tencent plugin
 *   uses a different URL form that would alter the working CDN path.
 */
import {
  ChannelError,
  SecureRemoteMediaFetcher,
  mimeHintFromFilename,
  type ChannelAdapterContext,
  type AuthChallenge,
  type ChannelTarget,
} from '@wsz987/channel-core';
import type { FetchLike } from '@wsz987/channel-core';
import type { MessagePart } from '@wsz987/channel-core';
import pkg from '../../package.json' with { type: 'json' };
import type { WeixinConfig } from '../config.js';
import { ILinkClient, type ILinkClientOptions } from '../ilink/client.js';
import type { HttpTransport } from '../transport.js';
import { FetchTransport } from '../transport.js';
import { AccountCredentialStore } from '../auth/account-store.js';
import { WeixinQrAuth } from '../auth/login.js';
import { SyncCursorStore } from '../storage/sync-cursor.js';
import { ContextTokenStore } from '../storage/context-token.js';
import { WeixinMonitor } from '../messaging/monitor.js';
import { OutboundSender } from '../messaging/send.js';
import { TypingController } from '../messaging/typing.js';
import { WeixinConfigManager } from './config-manager.js';
import { transcodeSilkVoice } from '../media/silk-transcode.js';
import type {
  WeixinUpstream,
  WeixinUpstreamHostEnv,
  WeixinQrTicket,
  WeixinQrAuthPoll,
  WeixinAuthCredential,
  WeixinMediaRef,
  WeixinDownloadResult,
  WeixinTextParams,
  WeixinImageParams,
  WeixinFileParams,
  WeixinVideoParams,
  WeixinSendResult,
  WeixinSendTarget,
} from './port.js';
import { aes128Decrypt } from '../media/decrypt.js';
import type { ILinkCDNMedia, ILinkMessageItem } from '../ilink/types.js';

/** Connection state surfaced to the host (mirrors the monitor's own notion). */
export type WeixinConnectionState =
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'not-started';

/** Options to construct a [TencentWeixinUpstream]. */
export interface WeixinUpstreamOptions {
  config: WeixinConfig;
  transport?: HttpTransport;
  now?: () => number;
  rand?: () => number;
  /** Injectable fetch for media download (tests); defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable shared secure downloader (tests); defaults to the core boundary. */
  mediaFetcher?: SecureRemoteMediaFetcher;
}

/** Matches the generic channel attachment store's inbound transport cap. */
const MAX_INBOUND_MEDIA_BYTES = 100 * 1024 * 1024;

/**
 * The concrete upstream implementation. Owns every protocol/media detail; the
 * adapter depends only on the `WeixinUpstream` port.
 */
export class TencentWeixinUpstream implements WeixinUpstream {
  readonly id = 'weixin';

  private readonly config: WeixinConfig;
  private readonly now: () => number;
  private readonly rand: () => number;
  private readonly transport: HttpTransport;
  private readonly mediaFetcher: SecureRemoteMediaFetcher;

  private env?: WeixinUpstreamHostEnv;
  private client?: ILinkClient;
  private credentialStore?: AccountCredentialStore;
  private cursorStore?: SyncCursorStore;
  private contextTokens?: ContextTokenStore;
  private qrAuth?: WeixinQrAuth;
  private sender?: OutboundSender;
  private monitor?: WeixinMonitor;
  private typing?: TypingController;
  private configManager?: WeixinConfigManager;
  private typingPeer?: string;
  private connected: WeixinConnectionState = 'not-started';
  /** Whether a credential is loaded/persisted (the adapter's "authenticated"). */
  private authenticated = false;
  /** Active QR ticket id + expiry, so pollAuth can rebuild the challenge. */
  private activeQrId?: string;
  private activeQrExpiresAt?: number;

  constructor(options: WeixinUpstreamOptions) {
    this.config = options.config;
    this.now = options.now ?? Date.now;
    this.rand = options.rand ?? Math.random;
    this.transport = options.transport ?? new FetchTransport({ timeoutMs: options.config.network?.timeoutMs ?? 15000 });
    this.mediaFetcher = options.mediaFetcher ?? new SecureRemoteMediaFetcher({
      fetch: (options.fetchImpl ?? globalThis.fetch) as unknown as FetchLike,
    });
  }

  /**
   * Wire the host environment (stores + context) and build the internal
   * protocol session. Called by the adapter at start(); idempotent.
   */
  bind(env: WeixinUpstreamHostEnv): void {
    if (this.env && this.env.ctx === env.ctx) return;
    this.env = env;
    const ilink = this.config.ilink ?? { baseUrl: 'https://ilinkai.weixin.qq.com' };
    const clientOpts: ILinkClientOptions = {
      baseUrl: ilink.baseUrl,
      cdnBaseUrl: ilink.cdnBaseUrl,
      timeoutMs: this.config.network?.timeoutMs ?? 15000,
      longPollTimeoutMs: this.config.network?.longPollTimeoutMs ?? 35000,
      botAgent: ilink.botAgent ?? 'DeepSeekHarness/' + pkg.version,
      transport: this.transport,
      now: this.now,
      rand: this.rand,
    };
    this.client = new ILinkClient(clientOpts, this.config.accountId);
    this.credentialStore = new AccountCredentialStore({
      secrets: env.secrets,
      storage: env.storage,
      accountId: this.config.accountId,
      now: this.now,
    });
    this.cursorStore = new SyncCursorStore({ storage: env.storage, accountId: this.config.accountId });
    this.contextTokens = new ContextTokenStore({ storage: env.storage, accountId: this.config.accountId });
    this.sender = new OutboundSender({
      client: this.client,
      contextTokens: this.contextTokens,
      cdnBaseUrl: this.client.cdnUrl,
      apiBaseUrl: this.client.baseUrl,
    });
    this.configManager = new WeixinConfigManager({
      fetchConfig: (peer) => this.client!.getConfig({ ilink_user_id: peer }),
      now: this.now,
      rand: this.rand,
    });
    this.typing = new TypingController({
      client: this.client,
      enabled: true,
      typingTicket: () => this.resolveTypingTicket(this.typingPeer),
    });
  }

  hasCredential(): boolean {
    return this.authenticated;
  }

  /**
   * Load the persisted credential, applying token/baseUrl to the client.
   * Returns true when a full credential exists. This is the adapter's "have we
   * authenticated before?" signal.
   */
  async loadCredential(): Promise<boolean> {
    const store = this.credentialStore;
    const client = this.client;
    if (!store || !client) return false;
    const credential = await store.load();
    if (!credential) return false;
    client.setToken(credential.token);
    if (credential.baseUrl) client.setBaseUrl(credential.baseUrl);
    this.authenticated = true;
    this.configManager?.clear();
    return true;
  }

  // ── QR auth (WeixinQrAuth — DSH glue over the iLink client) ──
  async beginQrAuth(): Promise<WeixinQrTicket> {
    this.ensureSession();
    const storedCredential = await this.credentialStore?.load();
    this.qrAuth = new WeixinQrAuth({
      client: this.client!,
      localTokens: storedCredential?.token ? [storedCredential.token] : [],
      now: this.now,
    });
    const challenge = await this.qrAuth.beginAuth();
    this.activeQrId = challenge.id;
    this.activeQrExpiresAt = challenge.expiresAt;
    return {
      id: challenge.id,
      qrUrl: challenge.qrUrl,
      instruction: challenge.instruction,
      expiresAt: challenge.expiresAt,
    };
  }

  async pollQrAuth(ticketId: string): Promise<WeixinQrAuthPoll> {
    this.ensureSession();
    if (!this.qrAuth) throw new ChannelError('CHANNEL_AUTH_FAILED', 'weixin QR auth is not started');
    // WeixinQrAuth only inspects challenge.id + expiresAt; instruction is unused
    // for the poll path (the adapter owns the operator-facing prompt).
    const challenge: AuthChallenge = { id: ticketId, instruction: '', expiresAt: this.activeQrExpiresAt };
    const result = await this.qrAuth.pollAuth(challenge);
    if (result.state === 'authenticated') {
      const cred = this.qrAuth.confirmedCredential;
      if (cred) {
        await this.persistCredential({
          token: cred.token,
          ilinkBotId: cred.ilinkBotId,
          userId: cred.userId,
          baseUrl: cred.baseUrl,
        });
      } else {
        // `binded_redirect` confirms a locally-held token is still associated
        // with this bot. Reapply it because a prior stale-token transition
        // intentionally cleared the in-memory client token.
        const stored = await this.credentialStore?.load();
        if (stored) {
          this.client?.setToken(stored.token);
          this.client?.setBaseUrl(stored.baseUrl);
          this.authenticated = true;
          this.configManager?.clear();
          if (!this.monitor) await this.startMonitor();
        }
      }
      return { state: 'authenticated', detail: result.detail, credential: cred ?? undefined };
    }
    return { state: result.state, detail: result.detail };
  }

  submitVerifyCode(code: string): void {
    this.ensureSession();
    if (!this.qrAuth) throw new ChannelError('CHANNEL_AUTH_FAILED', 'weixin QR auth is not started');
    this.qrAuth.submitVerifyCode(code);
  }

  // ── Monitor ──
  async startMonitor(): Promise<void> {
    this.ensureSession();
    if (this.monitor) return;
    const ctx = this.env!.ctx;
    const monitor = new WeixinMonitor({
      client: this.client!,
      cursor: this.cursorStore!,
      contextTokens: this.contextTokens!,
      ctx,
      meta: { channel: 'weixin' as never, accountId: this.config.accountId },
      reconnect: this.config.reconnect ?? { enabled: true, baseDelayMs: 2000, maxDelayMs: 30000 },
      longPollTimeoutMs: this.config.network?.longPollTimeoutMs ?? 35000,
      dedupWindowMs: 30_000,
      now: this.now,
      onConnectionChange: (st) => {
        this.connected = st;
        this.env?.onConnectionChange?.(st);
      },
      onStaleToken: async () => {
        this.authenticated = false;
        this.connected = 'disconnected';
        this.monitor = undefined;
        this.client?.setToken(undefined);
        this.configManager?.clear();
        await ctx.emit({
          type: 'auth.changed',
          channel: 'weixin' as never,
          accountId: this.config.accountId as never,
          state: 'expired',
          detail: 'weixin token expired; scan QR to authenticate again',
        });
      },
      beforeEmit: async (event) => {
        // Download + decrypt inbound media before dispatch so image and file
        // parts can enter the common Harness attachment pipeline.
        await this.enrichInboundMedia(event);
      },
      emit: (event) => ctx.emit(event),
    });
    this.monitor = monitor;
    this.connected = 'connected';
    await monitor.start();
  }

  async stopMonitor(): Promise<void> {
    const monitor = this.monitor;
    if (monitor) {
      try {
        await monitor.stop();
      } catch {
        // best effort
      }
    }
    this.monitor = undefined;
    this.connected = 'disconnected';
  }

  // ── Send ──
  async sendText(params: WeixinTextParams): Promise<WeixinSendResult> {
    this.requireReady();
    const res = await this.sender!.send(this.targetOf(params), { text: params.text });
    return res;
  }

  async sendImage(params: WeixinImageParams): Promise<WeixinSendResult> {
    this.requireReady();
    const image: MessagePart = {
      type: 'image',
      localData: params.data,
      mimeType: params.mimeType,
    };
    return this.sender!.send(this.targetOf(params), { parts: [image] });
  }

  async sendFile(params: WeixinFileParams): Promise<WeixinSendResult> {
    this.requireReady();
    return this.sender!.send(this.targetOf(params), {
      parts: [{ type: 'file', localData: params.data, name: params.fileName, mimeType: params.mimeType }],
    });
  }

  async sendVideo(params: WeixinVideoParams): Promise<WeixinSendResult> {
    this.requireReady();
    return this.sender!.send(this.targetOf(params), {
      parts: [{ type: 'video', localData: params.data, mimeType: params.mimeType }],
    });
  }

  // ── Media download ──
  async downloadImage(ref: WeixinMediaRef): Promise<WeixinDownloadResult> {
    const data = await this.downloadAndDecrypt(ref);
    return { data, mimeType: ref.mimeType ?? guessImageMime(data) };
  }

  async downloadFile(ref: WeixinMediaRef): Promise<WeixinDownloadResult> {
    const data = await this.downloadAndDecrypt(ref);
    return { data, mimeType: ref.mimeType };
  }

  async downloadAudio(
    ref: WeixinMediaRef,
    options: { encodeType?: number; sampleRate?: number } = {},
  ): Promise<WeixinDownloadResult> {
    const data = Buffer.from(await this.downloadAndDecrypt(ref));
    const decoded = await transcodeSilkVoice(data, options);
    return { data: new Uint8Array(decoded.data), mimeType: decoded.mimeType };
  }

  async downloadVideo(ref: WeixinMediaRef): Promise<WeixinDownloadResult> {
    const data = await this.downloadAndDecrypt(ref);
    return { data, mimeType: ref.mimeType ?? 'video/mp4' };
  }

  // ── Typing (operational, not part of the minimal port) ──
  async startTyping(conversationId: string): Promise<void> {
    if (!this.typing) return;
    this.typingPeer = conversationId;
    try {
      await this.typing.start(conversationId);
    } catch {
      // best effort
    }
  }

  async stopTyping(conversationId: string): Promise<void> {
    if (!this.typing) return;
    this.typingPeer = conversationId;
    try {
      await this.typing.stop(conversationId);
    } catch {
      // best effort
    }
  }

  /** Health introspection (bound credential + connection). */
  async getHealthInfo(): Promise<{ authenticated: boolean; connection: WeixinConnectionState }> {
    if (!this.credentialStore || !this.client) {
      return { authenticated: false, connection: 'not-started' };
    }
    const credential = await this.credentialStore.load().catch(() => undefined);
    return { authenticated: Boolean(credential?.token) && this.authenticated, connection: this.connected };
  }

  /** Introspection for tests: the underlying client. */
  get_iLinkClient(): ILinkClient | undefined {
    return this.client;
  }

  // ── Internals ──

  private ensureSession(): void {
    if (!this.env) throw new ChannelError('CHANNEL_NOT_STARTED', 'weixin upstream is not bound; call bind() first');
    if (!this.client) throw new ChannelError('CHANNEL_NOT_STARTED', 'weixin upstream protocol session is not initialised');
  }

  private requireReady(): void {
    this.ensureSession();
    if (!this.sender) throw new ChannelError('CHANNEL_NOT_STARTED', 'weixin upstream is not initialised');
    if (!this.authenticated) throw new ChannelError('CHANNEL_AUTH_FAILED', 'weixin is not authenticated; scan QR to continue');
  }

  private targetOf(params: WeixinSendTarget): ChannelTarget {
    return {
      channelId: 'weixin' as never,
      accountId: this.config.accountId as never,
      conversationId: params.to as never,
      runId: params.runId,
    };
  }

  private async persistCredential(cred: WeixinAuthCredential): Promise<void> {
    if (!this.credentialStore || !this.client) return;
    await this.credentialStore.save({
      token: cred.token,
      ilinkBotId: cred.ilinkBotId,
      userId: cred.userId,
      baseUrl: cred.baseUrl || this.client.baseUrl,
      savedAt: new Date(this.now()).toISOString(),
    });
    this.client.setToken(cred.token);
    this.client.setBaseUrl(cred.baseUrl || this.client.baseUrl);
    this.authenticated = true;
    this.configManager?.clear();
    if (!this.sender && this.contextTokens && this.client) {
      this.sender = new OutboundSender({ client: this.client, contextTokens: this.contextTokens });
    }
    // Start the monitor for a fresh QR login once the env is bound and the
    // adapter has started (mirrors the old persistCredentialFromAuth).
    if (this.env && !this.monitor) {
      await this.startMonitor();
    }
  }

  /** Hydrate inbound media before the event reaches the attachment pipeline. */
  private async enrichInboundMedia(event: { message: { content: MessagePart[] }; raw?: unknown }): Promise<void> {
    if (!this.client) return;
    const raw = event.raw as { item_list?: ILinkMessageItem[] } | undefined;
    const items = raw?.item_list ?? [];
    const parts = event.message.content;
    const cdnBaseUrl = this.client.cdnUrl;

    const consumedItems = new Set<number>();
    for (const part of parts) {
      if (part.type !== 'image' && part.type !== 'file' && part.type !== 'audio' && part.type !== 'video') continue;
      const itemIndex = items.findIndex((candidate, index) =>
        !consumedItems.has(index) && itemMatchesPart(candidate, part.type),
      );
      if (itemIndex < 0) continue;
      consumedItems.add(itemIndex);
      const item = items[itemIndex];
      const img = item?.image_item;
      const file = item?.file_item;
      const voice = item?.voice_item;
      const video = item?.video_item;
      const media = (img?.media ?? file?.media ?? voice?.media ?? video?.media) as ILinkCDNMedia | undefined;
      if (!media) continue;
      try {
        const ref: WeixinMediaRef = {
          cdnBaseUrl,
          fullUrl: media.full_url,
          encryptQueryParam: media.encrypt_query_param,
          aesKeyHex: img?.aeskey,
          aesKeyBase64: media.aes_key,
          mimeType: part.mimeType ?? (
            part.type === 'file'
              ? mimeHintFromFilename(file?.file_name)
              : part.type === 'video'
                ? 'video/mp4'
                : part.type === 'image'
                  ? 'image/jpeg'
                  : undefined
          ),
        };
        const downloaded = part.type === 'image'
          ? await this.downloadImage(ref)
          : part.type === 'file'
            ? await this.downloadFile(ref)
            : part.type === 'audio'
              ? await this.downloadAudio(ref, { encodeType: voice?.encode_type, sampleRate: voice?.sample_rate })
              : await this.downloadVideo(ref);
        part.localData = downloaded.data;
        part.mimeType = downloaded.mimeType ?? part.mimeType;
        if (part.type === 'file') part.size = downloaded.data.byteLength;
      } catch (error) {
        // Keep delivery alive, but expose the reason. In practice this catches
        // malformed CDN keys and expired media URLs; hiding it makes a file
        // look like a Harness storage failure even though ingress failed.
        this.env?.ctx.logger.warn('[channel-weixin] inbound media download failed', {
          kind: part.type,
          name: part.type === 'file' ? part.name : undefined,
          error: error instanceof Error ? error.message : String(error),
        });
        part.ingressFailure = 'download-failed';
      }
    }
  }

  /**
   * Resolve the platform media reference, then cross the shared secure remote
   * media boundary before applying Weixin's source-port AES decryption.
   */
  private async downloadAndDecrypt(ref: WeixinMediaRef): Promise<Uint8Array> {
    const url = this.resolveDownloadUrl(ref);
    if (!url) {
      throw new Error('weixin media download: no fullUrl or encryptQueryParam to resolve a CDN URL');
    }
    const result = await this.mediaFetcher.fetchBounded(url, {
      maxBytes: MAX_INBOUND_MEDIA_BYTES,
      timeoutMs: this.config.network?.timeoutMs ?? 15_000,
      idleTimeoutMs: this.config.network?.timeoutMs ?? 15_000,
      signal: this.env?.ctx.signal,
    });
    const body = Buffer.from(result.data);
    const key = this.resolveAesKey(ref);
    if (!key) return new Uint8Array(body);
    // Official AES-128-ECB decrypt (PKCS#7) — source of truth for crypto.
    return new Uint8Array(aes128Decrypt(body, key));
  }

  private resolveDownloadUrl(ref: WeixinMediaRef): string | undefined {
    if (ref.fullUrl) return ref.fullUrl;
    if (!ref.cdnBaseUrl || !ref.encryptQueryParam) return undefined;
    // Match Tencent's upstream fallback when the server omits full_url.
    const base = ref.cdnBaseUrl.replace(/\/+$/, '');
    return `${base}/download?encrypted_query_param=${encodeURIComponent(ref.encryptQueryParam)}`;
  }

  /** Resolve the AES-128 key honoring hex (item aeskey) then base64 (media aes_key). */
  private resolveAesKey(ref: WeixinMediaRef): Buffer | undefined {
    if (ref.aesKeyHex) return Buffer.from(ref.aesKeyHex, 'hex');
    if (ref.aesKeyBase64) {
      // Tencent sends images as base64(raw 16 bytes), while file/voice/video
      // may be base64(32 ASCII hex chars). Accept both wire encodings.
      const decoded = Buffer.from(ref.aesKeyBase64, 'base64');
      if (decoded.length === 16) return decoded;
      const hex = decoded.toString('ascii');
      if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(hex)) return Buffer.from(hex, 'hex');
      throw new Error(`weixin media download: aes_key decoded to ${decoded.length} bytes, expected 16 bytes or 32-char hex`);
    }
    return undefined;
  }

  private async resolveTypingTicket(peer?: string): Promise<string | undefined> {
    return this.configManager?.resolveTypingTicket(peer);
  }
}

function itemMatchesPart(item: ILinkMessageItem | undefined, type: MessagePart['type']): boolean {
  return (type === 'image' && item?.type === 2)
    || (type === 'audio' && item?.type === 3)
    || (type === 'file' && item?.type === 4)
    || (type === 'video' && item?.type === 5);
}

/** Cheap JPEG/PNG/WebP/GIF sniff for the default mime when none is supplied. */
function guessImageMime(data: Uint8Array): string | undefined {
  if (data.length < 12) return undefined;
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif';
  if (
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) return 'image/webp';
  return undefined;
}
