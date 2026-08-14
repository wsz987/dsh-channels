/**
 * Pure payload mapping (no I/O): platform raw payloads → Channel Contract,
 * and outbound Channel messages → platform text/media payloads.
 *
 * Raw payloads only ever ride along in `event.raw` for debugging — core and
 * the harness bridge never depend on their shape (red line 6).
 *
 * The raw shape below is deliberately simple (mirrors the repo fixtures for
 * the official adapters); replace it with the real platform payload shape:
 * ```json
 * { "type": "text", "msgId": "msg_1", "senderId": "user_123",
 *   "conversationId": "conv_456", "conversationType": "dm",
 *   "content": "hello" }
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

export interface ChannelInboundMeta {
  channel: ChannelId;
  accountId: AccountId;
}

interface ChannelRaw {
  type?: string;
  msgId?: string;
  /** Gateway event id; used as a dedup fallback when `msgId` is absent. */
  eventId?: string;
  senderId?: string;
  conversationId?: string;
  /** `dm` (direct) or `group` (group chat); absent defaults to `dm`. */
  conversationType?: string;
  content?: string;
  picUrl?: string;
  mediaUrl?: string;
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

/** Map one raw message into the stable channel event shape. */
export function mapInbound(raw: unknown, meta: ChannelInboundMeta): MessageReceived {
  const value = raw as ChannelRaw;
  const sender: SenderId = (value.senderId ?? 'unknown') as SenderId;
  // Fall back to the sender id as conversation id when the gateway omits it.
  const conversationId: ConversationId = (value.conversationId ?? sender) as ConversationId;

  const messageId: MessageId = value.msgId
    ? value.msgId as MessageId
    : `<channel>-${simpleHash(`${sender}:${value.content ?? ''}:${value.type ?? 'unknown'}`)}` as MessageId;

  return {
    type: 'message.received',
    channel: meta.channel,
    accountId: meta.accountId,
    conversation: {
      id: conversationId,
      // dm ↔ direct chat, group ↔ group chat; the group id is the
      // conversation id for group messages.
      type: value.conversationType === 'group' ? 'group' : 'dm',
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

function partsFor(raw: ChannelRaw): MessagePart[] {
  switch (raw.type) {
    case 'text':
      return textParts(raw.content ?? '');
    case 'image':
    case 'picture':
      return [{ type: 'image', url: raw.picUrl ?? raw.mediaUrl, alt: raw.title }];
    case 'audio':
    case 'voice':
      return [{ type: 'audio', url: raw.mediaUrl }];
    case 'video':
      return [{ type: 'video', url: raw.mediaUrl }];
    case 'file':
      return [{ type: 'file', url: raw.mediaUrl, name: raw.title }];
    default:
      return [{ type: 'unsupported', reason: `unknown <channel> type '${raw.type ?? 'undefined'}'` }];
  }
}

/** Outbound text payload (buffered strategy → single text message). */
export interface ChannelTextPayload {
  to: string;
  type: 'text';
  content: string;
}

/** Convert an outbound channel message into a text payload. */
export function toTextPayload(target: { conversationId: string }, message: OutboundMessage): ChannelTextPayload {
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
  const value = raw as ChannelRaw;
  return value.msgId ?? value.eventId ?? `<channel>-${simpleHash(JSON.stringify(value))}`;
}
