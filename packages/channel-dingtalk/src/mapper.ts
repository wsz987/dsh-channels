/**
 * Pure payload mapping (no I/O): platform raw payloads → Channel Contract,
 * and outbound Channel messages → dingtalk text payloads.
 *
 * Raw payloads only ever ride along in `event.raw` for debugging — core and
 * the harness bridge never depend on their shape (red line 6).
 *
 * DingTalk-ish raw shapes are protocol-level and deliberately simple, e.g.:
 * ```json
 * { "type": "text", "msgId": "msg_1", "senderId": "user_123",
 *   "conversationId": "conv_456", "content": "hello" }
 * ```
 */
import type {
  AccountId,
  ChannelId,
  ConversationId,
  MessageId,
  MessagePart,
  MessageReceived,
  OutboundMessage,
  SenderId,
} from '@wsz987/channel-core';
import { textParts } from '@wsz987/channel-core';

export interface DingTalkInboundMeta {
  channel: ChannelId;
  accountId: AccountId;
}

interface DingTalkRaw {
  type?: string;
  msgId?: string;
  /** Webhook event id; used as a dedup fallback when `msgId` is absent. */
  eventId?: string;
  senderId?: string;
  conversationId?: string;
  conversationType?: string;
  content?: string;
  picUrl?: string;
  mediaUrl?: string;
  /** Opaque picture media id (official robot schema; not a URL). */
  picMediaId?: string;
  /** Per-message media download code (official robot schema). */
  picDownloadCode?: string;
  /** Per-message media download code for audio/video/file (official schema). */
  downloadCode?: string;
  durationMs?: number;
  title?: string;
  richTextImages?: Array<{ pictureUrl?: string; downloadCode?: string }>;
  [key: string]: unknown;
}

/** True only for genuine http(s) locators (plan §9: url is reserved for those). */
function isHttpUrl(locator: string | undefined): locator is string {
  return typeof locator === 'string' && /^https?:\/\//i.test(locator);
}

/** Stable hash for ids when the gateway omits a msgId. */
export function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** Map one raw dingtalk message into the stable channel event shape. */
export function mapInbound(raw: unknown, meta: DingTalkInboundMeta): MessageReceived {
  const value = raw as DingTalkRaw;
  const sender: SenderId = (value.senderId ?? 'unknown') as SenderId;
  // DingTalk payloads carry a conversation id; fall back to the sender when
  // the gateway omits it (direct/one-off payloads).
  const conversationId: ConversationId = (value.conversationId ?? sender) as ConversationId;

  const messageId: MessageId = value.msgId
    ? value.msgId as MessageId
    : `dt-${simpleHash(`${sender}:${value.content ?? ''}:${value.type ?? 'unknown'}`)}` as MessageId;

  return {
    type: 'message.received',
    channel: meta.channel,
    accountId: meta.accountId,
    conversation: {
      id: conversationId,
      type: value.conversationType === '2' ? 'group' : 'dm',
    },
    sender: { id: sender },
    message: {
      id: messageId,
      content: partsFor(value),
      createdAt: Date.now(),
    },
    raw,
  };
}

function partsFor(raw: DingTalkRaw): MessagePart[] {
  switch (raw.type) {
    case 'text':
      return textParts(raw.content ?? '');
    case 'image':
    case 'picture': {
      // Official robot picture messages carry an opaque picMediaId/downloadCode
      // (NOT a URL): resourceRef holds the opaque handle, url only a genuine
      // http(s) URL (plan §9). Resolving resourceRef is the upstream's job.
      const url = isHttpUrl(raw.picUrl) ? raw.picUrl : undefined;
      const opaque = raw.picMediaId ?? raw.picDownloadCode ?? (raw.picUrl ? raw.picUrl : undefined);
      return [{ type: 'image', ...(url ? { url } : opaque ? { resourceRef: opaque } : {}), alt: raw.title }];
    }
    case 'richText': {
      const parts: MessagePart[] = textParts(raw.content ?? '');
      for (const image of raw.richTextImages ?? []) {
        const url = isHttpUrl(image.pictureUrl) ? image.pictureUrl : undefined;
        const resourceRef = image.downloadCode ? `downloadCode:${image.downloadCode}` : undefined;
        parts.push({ type: 'image', ...(url ? { url } : resourceRef ? { resourceRef } : {}) });
      }
      return parts.length > 0
        ? parts
        : [{ type: 'unsupported', reason: "empty dingtalk richText message" }];
    }
    case 'audio':
    case 'voice': {
      const url = isHttpUrl(raw.mediaUrl) ? raw.mediaUrl : undefined;
      const opaque = raw.downloadCode ?? (raw.mediaUrl ? raw.mediaUrl : undefined);
      return [{ type: 'audio', ...(url ? { url } : opaque ? { resourceRef: opaque } : {}), durationMs: raw.durationMs }];
    }
    case 'video': {
      const url = isHttpUrl(raw.mediaUrl) ? raw.mediaUrl : undefined;
      const opaque = raw.downloadCode ?? (raw.mediaUrl ? raw.mediaUrl : undefined);
      return [{ type: 'video', ...(url ? { url } : opaque ? { resourceRef: opaque } : {}), durationMs: raw.durationMs }];
    }
    case 'file': {
      const url = isHttpUrl(raw.mediaUrl) ? raw.mediaUrl : undefined;
      const opaque = raw.downloadCode ?? (raw.mediaUrl ? raw.mediaUrl : undefined);
      return [{ type: 'file', ...(url ? { url } : opaque ? { resourceRef: opaque } : {}), name: raw.title }];
    }
    case 'link':
      return textParts(raw.title ?? raw.content ?? '');
    default:
      return [{ type: 'unsupported', reason: `unknown dingtalk type '${raw.type ?? 'undefined'}'` }];
  }
}

/** Outbound dingtalk payload; buffered strategy → single text message. */
export interface DingTalkTextPayload {
  to: string;
  type: 'text';
  content: string;
}

/** Convert an outbound channel message into a dingtalk text payload. */
export function toTextPayload(target: { conversationId: string }, message: OutboundMessage): DingTalkTextPayload {
  const segments: string[] = [];
  if (message.text) segments.push(message.text);
  if (message.parts) {
    for (const part of message.parts) {
      switch (part.type) {
        case 'text':
          segments.push(part.text);
          break;
        case 'image':
          segments.push(part.alt ? `[image: ${part.alt}]` : '[image]');
          break;
        case 'audio':
          segments.push('[audio]');
          break;
        case 'video':
          segments.push('[video]');
          break;
        case 'file':
          segments.push(part.name ? `[file: ${part.name}]` : '[file]');
          break;
        case 'location':
          segments.push(`[location: ${part.latitude},${part.longitude}]`);
          break;
        case 'card':
          segments.push(`[card: ${part.kind}]`);
          break;
        case 'unsupported':
          segments.push('[unsupported content]');
          break;
      }
    }
  }
  return { to: target.conversationId, type: 'text', content: segments.join('') };
}

/** Dedup identity for raw payloads (webhook retries share one msgId/eventId). */
export function dedupKey(raw: unknown): string {
  const value = raw as DingTalkRaw;
  return value.msgId ?? value.eventId ?? `dt-${simpleHash(JSON.stringify(value))}`;
}
