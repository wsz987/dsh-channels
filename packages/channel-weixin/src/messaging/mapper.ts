/**
 * Classification: A — DSH pure mapping [keep].
 *
 * Pure iLink-message → Channel MessagePart mapping, no I/O, no platform
 * algorithm. The official package's inbound mapper (messaging/inbound.js) is a
 * different model surface (OpenClaw messages); DSH keeps its own neutral
 * mapper for the Channel contract. Keep.
 */
/**
 * Pure inbound mapper — an iLink {@link ILinkMessage} -> Channel
 * {@link MessageReceived}. No I/O.
 *
 * Mapping rules (doc §21-22):
 * - `message_id` -> `message.id` (fallback stable hash only when omitted).
 * - `from_user_id` -> `sender.id` AND `conversation.id` (DM).
 * - `create_time_ms` -> `createdAt`.
 * - `item_list` -> `MessagePart[]` (TEXT -> text part; IMAGE/VOICE/FILE/VIDEO ->
 *   media part when CDN fields are present, else unsupported placeholder).
 */
import type {
  MessageId,
  MessagePart,
  MessageReceived,
  SenderId,
  ConversationId,
} from '@wsz987/channel-core';
import type { ILinkMessage, ILinkMessageItem, WeixinInboundMeta } from '../ilink/types.js';
import { stableHash } from './dedup.js';

/** Human label for common item types. */
function itemTypeName(type?: number): string {
  switch (type) {
    case 1: return 'text';
    case 2: return 'image';
    case 3: return 'voice';
    case 4: return 'file';
    case 5: return 'video';
    default: return 'unknown';
  }
}

/** Whether a CDN media reference is present and downloadable. */
function hasMedia(item: ILinkMessageItem): boolean {
  const media =
    item.image_item?.media ??
    item.voice_item?.media ??
    item.file_item?.media ??
    item.video_item?.media;
  return Boolean(media && (media.encrypt_query_param || media.full_url));
}

/** Map one item to a Channel MessagePart. */
export function mapItem(item: ILinkMessageItem): MessagePart {
  switch (item.type) {
    case 1: {
      const text = item.text_item?.text ?? '';
      if (!text) return { type: 'unsupported', reason: 'empty text item' };
      return { type: 'text', text };
    }
    case 2: {
      const img = item.image_item;
      if (img && hasMedia(item)) {
        return {
          type: 'image',
          url: img.media?.full_url ?? img.url,
          mimeType: 'image/jpeg',
          alt: undefined,
        };
      }
      return { type: 'unsupported', reason: 'image without downloadable CDN fields (WX5)' };
    }
    case 3: {
      const voice = item.voice_item;
      if (voice?.media && (voice.media.full_url || voice.media.encrypt_query_param)) {
        return { type: 'audio', url: voice.media.full_url, durationMs: voice.playtime };
      }
      if (voice?.text) return { type: 'text', text: voice.text };
      return { type: 'unsupported', reason: 'voice without downloadable CDN fields (WX5)' };
    }
    case 4: {
      const file = item.file_item;
      if (file?.media && (file.media.full_url || file.media.encrypt_query_param)) {
        return { type: 'file', url: file.media.full_url, name: file.file_name };
      }
      return { type: 'unsupported', reason: 'file without downloadable CDN fields (WX5)' };
    }
    case 5: {
      const video = item.video_item;
      if (video?.media && (video.media.full_url || video.media.encrypt_query_param)) {
        return { type: 'video', url: video.media.full_url, durationMs: video.play_length };
      }
      return { type: 'unsupported', reason: 'video without downloadable CDN fields (WX5)' };
    }
    default:
      return { type: 'unsupported', reason: `unknown weixin item type '${itemTypeName(item.type)}'` };
  }
}

/** Map one raw iLink message into a stable channel event. */
export function mapInbound(raw: ILinkMessage, meta: WeixinInboundMeta): MessageReceived {
  const from: SenderId = (raw.from_user_id ?? 'unknown') as SenderId;
  const conversationId: ConversationId = from as unknown as ConversationId;
  const items = Array.isArray(raw.item_list) ? raw.item_list : [];

  const parts: MessagePart[] = [];
  for (const item of items) {
    parts.push(mapItem(item));
  }
  if (parts.length === 0) parts.push({ type: 'unsupported', reason: 'empty item_list' });

  const messageId: MessageId =
    raw.message_id !== undefined && raw.message_id !== null
      ? (`wx-${String(raw.message_id)}` as MessageId)
      : (`wx-${stableHash(`${from}:${raw.create_time_ms ?? 0}:${raw.seq ?? ''}`)}` as MessageId);

  return {
    type: 'message.received',
    channel: meta.channel,
    accountId: meta.accountId as never,
    conversation: { id: conversationId, type: 'dm' },
    sender: { id: from },
    message: {
      id: messageId,
      content: parts,
      createdAt: raw.create_time_ms ?? Date.now(),
    },
    raw,
  };
}