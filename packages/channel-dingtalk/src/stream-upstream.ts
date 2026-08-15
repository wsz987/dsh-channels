/**
 * DingTalk stream-mode upstream driver (official `dingtalk-stream` SDK).
 *
 * This driver replaces only the INBOUND leg of the legacy self-hosted gateway
 * integration: robot messages arrive over the DingTalk Stream Mode WebSocket
 * (CALLBACK downstream messages on `TOPIC_ROBOT`, payload JSON-encoded in
 * `message.data`) and are mapped into the SAME raw shape the gateway
 * long-poll driver produces (`{ type, msgId, senderId, conversationId,
 * content, ... }`), so the existing mapper + dedup pipeline is untouched.
 *
 * OUTBOUND is deliberately delegated: message send / AI Card create/update are
 * HTTP calls, not part of the stream SDK. `DingTalkStreamUpstream` forwards
 * every outbound method to an injected `DingTalkUpstream`; SDK mode injects
 * the official `sessionWebhook` / OpenAPI driver, while gateway mode uses its
 * legacy HTTP driver.
 *
 * Credentials never appear in this module and are never logged. Live
 * verification against a real DingTalk app (AppKey/AppSecret) is a manual
 * step — the offline tests inject a fake stream client.
 *
 * Ack note: the stream server may retry a callback after ~60s without a
 * response. The SDK's `DWClient` exposes `socketCallBackResponse(messageId,
 * result)` for exactly this purpose; this driver ACKs each successfully
 * parsed + submitted robot message (message "reliably received", NOT "LLM
 * turn finished") so the platform does not redeliver it. Malformed payloads
 * are deliberately NOT acked, so the platform can retry / surface the error.
 */
import { TOPIC_ROBOT } from 'dingtalk-stream';
import type { ChannelTarget } from '@wsz987/channel-core';
import type { CardCreateResult, DingTalkUpstream } from './upstream.js';

/** Downstream headers of a stream message (subset of the SDK shape). */
export interface DingTalkStreamHeaders {
  /** Subscription topic (e.g. TOPIC_ROBOT for robot messages). */
  topic?: string;
  /** Event id; dedup fallback when the payload omits a msgId. */
  eventId?: string;
  /** Server-side message id of the downstream frame. */
  messageId?: string;
}

/** The downstream message shape the stream client delivers to listeners. */
export interface DingTalkStreamMessage {
  headers?: DingTalkStreamHeaders;
  /** JSON-encoded payload (the SDK delivers `data` as a string). */
  data?: string;
}

/**
 * Minimal structural client surface consumed by the driver. The real SDK
 * `DWClient` satisfies it (connect / disconnect / registerCallbackListener);
 * tests inject a fake without a WebSocket.
 */
export interface DingTalkStreamClient {
  /** Open the stream WebSocket and register subscriptions with the server. */
  connect(): Promise<void>;
  /** Close the stream WebSocket (sync in the real SDK). */
  disconnect(): void;
  /** Subscribe to one downstream topic (robot messages by default). */
  registerCallbackListener(topic: string, callback: (message: DingTalkStreamMessage) => void | Promise<void>): unknown;
  /**
   * Acknowledge one downstream frame so the stream server does not retry it
   * (~60s retry window). The real SDK's `DWClient` implements this as
   * `socketCallBackResponse(messageId, result)`.
   */
  socketCallBackResponse(messageId: string, response: unknown): void;
}

export interface DingTalkStreamUpstreamOptions {
  /** The stream-mode client (real DWClient or injected fake). */
  client: DingTalkStreamClient;
  /** Outbound delegate selected by the adapter (official API or legacy gateway). */
  outbound: DingTalkUpstream;
  /** Invoked after the stream connection is established (connection state). */
  onConnected?: () => void;
}

/** Parsed robot message payload carried in `message.data` (JSON string). */
interface DingTalkStreamRobotMessage {
  msgId?: string;
  senderStaffId?: string;
  senderId?: string;
  conversationId?: string;
  conversationType?: string;
  sessionWebhook?: string;
  robotCode?: string;
  msgtype?: string;
  text?: { content?: string };
  picture?: { url?: string };
  audio?: { duration?: number; url?: string };
  video?: { duration?: number; url?: string };
  file?: { fileName?: string; url?: string };
  link?: { title?: string; text?: string; picUrl?: string };
  [key: string]: unknown;
}

/**
 * Map one SDK downstream message into the gateway raw shape consumed by the
 * inbound mapper (`{ type, msgId, eventId, senderId, conversationId, content,
 * ... }`). Returns `undefined` when the payload is absent or not JSON.
 */
export function toGatewayRaw(message: DingTalkStreamMessage): Record<string, unknown> | undefined {
  if (typeof message.data !== 'string') return undefined;
  let data: DingTalkStreamRobotMessage;
  try {
    data = JSON.parse(message.data) as DingTalkStreamRobotMessage;
  } catch {
    return undefined;
  }
  if (!data || typeof data !== 'object') return undefined;
  const raw: Record<string, unknown> = {
    type: data.msgtype,
    msgId: data.msgId,
    eventId: message.headers?.eventId,
    senderId: data.senderStaffId ?? data.senderId,
    conversationId: data.conversationId,
    conversationType: data.conversationType,
    sessionWebhook: data.sessionWebhook,
    robotCode: data.robotCode,
  };
  // Media fields follow the documented robot-message schema (best-effort);
  // the mapper turns them into image/audio/video/file parts.
  switch (data.msgtype) {
    case 'text':
      raw.content = data.text?.content;
      break;
    case 'picture':
      raw.picUrl = data.picture?.url;
      break;
    case 'audio':
      raw.mediaUrl = data.audio?.url;
      raw.durationMs = data.audio?.duration;
      break;
    case 'video':
      raw.mediaUrl = data.video?.url;
      raw.durationMs = data.video?.duration;
      break;
    case 'file':
      raw.mediaUrl = data.file?.url;
      raw.title = data.file?.fileName;
      break;
    case 'link':
      raw.title = data.link?.title;
      raw.content = data.link?.text;
      break;
    default:
      // Keep the SDK msgtype; the mapper reports unknown types as unsupported.
      break;
  }
  return raw;
}

/**
 * Acknowledge one robot callback frame. ACK means "the message was reliably
 * received and submitted to the inbound pipeline" — not "the LLM finished
 * answering". A frame without a server `messageId` cannot be acked.
 */
export function ackRobotMessage(
  client: DingTalkStreamClient,
  message: DingTalkStreamMessage,
): void {
  const messageId = message.headers?.messageId;
  if (!messageId) return;
  client.socketCallBackResponse(messageId, { success: true });
}

/** Stream-mode implementation of `DingTalkUpstream` (inbound via SDK). */
export class DingTalkStreamUpstream implements DingTalkUpstream {
  /** The listener is registered once per client; reconnect reuses it. */
  private listenerRegistered = false;
  private onMessage?: (raw: unknown) => void;

  constructor(private readonly options: DingTalkStreamUpstreamOptions) {}

  /**
   * Connect the stream client, route inbound robot messages into the gateway
   * raw shape, and keep the stream open until `signal` aborts.
   */
  async receive(
    signal: AbortSignal,
    onMessage: (raw: unknown) => void,
  ): Promise<void> {
    this.onMessage = onMessage;
    this.registerListenerOnce();
    try {
      await this.options.client.connect();
    } catch (error) {
      // Abort-driven teardown exits gracefully; other failures propagate to
      // the adapter, which owns reconnect/backoff.
      if (signal.aborted) return;
      throw error;
    }
    if (signal.aborted) {
      this.options.client.disconnect();
      return;
    }
    // dingtalk-stream v2 resolves connect() after a failed connection attempt
    // and schedules its own retry. Do not report a healthy channel until its
    // actual socket is open.
    if ((this.options.client as { connected?: unknown }).connected === false) {
      throw new Error('dingtalk stream connection was not established');
    }
    this.options.onConnected?.();
    await waitForAbort(signal);
    this.options.client.disconnect();
  }

  private registerListenerOnce(): void {
    if (this.listenerRegistered) return;
    this.options.client.registerCallbackListener(TOPIC_ROBOT, (message) => {
      if (!this.onMessage) return;
      const raw = toGatewayRaw(message);
      if (raw === undefined) return; // malformed payload: do not ack (platform retries / error observation)
      this.onMessage(raw);
      // ACK after submitting to the inbound pipeline ("reliably received"),
      // never after the LLM turn completes.
      ackRobotMessage(this.options.client, message);
    });
    this.listenerRegistered = true;
  }

  sendText(target: ChannelTarget, text: string): Promise<unknown> {
    return this.options.outbound.sendText(target, text);
  }

  createCard(target: ChannelTarget, text: string): Promise<CardCreateResult> {
    return this.options.outbound.createCard(target, text);
  }

  updateCard(cardId: string, text: string): Promise<unknown> {
    return this.options.outbound.updateCard(cardId, text);
  }

  finishCard(cardId: string, text?: string): Promise<unknown> {
    return this.options.outbound.finishCard(cardId, text);
  }

  failCard(cardId: string, reason?: string): Promise<unknown> {
    return this.options.outbound.failCard(cardId, reason);
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
