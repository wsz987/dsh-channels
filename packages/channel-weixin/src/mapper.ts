/**
 * Pure payload mapping (no I/O): platform raw payloads → Channel Contract,
 * and outbound Channel messages → weixin text payloads.
 *
 * Raw payloads only ever ride along in `event.raw` for debugging — core and
 * the harness bridge never depend on their shape (red line 6).
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

export interface WeixinInboundMeta {
  channel: ChannelId;
  accountId: AccountId;
}

interface WeixinRaw {
  type?: string;
  msgId?: string;
  fromUserName?: string;
  toUserName?: string;
  content?: string;
  mediaUrl?: string;
  picUrl?: string;
  durationMs?: number;
  title?: string;
  latitude?: number;
  longitude?: number;
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

/** Map one raw weixin message into the stable channel event shape. */
export function mapInbound(raw: unknown, meta: WeixinInboundMeta): MessageReceived {
  const value = raw as WeixinRaw;
  const from = value.fromUserName ?? 'unknown';
  // v1 convention: every inbound message is a DM keyed by the remote user.
  // Group conversations can be modeled later without changing the contract.
  const conversationId: ConversationId = from as ConversationId;

  const sender: SenderId = from as SenderId;
  const messageId: MessageId = value.msgId
    ? value.msgId as MessageId
    : `wx-${simpleHash(`${sender}:${value.content ?? ''}:${value.type ?? 'unknown'}`)}` as MessageId;

  return {
    type: 'message.received',
    channel: meta.channel,
    accountId: meta.accountId,
    conversation: {
      id: conversationId,
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

function partsFor(raw: WeixinRaw): MessagePart[] {
  switch (raw.type) {
    case 'text':
      return textParts(raw.content ?? '');
    case 'image':
      return [{ type: 'image', url: raw.picUrl ?? raw.mediaUrl, alt: raw.title }];
    case 'audio':
      return [{ type: 'audio', url: raw.mediaUrl, durationMs: raw.durationMs }];
    case 'video':
      return [{ type: 'video', url: raw.mediaUrl, durationMs: raw.durationMs }];
    case 'file':
      return [{ type: 'file', url: raw.mediaUrl, name: raw.title }];
    case 'location':
      return raw.latitude !== undefined && raw.longitude !== undefined
        ? [{ type: 'location', latitude: raw.latitude, longitude: raw.longitude }]
        : [{ type: 'unsupported', reason: 'location without coordinates' }];
    default:
      return [{ type: 'unsupported', reason: `unknown weixin type '${raw.type ?? 'undefined'}'` }];
  }
}

/** Outbound weixin payload; buffered strategy → single text message. */
export interface WeixinTextPayload {
  to: string;
  type: 'text';
  content: string;
}

/** Convert an outbound channel message into a weixin text payload. */
export function toTextPayload(target: { conversationId: string }, message: OutboundMessage): WeixinTextPayload {
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

/** Dedup identity for raw payloads (webhook retries share one msgId). */
export function dedupKey(raw: unknown): string {
  const value = raw as WeixinRaw;
  return value.msgId ?? `wx-${simpleHash(JSON.stringify(value))}`;
}
