import type { MessagePart } from '@wsz987/channel-core';
import type { ILinkMessageItem, ILinkRefMessage } from '../ilink/types.js';

/**
 * Preserve a Weixin reference as explicit model-visible context. iLink does
 * not expose a stable referenced Channel message id, so this must not create a
 * synthetic replyTo relationship.
 */
export function formatQuotedContext(ref: ILinkRefMessage | undefined): MessagePart[] {
  if (!ref) return [];
  const item = ref.message_item;
  const summary = quotedItemSummary(item);
  const title = cleanText(ref.title);
  if (!title && !summary) return [];
  const body = [title, summary].filter(Boolean).join(' | ');
  return [{ type: 'text', text: `[quoted: ${body}]` }];
}

function quotedItemSummary(item: ILinkMessageItem | undefined): string | undefined {
  if (!item) return undefined;
  const text = cleanText(item.text_item?.text ?? item.voice_item?.text);
  if (text) return text;
  switch (item.type) {
    case 2: return '[image]';
    case 3: return '[voice]';
    case 4: return item.file_item?.file_name ? `[file: ${item.file_item.file_name}]` : '[file]';
    case 5: return '[video]';
    default: return undefined;
  }
}

function cleanText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
