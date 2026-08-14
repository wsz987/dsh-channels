/**
 * Pure payload mapping (no I/O) — Tencent SDK inbound messages → Channel
 * Contract, plus the outbound media extraction helper shared with
 * OutboundSender.
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
  SenderId,
} from '@dsh/channel-core';
import { textParts } from '@dsh/channel-core';
import type { QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { InboundAttachment } from '@tencent-connect/qqbot-nodejs/protocol';

export interface QQInboundMeta {
  channel: ChannelId;
  accountId: AccountId;
}

/**
 * Map one Tencent SDK inbound message into the stable channel event shape.
 *
 * - C2C    → conversation.id = `senderId`, type `dm`
 * - Group  → conversation.id = `groupOpenid`, type `group`
 * Other kinds (`guild`/`dm`) are not formally supported in V1 and are dropped
 * by the `InboundProcessor` before they reach this mapper.
 */
export function mapInbound(msg: QQBotInboundMessage, meta: QQInboundMeta): MessageReceived {
  const group = msg.kind === 'group';

  return {
    type: 'message.received',
    channel: meta.channel,
    accountId: meta.accountId,
    conversation: {
      id: (group ? msg.groupOpenid! : msg.senderId) as ConversationId,
      type: group ? 'group' : 'dm',
    },
    sender: {
      id: msg.senderId as SenderId,
      name: msg.senderName,
    },
    message: {
      id: msg.messageId as MessageId,
      content: mapMessageParts(msg),
      createdAt: Date.parse(msg.timestamp),
    },
    raw: msg.raw,
  };
}

/**
 * Map an SDK inbound message's text + attachments into structured parts.
 *
 * Text comes from `msg.content`; each attachment is mapped by its
 * `content_type` (image/voice/audio/video/file → typed parts, unknown →
 * unsupported).
 */
export function mapMessageParts(msg: QQBotInboundMessage): MessagePart[] {
  const parts: MessagePart[] = [];

  if (msg.content) {
    parts.push(...textParts(msg.content));
  }

  for (const attachment of msg.attachments ?? []) {
    const part = mapAttachment(attachment);
    if (part) parts.push(part);
  }

  // A message with no content and no attachments becomes a single unsupported
  // part so it is never silently empty.
  if (parts.length === 0) {
    parts.push({ type: 'unsupported', reason: 'empty qq message' });
  }

  return parts;
}

/** Map one SDK inbound attachment to a structured part (or undefined). */
function mapAttachment(attachment: InboundAttachment): MessagePart | undefined {
  const type = attachment.content_type?.toLowerCase() ?? '';

  if (type.includes('image')) {
    return { type: 'image', url: attachment.url, alt: attachment.filename };
  }

  if (type.includes('voice') || type.includes('audio')) {
    return {
      type: 'audio',
      // QQ exposes a server-converted WAV when available; prefer it.
      url: attachment.voice_wav_url ?? attachment.url,
    };
  }

  if (type.includes('video')) {
    return { type: 'video', url: attachment.url };
  }

  if (type.includes('file')) {
    return {
      type: 'file',
      url: attachment.url,
      name: attachment.filename,
      size: attachment.size,
    };
  }

  return {
    type: 'unsupported',
    reason: `unknown qq attachment type '${attachment.content_type}'`,
  };
}
