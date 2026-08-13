/**
 * Pure payload mapping (no I/O): platform raw payloads → Channel Contract,
 * and outbound Channel messages → lark text/media payloads.
 *
 * Raw payloads only ever ride along in `event.raw` for debugging — core and
 * the harness bridge never depend on their shape (red line 6).
 *
 * Lark-ish raw shapes are protocol-level and deliberately simple, e.g.:
 * ```json
 * { "type": "text", "msgId": "msg_1", "senderId": "ou_123",
 *   "conversationId": "oc_456", "threadId": "om_789", "content": "hello" }
 * ```
 *
 * The mapper PRESERVES both `conversationId` and the optional `threadId`
 * (execution plan Task 12.2): when a raw payload carries a `threadId`, the
 * mapped `conversation.threadId` is set, so the Harness session key becomes
 * `channel:account:conversation:thread` and threads isolate sessions.
 */
import type {
  AccountId,
  ChannelId,
  ConversationId,
  MessageId,
  MessagePart,
  MessageReceived,
  InteractionReceived,
  OutboundMessage,
  SenderId,
  ThreadId,
} from '@dsh/channel-core';
import { textParts } from '@dsh/channel-core';

export interface LarkInboundMeta {
  channel: ChannelId;
  accountId: AccountId;
}

interface LarkRaw {
  type?: string;
  msgId?: string;
  /** Webhook event id; used as a dedup fallback when `msgId` is absent. */
  eventId?: string;
  senderId?: string;
  conversationId?: string;
  /** Optional thread id within the conversation (e.g. a reply to a topic). */
  threadId?: string;
  content?: string;
  picUrl?: string;
  mediaUrl?: string;
  durationMs?: number;
  title?: string;
  /** Interaction callback fields (card button press). */
  interactionId?: string;
  action?: string;
  value?: unknown;
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

/**
 * Conversation kind from the platform id. Lark conventions: `oc_` prefixes an
 * open chat id (group), anything else (e.g. `ou_` open user id) is a DM.
 */
function conversationTypeFor(conversationId: string): 'dm' | 'group' {
  return conversationId.startsWith('oc_') ? 'group' : 'dm';
}

/**
 * Shared conversation ref builder: preserves `conversationId` and sets
 * `threadId` whenever the raw payload carries one.
 */
function conversationFor(value: LarkRaw, conversationId: ConversationId): MessageReceived['conversation'] {
  const conversation: MessageReceived['conversation'] = {
    id: conversationId,
    type: conversationTypeFor(conversationId),
  };
  if (value.threadId) {
    conversation.threadId = value.threadId as ThreadId;
  }
  return conversation;
}

/** Map one raw lark message into the stable channel event shape. */
export function mapInbound(raw: unknown, meta: LarkInboundMeta): MessageReceived {
  const value = raw as LarkRaw;
  const sender: SenderId = (value.senderId ?? 'unknown') as SenderId;
  // Lark payloads carry a conversation id; fall back to the sender when the
  // gateway omits it (direct/one-off payloads).
  const conversationId: ConversationId = (value.conversationId ?? sender) as ConversationId;

  const messageId: MessageId = value.msgId
    ? value.msgId as MessageId
    : `lk-${simpleHash(`${sender}:${value.content ?? ''}:${value.type ?? 'unknown'}`)}` as MessageId;

  return {
    type: 'message.received',
    channel: meta.channel,
    accountId: meta.accountId,
    conversation: conversationFor(value, conversationId),
    sender: { id: sender },
    message: {
      id: messageId,
      content: partsFor(value),
      createdAt: Date.now(),
    },
    raw,
  };
}

/**
 * Map one raw lark interaction callback (e.g. an editable-card button press)
 * into an `interaction.received` channel event (Task 12.3). The conversation
 * ref preserves `conversationId` + optional `threadId` exactly like messages.
 */
export function mapInteraction(raw: unknown, meta: LarkInboundMeta): InteractionReceived {
  const value = raw as LarkRaw;
  const sender: SenderId = (value.senderId ?? 'unknown') as SenderId;
  const conversationId: ConversationId = (value.conversationId ?? sender) as ConversationId;

  return {
    type: 'interaction.received',
    channel: meta.channel,
    accountId: meta.accountId,
    conversation: conversationFor(value, conversationId),
    sender: { id: sender },
    interactionId: value.interactionId ?? '',
    action: value.action ?? '',
    value: value.value,
    raw,
  };
}

function partsFor(raw: LarkRaw): MessagePart[] {
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
      return [{ type: 'unsupported', reason: `unknown lark type '${raw.type ?? 'undefined'}'` }];
  }
}

/** Outbound lark payload; buffered strategy → single text message. */
export interface LarkTextPayload {
  to: string;
  type: 'text';
  content: string;
}

/** Convert an outbound channel message into a lark text payload. */
export function toTextPayload(target: { conversationId: string }, message: OutboundMessage): LarkTextPayload {
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
  const value = raw as LarkRaw;
  return value.msgId ?? value.eventId ?? `lk-${simpleHash(JSON.stringify(value))}`;
}
