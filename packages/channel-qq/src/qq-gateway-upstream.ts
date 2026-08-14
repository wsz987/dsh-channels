/**
 * QQ official-protocol upstream driver (isolated source — no third-party SDK).
 *
 * Implements the QQ 开放平台机器人 WebSocket gateway directly:
 *
 * - Token auth:  POST /app/getAppAccessToken  { appId, clientSecret }
 *   → { access_token, expires_in } (short-lived, ~7200s; refreshed before
 *   expiry — the platform rotates the token within the last 60s).
 * - Gateway:     GET /gateway (Authorization: QQBot <token>) → { url }
 *   (e.g. wss://api.bot.qq.com/websocket/).
 * - WS frames:   Hello (op 10) → Identify (op 2) | Resume (op 6) → Ready /
 *   Resumed (op 0) → heartbeats (op 1, last seq or null) every
 *   heartbeat_interval ms; server ack op 11. Server may send Reconnect
 *   (op 7) / Invalid Session (op 9); the driver reconnects internally with
 *   resume-when-possible (session_id + last seq).
 * - Inbound:     Dispatch (op 0) events C2C_MESSAGE_CREATE /
 *   GROUP_AT_MESSAGE_CREATE (intent GROUP_AND_C2C_EVENT = 1 << 25) are mapped
 *   into the SAME raw shape the gateway long-poll driver produces
 *   ({ type, msgId, eventId, senderId, conversationId, conversationType,
 *   content, ... }), so the existing mapper + dedup pipeline is untouched.
 * - Outbound:    real v2 OpenAPI sends — text via POST /v2/users/{openid}/
 *   messages (C2C) or /v2/groups/{group_openid}/messages (group) with
 *   msg_type 0; media via the URL-upload endpoint /v2/{users|groups}/{id}/
 *   files (file_type from the media kind) then msg_type 7 with
 *   media.file_info. Conversation kind (dm vs group) is learned from inbound
 *   dispatches and defaults to C2C for unknown ids.
 *
 * Platform note: the official docs have migrated from api.sgroup.qq.com to
 * https://api.bot.qq.com (both token and OpenAPI base, and the gateway WSS
 * host). The base URL is configurable and defaults to the current official
 * host.
 *
 * Credentials (appId / clientSecret) and the access token are never logged
 * and never embedded in error messages. Live verification against a real QQ
 * app (AppId/ClientSecret) is a manual step — the offline tests run a local
 * mock gateway (ws WebSocketServer) plus a fake fetch.
 */
import { ChannelError } from '@dsh/channel-core';
import WebSocket from 'ws';
import type { AuthChallengePayload, PollAuthResult, QQMedia, QQUpstream } from './upstream.js';

/** GROUP_AND_C2C_EVENT (1 << 25): C2C + group-@ message events. */
export const QQ_INTENT_GROUP_AND_C2C = 1 << 25;

/** Gateway opcodes (official 通用数据结构 / OpCode 列表). */
export const QQ_OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** Dispatch event names routed into the inbound pipeline. */
export const QQ_EVENT_C2C_MESSAGE_CREATE = 'C2C_MESSAGE_CREATE';
export const QQ_EVENT_GROUP_AT_MESSAGE_CREATE = 'GROUP_AT_MESSAGE_CREATE';

/** Close codes that invalidate the session (fresh identify required). */
const NON_RESUMABLE_CLOSE_CODES = new Set([4006, 4007, 4010, 4011, 4012, 4013, 4014]);

/** Internal signal used to trigger a driver-level reconnect. */
class QQReconnectError extends Error {}

/**
 * Minimal structural WebSocket client surface consumed by the driver. The
 * real `ws` client satisfies it via `createDefaultGatewayClient`; tests
 * inject a fake without a network.
 */
export interface QQGatewayClient {
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (error: Error) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

/** Default `QQGatewayClient` backed by the `ws` package. */
export function createDefaultGatewayClient(url: string): QQGatewayClient {
  const socket = new WebSocket(url);
  return {
    get readyState(): number {
      return socket.readyState;
    },
    onOpen: (handler) => socket.on('open', handler),
    onMessage: (handler) => socket.on('message', (data) => handler(data.toString())),
    onClose: (handler) => socket.on('close', (code, reason) => handler(code, reason.toString())),
    onError: (handler) => socket.on('error', (error) => handler(error instanceof Error ? error : new Error(String(error)))),
    send: (data) => socket.send(data),
    close: (code, reason) => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(code, reason);
      }
    },
  };
}

export interface QQGatewayUpstreamOptions {
  /** QQ 开放平台 AppId. SECRET — never logged. */
  appId: string;
  /** QQ 开放平台 ClientSecret. SECRET — never logged. */
  clientSecret: string;
  /** OpenAPI base URL; defaults to the current official host. */
  openApiBaseUrl?: string;
  /** Access-token endpoint path; default `/app/getAppAccessToken`. */
  tokenPath?: string;
  /** Gateway resolution path; default `/gateway`. */
  gatewayPath?: string;
  /** Fixed gateway WSS URL; skips the `/gateway` resolution fetch (tests). */
  gatewayUrl?: string;
  /** Subscribed intents; default GROUP_AND_C2C_EVENT (1 << 25). */
  intents?: number;
  /** Shard tuple; default [0, 1] (no sharding). */
  shard?: [number, number];
  /** Per-request timeout for token/gateway/send calls. */
  requestTimeoutMs?: number;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** WS client factory; defaults to a real `ws` client. */
  gatewayClientFactory?: (url: string) => QQGatewayClient;
  /** Internal reconnect budget before the driver gives up (adapter owns the outer backoff). */
  maxReconnectRetries?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Invoked after a session is established (connection state). */
  onConnected?: () => void;
}

/** One gateway frame (official 通用数据结构 payload). */
export interface QQGatewayFrame {
  op?: number;
  s?: number;
  t?: string;
  /** Envelope event id (dedup fallback). */
  id?: string;
  d?: unknown;
}

/** Parsed message dispatch body (C2C / group-@ events). */
interface QQDispatchData {
  id?: string;
  content?: string;
  timestamp?: string;
  message_type?: number;
  author?: {
    id?: string;
    user_openid?: string;
    member_openid?: string;
    username?: string;
    [key: string]: unknown;
  };
  group_openid?: string;
  attachments?: QQAttachment[];
  ark_data?: { prompt?: string; fields?: { title?: string; [key: string]: unknown }; [key: string]: unknown };
  [key: string]: unknown;
}

interface QQAttachment {
  url?: string;
  filename?: string;
  content_type?: string;
  voice_wav_url?: string;
  [key: string]: unknown;
}

/**
 * Map one dispatch frame into the shared raw shape consumed by the inbound
 * mapper (`{ type, msgId, eventId, senderId, conversationId,
 * conversationType, content, ... }`). Returns `undefined` for non-dispatch
 * or non-message frames.
 */
export function toGatewayRaw(frame: QQGatewayFrame): Record<string, unknown> | undefined {
  if (!frame || typeof frame !== 'object' || frame.op !== QQ_OP.DISPATCH) return undefined;
  const data = frame.d;
  if (!data || typeof data !== 'object') return undefined;
  const d = data as QQDispatchData;
  const raw: Record<string, unknown> = {
    eventId: frame.id,
    seq: frame.s,
  };
  if (frame.t === QQ_EVENT_C2C_MESSAGE_CREATE) {
    const senderId = d.author?.user_openid ?? d.author?.id;
    raw.msgId = d.id;
    raw.senderId = senderId;
    raw.conversationId = senderId;
    raw.conversationType = 'dm';
  } else if (frame.t === QQ_EVENT_GROUP_AT_MESSAGE_CREATE) {
    const senderId = d.author?.member_openid ?? d.author?.id;
    raw.msgId = d.id;
    raw.senderId = senderId;
    raw.conversationId = d.group_openid;
    raw.conversationType = 'group';
  } else {
    return undefined;
  }
  mapBody(d, raw);
  return raw;
}

/** Fill the media/content fields of the raw shape from the dispatch body. */
function mapBody(d: QQDispatchData, raw: Record<string, unknown>): void {
  switch (d.message_type) {
    case 3: // structured card (ARK)
      raw.type = 'link';
      raw.title = d.ark_data?.fields?.title ?? d.ark_data?.prompt ?? d.content;
      raw.content = d.content;
      break;
    default:
      // Plain text (0), quoted (103), parallel (101), history (102) — all
      // carry text in `content`.
      raw.type = 'text';
      raw.content = d.content;
      break;
  }
  // Attachments carry the media: the first attachment becomes the primary
  // part (single-type raw shape — documented limitation for multi-part
  // messages).
  const attachments = d.attachments;
  if (Array.isArray(attachments) && attachments.length > 0) {
    const attachment = attachments[0];
    if (attachment && typeof attachment === 'object') {
      raw.type = attachmentType(attachment.content_type);
      raw.picUrl = attachment.url;
      raw.mediaUrl =
        attachment.content_type === 'voice'
          ? (attachment.voice_wav_url ?? attachment.url)
          : attachment.url;
      raw.title = attachment.filename;
    }
  }
}

/** Map an attachment content_type to the mapper's part type. */
function attachmentType(contentType: string | undefined): string {
  if (contentType === 'voice') return 'audio';
  if (contentType === 'file') return 'file';
  if (contentType?.startsWith('image/')) return 'image';
  if (contentType?.startsWith('video/')) return 'video';
  // Unknown attachment with a URL — surface as a file part (honest fallback).
  return 'file';
}

/** Map the outbound media kind to the v2 files `file_type`. */
function fileTypeFor(type: string): number {
  switch (type) {
    case 'image':
      return 1;
    case 'video':
      return 2;
    case 'audio':
    case 'voice':
      return 3;
    default:
      return 4; // file
  }
}

/**
 * Official-protocol implementation of `QQUpstream`: token auth, gateway
 * connect/identify/heartbeat/reconnect, inbound dispatch mapping, and real
 * v2 outbound sends. QR auth methods are gateway-mode only and reject.
 */
export class QQGatewayUpstream implements QQUpstream {
  private readonly openApiBaseUrl: string;
  private readonly tokenPath: string;
  private readonly gatewayPath: string;
  private readonly gatewayUrl: string | undefined;
  private readonly intents: number;
  private readonly shard: [number, number];
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly gatewayClientFactory: (url: string) => QQGatewayClient;
  private readonly maxReconnectRetries: number;
  private readonly now: () => number;
  private readonly onConnected: (() => void) | undefined;

  /** Cached access token, refreshed before expiry (60s margin). */
  private accessToken?: string;
  private tokenExpiresAt = 0;
  /** Cached gateway WSS URL (stable; refreshed on failure). */
  private resolvedGatewayUrl?: string;
  /** conversationId → 'dm' | 'group', learned from inbound dispatches. */
  private readonly conversationKinds = new Map<string, 'dm' | 'group'>();

  private onMessage?: (raw: unknown) => void;
  private client?: QQGatewayClient;
  private sessionId?: string;
  private lastSeq?: number;
  private heartbeatIntervalMs = 45000;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private msgSeq = 0;
  private lastCloseCode?: number;

  constructor(private readonly options: QQGatewayUpstreamOptions) {
    this.openApiBaseUrl = (options.openApiBaseUrl ?? 'https://api.bot.qq.com').replace(/\/+$/, '');
    this.tokenPath = options.tokenPath ?? '/app/getAppAccessToken';
    this.gatewayPath = options.gatewayPath ?? '/gateway';
    this.gatewayUrl = options.gatewayUrl;
    this.intents = options.intents ?? QQ_INTENT_GROUP_AND_C2C;
    this.shard = options.shard ?? [0, 1];
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.gatewayClientFactory = options.gatewayClientFactory ?? createDefaultGatewayClient;
    this.maxReconnectRetries = options.maxReconnectRetries ?? 3;
    this.now = options.now ?? Date.now;
    this.onConnected = options.onConnected;
  }

  /** QR auth is gateway-mode only — reject loudly. */
  login(): Promise<AuthChallengePayload> {
    return Promise.reject(
      new ChannelError('CHANNEL_ERROR', 'qq upstream mode "sdk" is token-based; QR auth (login) is gateway-only'),
    );
  }

  /** QR auth is gateway-mode only — reject loudly. */
  pollAuth(): Promise<PollAuthResult> {
    return Promise.reject(
      new ChannelError('CHANNEL_ERROR', 'qq upstream mode "sdk" is token-based; QR auth (pollAuth) is gateway-only'),
    );
  }

  /**
   * Run the gateway session until `signal` aborts. Reconnects internally
   * (resume-when-possible) up to `maxReconnectRetries`; persistent failure
   * propagates to the adapter, which owns the outer backoff budget.
   */
  async receive(signal: AbortSignal, onMessage: (raw: unknown) => void): Promise<void> {
    this.onMessage = onMessage;
    let attempt = 0;
    while (!signal.aborted) {
      try {
        await this.runSession(signal);
        return;
      } catch (error) {
        if (signal.aborted) return;
        attempt += 1;
        if (attempt > this.maxReconnectRetries) throw error;
        await sleep(backoffDelay(attempt), signal);
      }
    }
  }

  /** One connection lifecycle: token → gateway url → connect → session. */
  private async runSession(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const token = await this.acquireToken();
    const url = await this.resolveGatewayUrl(token);
    if (signal.aborted) return;

    const client = this.gatewayClientFactory(url);
    this.client = client;
    this.lastCloseCode = undefined;

    const gate = this.attachHandlers(client, token, signal);
    try {
      await gate.ready;
      if (signal.aborted) return;
      this.onConnected?.();
      await gate.disconnected;
      if (signal.aborted) return;
      if (gate.error) throw gate.error;
      throw new QQReconnectError(
        `gateway connection closed (code ${this.lastCloseCode ?? 'unknown'})`,
      );
    } finally {
      this.stopHeartbeat();
      signal.removeEventListener('abort', gate.onAbort);
      client.close();
      this.client = undefined;
    }
  }

  /** Wire the WS client events into the session gate state machine. */
  private attachHandlers(
    client: QQGatewayClient,
    token: string,
    signal: AbortSignal,
  ): {
    ready: Promise<void>;
    disconnected: Promise<void>;
    error: Error | undefined;
    onAbort: () => void;
  } {
    let open = false;
    let readySettled = false;
    let resolveReady: () => void = () => {};
    let rejectReady: (error: Error) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    let resolveDisconnected: () => void = () => {};
    const disconnected = new Promise<void>((resolve) => {
      resolveDisconnected = resolve;
    });
    const gate = {
      ready,
      disconnected,
      error: undefined as Error | undefined,
      onAbort: () => {},
    };

    const settleReady = () => {
      if (readySettled) return;
      readySettled = true;
      resolveReady();
    };
    const failReady = (error: Error) => {
      if (readySettled) return;
      readySettled = true;
      rejectReady(error);
    };

    client.onOpen(() => {
      open = true;
    });
    client.onError((error) => {
      if (!open) failReady(error);
    });
    client.onClose((code, reason) => {
      this.lastCloseCode = code;
      if (!open) {
        failReady(new QQReconnectError(`gateway closed before open (code ${code})`));
      }
      if (NON_RESUMABLE_CLOSE_CODES.has(code)) {
        // Session cannot be resumed — the next connect must identify again.
        this.sessionId = undefined;
      }
      resolveDisconnected();
    });
    client.onMessage((data) => {
      let frame: QQGatewayFrame;
      try {
        frame = JSON.parse(data) as QQGatewayFrame;
      } catch {
        return; // malformed frame — ignore
      }
      try {
        this.handleFrame(frame, token, { settleReady, failReady, disconnect: resolveDisconnected });
      } catch (error) {
        gate.error = error instanceof Error ? error : new Error(String(error));
        client.close();
      }
    });

    const onAbort = () => {
      failReady(new QQReconnectError('aborted'));
      resolveDisconnected();
    };
    gate.onAbort = onAbort;
    signal.addEventListener('abort', onAbort, { once: true });
    return gate;
  }

  /** Handle one gateway frame (Hello/Identify handshake, heartbeats, dispatch). */
  private handleFrame(
    frame: QQGatewayFrame,
    token: string,
    hooks: {
      settleReady: () => void;
      failReady: (error: Error) => void;
      disconnect: () => void;
    },
  ): void {
    switch (frame.op) {
      case QQ_OP.HELLO: {
        const hello = frame.d as { heartbeat_interval?: number } | undefined;
        this.heartbeatIntervalMs = hello?.heartbeat_interval ?? 45000;
        if (this.sessionId !== undefined) {
          this.sendFrame({
            op: QQ_OP.RESUME,
            d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq ?? null },
          });
        } else {
          this.sendFrame({
            op: QQ_OP.IDENTIFY,
            d: {
              token: `QQBot ${token}`,
              intents: this.intents,
              shard: this.shard,
              properties: { $os: 'linux', $browser: 'dsh-channel-qq', $device: 'dsh-channel-qq' },
            },
          });
        }
        return;
      }
      case QQ_OP.DISPATCH: {
        if (frame.s !== undefined) this.lastSeq = frame.s;
        if (frame.t === 'READY') {
          const readyData = frame.d as { session_id?: string } | undefined;
          this.sessionId = readyData?.session_id;
          this.startHeartbeat();
          hooks.settleReady();
          return;
        }
        if (frame.t === 'RESUMED') {
          this.startHeartbeat();
          hooks.settleReady();
          return;
        }
        const raw = toGatewayRaw(frame);
        if (raw !== undefined) {
          const conversationId = raw.conversationId;
          if (typeof conversationId === 'string') {
            this.conversationKinds.set(
              conversationId,
              raw.conversationType === 'group' ? 'group' : 'dm',
            );
          }
          this.onMessage?.(raw);
        }
        return;
      }
      case QQ_OP.HEARTBEAT_ACK:
        return;
      case QQ_OP.RECONNECT: {
        hooks.disconnect();
        this.client?.close();
        return;
      }
      case QQ_OP.INVALID_SESSION: {
        // d === true → the session may be resumed; otherwise it is dead.
        if (frame.d !== true) this.sessionId = undefined;
        hooks.disconnect();
        this.client?.close();
        return;
      }
      default:
        return;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== undefined || !this.client) return;
    const interval = this.heartbeatIntervalMs;
    const tick = () => {
      if (!this.client) return;
      this.sendFrame({ op: QQ_OP.HEARTBEAT, d: this.lastSeq ?? null });
    };
    this.heartbeatTimer = setInterval(tick, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private sendFrame(frame: unknown): void {
    this.client?.send(JSON.stringify(frame));
  }

  /** Send a plain text message through the official v2 API. */
  async sendText(to: string, text: string): Promise<unknown> {
    const token = await this.acquireToken();
    this.msgSeq += 1;
    return this.requestJson(this.messagePath(to), {
      method: 'POST',
      token,
      body: { msg_type: 0, content: text, msg_seq: this.msgSeq },
    });
  }

  /**
   * Send a media reference through the official v2 API: URL-upload to the
   * files endpoint (file_type from the media kind) then a msg_type 7 message
   * carrying the returned file_info.
   */
  async sendMedia(to: string, media: QQMedia): Promise<unknown> {
    const token = await this.acquireToken();
    const base = this.conversationBase(to);
    const uploaded = (await this.requestJson(`${base}/files`, {
      method: 'POST',
      token,
      body: { file_type: fileTypeFor(media.type), url: media.url, srv_send_msg: false },
    })) as { file_info?: unknown } | undefined;
    const fileInfo = uploaded?.file_info;
    if (typeof fileInfo !== 'string' || !fileInfo) {
      throw new ChannelError('CHANNEL_ERROR', 'qq media upload returned no file_info');
    }
    this.msgSeq += 1;
    return this.requestJson(`${base}/messages`, {
      method: 'POST',
      token,
      body: { msg_type: 7, media: { file_info: fileInfo }, msg_seq: this.msgSeq },
    });
  }

  /** v2 message-send path for a conversation (kind-aware). */
  private messagePath(to: string): string {
    return `${this.conversationBase(to)}/messages`;
  }

  /** v2 base path for a conversation id (user openid vs group openid). */
  private conversationBase(to: string): string {
    const kind = this.conversationKinds.get(to) ?? 'dm';
    const encoded = encodeURIComponent(to);
    return kind === 'group' ? `/v2/groups/${encoded}` : `/v2/users/${encoded}`;
  }

  /** Fetch (and cache) the short-lived access token, refreshing before expiry. */
  private async acquireToken(): Promise<string> {
    const now = this.now();
    if (this.accessToken && this.tokenExpiresAt - now > 60_000) return this.accessToken;
    const response = await this.requestJson(this.tokenPath, {
      method: 'POST',
      body: { appId: this.options.appId, clientSecret: this.options.clientSecret },
    });
    const payload = response as { access_token?: unknown; expires_in?: unknown } | undefined;
    if (typeof payload?.access_token !== 'string' || !payload.access_token) {
      throw new ChannelError('CHANNEL_ERROR', 'qq token endpoint returned no access_token');
    }
    const expiresIn = Number(payload.expires_in) || 7200;
    this.accessToken = payload.access_token;
    this.tokenExpiresAt = now + expiresIn * 1000;
    return this.accessToken;
  }

  /** Resolve (and cache) the gateway WSS URL. */
  private async resolveGatewayUrl(token: string): Promise<string> {
    if (this.gatewayUrl) return this.gatewayUrl;
    if (this.resolvedGatewayUrl) return this.resolvedGatewayUrl;
    const response = await this.requestJson(this.gatewayPath, { method: 'GET', token });
    const payload = response as { url?: unknown } | undefined;
    if (typeof payload?.url !== 'string' || !payload.url) {
      throw new ChannelError('CHANNEL_ERROR', 'qq /gateway returned no url');
    }
    this.resolvedGatewayUrl = payload.url;
    return this.resolvedGatewayUrl;
  }

  /**
   * Fetch one JSON request against the OpenAPI base with `QQBot <token>`
   * authorization. Error messages never contain credentials or the token.
   */
  private async requestJson(
    path: string,
    init: { method: string; body?: unknown; token?: string },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (init.token) headers.authorization = `QQBot ${init.token}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.openApiBaseUrl}${path}`, {
        method: init.method,
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = (error as Error)?.name === 'AbortError' || controller.signal.aborted;
      throw new ChannelError(
        'CHANNEL_ERROR',
        aborted
          ? `qq openapi ${init.method} timed out on ${path}`
          : `qq openapi ${init.method} failed on ${path}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      throw new ChannelError(
        'CHANNEL_ERROR',
        `qq openapi ${init.method} ${path} failed with HTTP ${response.status}`,
      );
    }
    return payload;
  }
}

function backoffDelay(attempt: number): number {
  return Math.min(250 * 2 ** Math.min(attempt - 1, 4), 5000);
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
