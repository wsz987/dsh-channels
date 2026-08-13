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
} from '@dsh/channel-core';
import { textParts } from '@dsh/channel-core';

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
  content?: string;
  picUrl?: string;
  mediaUrl?: string;
  durationMs?: number;
  title?: string;
  [key: string]: unknown;
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
      // v1 convention: every inbound message is a DM keyed by its conversation.
      // Group conversations can be modeled later without changing the contract.
      type: 'dm',
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
    case 'picture':
      return [{ type: 'image', url: raw.picUrl ?? raw.mediaUrl, alt: raw.title }];
    case 'audio':
    case 'voice':
      return [{ type: 'audio', url: raw.mediaUrl, durationMs: raw.durationMs }];
    case 'video':
      return [{ type: 'video', url: raw.mediaUrl, durationMs: raw.durationMs }];
    case 'file':
      return [{ type: 'file', url: raw.mediaUrl, name: raw.title }];
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
