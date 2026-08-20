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
  AudioPart,
  FilePart,
  ImagePart,
  MessageId,
  MessagePart,
  MessageReceived,
  InteractionReceived,
  OutboundMessage,
  SenderId,
  ThreadId,
  VideoPart,
} from '@wsz987/channel-core';
import { ChannelError, textParts } from '@wsz987/channel-core';
import { z } from 'zod';


/**
 * A genuine http(s) URL (the only string allowed in the `url` carrier per
 * plan §9). Anything else (image_key, file_key, mediaId, …) is a
 * platform-opaque handle and must be mapped into `resourceRef` instead.
 */
function isHttpUrl(value: string | undefined): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

export interface LarkInboundMeta {
  channel: ChannelId;
  accountId: AccountId;
}

const larkRawSchema = z.object({
  type: z.string().optional(),
  msgId: z.string().optional(),
  /** Webhook event id; used as a dedup fallback when `msgId` is absent. */
  eventId: z.string().optional(),
  senderId: z.string().optional(),
  conversationId: z.string().optional(),
  /** Platform chat kind from im.message.receive_v1. */
  chatType: z.enum(['p2p', 'group']),
  /** Optional thread id within the conversation (e.g. a reply to a topic). */
  threadId: z.string().optional(),
  content: z.string().optional(),
  picUrl: z.string().optional(),
  mediaUrl: z.string().optional(),
  durationMs: z.number().optional(),
  title: z.string().optional(),
  /** Interaction callback fields (card button press). */
  interactionId: z.string().optional(),
  action: z.string().optional(),
  value: z.unknown().optional(),
}).passthrough();

type LarkRaw = z.infer<typeof larkRawSchema>;

function parseLarkRaw(raw: unknown): LarkRaw {
  const parsed = larkRawSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ChannelError('CHANNEL_ERROR', 'lark inbound payload is invalid');
  }
  return parsed.data;
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
 * Conversation kind from the platform event. Feishu uses `oc_` chat ids for
 * both p2p and group conversations, so the id prefix is not an identity fact.
 */
function conversationTypeFor(value: LarkRaw): 'dm' | 'group' {
  return value.chatType === 'p2p' ? 'dm' : 'group';
}

/**
 * Shared conversation ref builder: preserves `conversationId` and sets
 * `threadId` whenever the raw payload carries one.
 */
function conversationFor(value: LarkRaw, conversationId: ConversationId): MessageReceived['conversation'] {
  const conversation: MessageReceived['conversation'] = {
    id: conversationId,
    type: conversationTypeFor(value),
  };
  if (value.threadId) {
    conversation.threadId = value.threadId as ThreadId;
  }
  return conversation;
}

/** Map one raw lark message into the stable channel event shape. */
export function mapInbound(raw: unknown, meta: LarkInboundMeta): MessageReceived {
  const value = parseLarkRaw(raw);
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
  const value = parseLarkRaw(raw);
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
    case 'picture': {
      // Per plan §28/§9 a Lark image locator is an opaque image_key (NOT a
      // URL): it MUST live in `resourceRef`, never `url` — `url` is reserved
      // for genuine http(s) URLs. The real SDK path sets picUrl = image_key
      // (opaque → resourceRef); a legacy gateway that already resolved it to
      // an http(s) URL keeps the URL carrier.
      const locator = raw.picUrl ?? raw.mediaUrl;
      const part: ImagePart = { type: 'image', alt: raw.title };
      if (isHttpUrl(locator)) part.url = locator;
      else if (locator) part.resourceRef = locator;
      return [part];
    }
    case 'audio':
    case 'voice': {
      // Per plan 28 the SDK audio body carries an opaque file_key; if it is
      // not a genuine http(s) URL it maps to resourceRef (resolved later by the
      // media port), mirroring the image-key rule (plan 9).
      const locator = raw.mediaUrl;
      const part: AudioPart = { type: 'audio', durationMs: raw.durationMs };
      if (isHttpUrl(locator)) part.url = locator;
      else if (locator) part.resourceRef = locator;
      return [part];
    }
    case 'video': {
      const locator = raw.mediaUrl;
      const part: VideoPart = { type: 'video', durationMs: raw.durationMs };
      if (isHttpUrl(locator)) part.url = locator;
      else if (locator) part.resourceRef = locator;
      return [part];
    }
    case 'file': {
      // Per plan 28/84 the SDK file body carries an opaque file_key (currently
      // routed through raw.mediaUrl by lark-sdk-upstream.ts). A genuine
      // http(s) URL stays in url (plan 9); anything else maps to resourceRef,
      // which the media port resolves into localData before emit.
      const locator = raw.mediaUrl;
      const part: FilePart = { type: 'file', name: raw.title };
      if (isHttpUrl(locator)) part.url = locator;
      else if (locator) part.resourceRef = locator;
      return [part];
    }
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
  const value = parseLarkRaw(raw);
  return value.msgId ?? value.eventId ?? `lk-${simpleHash(JSON.stringify(value))}`;
}
