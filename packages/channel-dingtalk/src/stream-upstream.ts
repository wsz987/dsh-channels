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
import { TOPIC_CARD, TOPIC_ROBOT } from 'dingtalk-stream';
import type { ChannelTarget } from '@wsz987/channel-core';
import type { CardCreateResult, DingTalkUpstream } from './upstream.js';
import { z } from 'zod';

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

/**
 * Parsed robot message payload carried in `message.data` (JSON string).
 *
 * Per the official robot-message schema (oracle:
 * `@dingtalk-real-ai/dingtalk-connector@0.8.24` message-handler), media
 * messages carry their content in `content` (an object, or a JSON string) —
 * NOT a `picture.url`. The actionable field for inbound media is
 * `content.downloadCode` (picture may additionally carry `pictureUrl` /
 * `picMediaId`). `picture.url` is kept for gateway-mode compatibility.
 */
interface DingTalkStreamRobotMessage {
  msgId?: string;
  senderStaffId?: string;
  senderId?: string;
  conversationId?: string;
  conversationType?: string;
  sessionWebhook?: string;
  robotCode?: string;
  /** Official robot callback fact: the bot is included in the @ list. */
  isInAtList?: boolean;
  msgtype?: string;
  text?: { content?: string };
  /** Media content container (object or JSON string), official schema. */
  content?: unknown;
  richText?: { richTextList?: unknown[] };
  picture?: { url?: string; picMediaId?: string; downloadCode?: string };
  audio?: { duration?: number; url?: string; downloadCode?: string };
  video?: { duration?: number; url?: string; downloadCode?: string };
  file?: { fileName?: string; url?: string; downloadCode?: string };
  link?: { title?: string; text?: string; picUrl?: string };
  [key: string]: unknown;
}

// Validate the untrusted JSON frame before any field access. The schema only
// covers fields consumed by this adapter; `.passthrough()` preserves the
// platform's additional media fields for the existing mapper logic.
const dingtalkStreamRobotMessageSchema = z.object({
  msgId: z.string().optional(),
  senderStaffId: z.string().optional(),
  senderId: z.string().optional(),
  conversationId: z.string().optional(),
  conversationType: z.string().optional(),
  sessionWebhook: z.string().optional(),
  robotCode: z.string().optional(),
  isInAtList: z.boolean().optional(),
  msgtype: z.string().optional(),
  text: z.object({ content: z.string().optional() }).optional(),
  content: z.unknown().optional(),
  richText: z.object({ richTextList: z.array(z.unknown()).optional() }).optional(),
  picture: z.object({ url: z.string().optional(), picMediaId: z.string().optional(), downloadCode: z.string().optional() }).optional(),
  audio: z.object({ duration: z.number().optional(), url: z.string().optional(), downloadCode: z.string().optional() }).optional(),
  video: z.object({ duration: z.number().optional(), url: z.string().optional(), downloadCode: z.string().optional() }).optional(),
  file: z.object({ fileName: z.string().optional(), url: z.string().optional(), downloadCode: z.string().optional() }).optional(),
  link: z.object({ title: z.string().optional(), text: z.string().optional(), picUrl: z.string().optional() }).optional(),
}).passthrough();

/** Resolve the media content container (mirrors the official connector's
 * `resolveContent`): `data.content` as an object, or a parsed JSON string. */
function resolveContent(data: DingTalkStreamRobotMessage): Record<string, unknown> | undefined {
  const raw = data.content;
  if (raw == null) return undefined;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // fall through
    }
  }
  return undefined;
}

function richTextList(
  data: DingTalkStreamRobotMessage,
  content: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  const current = content?.richText;
  const legacy = data.richText?.richTextList;
  const list = Array.isArray(current) ? current : Array.isArray(legacy) ? legacy : [];
  return list.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
}

/**
 * Map one SDK downstream message into the gateway raw shape consumed by the
 * inbound mapper (`{ type, msgId, eventId, senderId, conversationId, content,
 * ... }`). Returns `undefined` when the payload is absent or not JSON.
 */
export function toGatewayRaw(message: DingTalkStreamMessage): Record<string, unknown> | undefined {
  if (typeof message.data !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.data) as unknown;
  } catch {
    return undefined;
  }
  const result = dingtalkStreamRobotMessageSchema.safeParse(parsed);
  if (!result.success) return undefined;
  const data: DingTalkStreamRobotMessage = result.data;
  const raw: Record<string, unknown> = {
    type: data.msgtype,
    msgId: data.msgId,
    eventId: message.headers?.eventId,
    senderId: data.senderStaffId ?? data.senderId,
    conversationId: data.conversationId,
    conversationType: data.conversationType,
    sessionWebhook: data.sessionWebhook,
    robotCode: data.robotCode,
    // Preserve the official activation fact under the channel-neutral name
    // consumed by the mapper. Do not infer it from message text.
    ...(typeof data.isInAtList === 'boolean' ? { mentionedBot: data.isInAtList } : {}),
  };
  // Media fields follow the documented robot-message schema (oracle:
  // @dingtalk-real-ai/dingtalk-connector@0.8.24). Media messages carry their
  // content in `data.content` (object or JSON string) whose actionable field
  // is `downloadCode`; picture may also carry `pictureUrl` / `picMediaId`.
  // The `data.<type>?.url` shapes are kept for gateway-mode compatibility.
  // The mapper turns these into image/audio/video/file parts.
  const content = resolveContent(data);
  switch (data.msgtype) {
    case 'text':
      raw.content = data.text?.content;
      break;
    case 'picture': {
      raw.picUrl = (content?.pictureUrl as string | undefined) ?? data.picture?.url;
      raw.picMediaId = (content?.picMediaId as string | undefined) ?? data.picture?.picMediaId;
      raw.picDownloadCode = (content?.downloadCode as string | undefined) ?? data.picture?.downloadCode;
      break;
    }
    case 'richText': {
      const items = richTextList(data, content);
      raw.content = items
        .filter((item) => item.type !== 'skill' && !item.skillData)
        .map((item) => typeof item.text === 'string' ? item.text : '')
        .join('');
      raw.richTextImages = items.flatMap((item) => {
        const pictureUrl = typeof item.pictureUrl === 'string' ? item.pictureUrl : undefined;
        const downloadCode = typeof item.downloadCode === 'string' && (item.type === 'picture' || !item.type)
          ? item.downloadCode
          : undefined;
        return pictureUrl || downloadCode ? [{ pictureUrl, downloadCode }] : [];
      });
      break;
    }
    case 'audio':
      raw.mediaUrl = (content?.url as string | undefined) ?? data.audio?.url;
      raw.downloadCode = (content?.downloadCode as string | undefined) ?? data.audio?.downloadCode;
      raw.durationMs = (content?.duration as number | undefined) ?? data.audio?.duration;
      break;
    case 'video':
      raw.mediaUrl = (content?.url as string | undefined) ?? data.video?.url;
      raw.downloadCode = (content?.downloadCode as string | undefined) ?? data.video?.downloadCode;
      raw.durationMs = (content?.duration as number | undefined) ?? data.video?.duration;
      break;
    case 'file':
      raw.mediaUrl = (content?.url as string | undefined) ?? data.file?.url;
      raw.downloadCode = (content?.downloadCode as string | undefined) ?? data.file?.downloadCode;
      raw.title = (content?.fileName as string | undefined) ?? data.file?.fileName;
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

export function toCardInteractionRaw(message: DingTalkStreamMessage): Record<string, unknown> | undefined {
  if (typeof message.data !== 'string') return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(message.data) as unknown; } catch { return undefined; }
  const schema = z.object({
    outTrackId: z.string().min(1),
    userId: z.string().min(1),
    openConversationId: z.string().min(1).optional(),
    cardActionData: z.object({
      cardPrivateData: z.object({ params: z.record(z.string(), z.unknown()).optional() }).optional(),
    }).default({}),
  }).passthrough();
  const result = schema.safeParse(parsed);
  if (!result.success) return undefined;
  const params = result.data.cardActionData.cardPrivateData?.params ?? {};
  const action = typeof params.action === 'string' ? params.action : typeof params.actionId === 'string' ? params.actionId : undefined;
  if (!action) return undefined;
  return {
    type: 'interaction',
    msgId: message.headers?.messageId ?? result.data.outTrackId,
    eventId: message.headers?.eventId,
    senderId: result.data.userId,
    conversationId: result.data.openConversationId ?? result.data.userId,
    conversationType: result.data.openConversationId ? '2' : '1',
    interactionId: result.data.outTrackId,
    action,
    value: params,
  };
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
    this.options.client.registerCallbackListener(TOPIC_CARD, (message) => {
      const raw = toCardInteractionRaw(message);
      if (raw === undefined) return;
      this.onMessage?.(raw);
      if (message.headers?.messageId) {
        this.options.client.socketCallBackResponse(message.headers.messageId, { success: true });
      }
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
