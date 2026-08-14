/**
 * Inbound conversion: `MessageReceived` -> a Harness `UserMessage`.
 *
 * Content is structured-text by default (red line 6): platform parts without
 * downloadable local bytes are mapped to plain-text blocks — images/files/audio/video
 * become `[type: ...]` placeholders instead of raw platform JSON. Conversation
 * metadata (channel / sender / message id) is folded into a configurable text
 * prefix so the model can still tell where a message came from.
 *
 * WX5 attachment path: when an image part carries `localData` (the adapter
 * already downloaded + decrypted the bytes), and a `saveImage` hook is supplied,
 * the converter registers the bytes with the Harness attachment service and emits
 * a real `ImageBlock` (`{ type: 'image', attachment: ImageAttachmentRef }`) so
 * the model receives a genuine multimodal image instead of the `[image]`
 * placeholder. The hook is optional; without it (or on attachment failure) the
 * converter falls back to the text placeholder so message delivery never breaks.
 */
import {
  createUserMessage,
  type ContentBlock,
  type TextBlock,
  type UserMessage,
} from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment';
import type { ImagePart, MessagePart, MessageReceived } from '@wsz987/channel-core';

/** Type-level alias: the bridge always produces Harness user messages. */
export type UserMessageLike = UserMessage;

/**
 * Bridge-provided seam to commit one image to the Harness attachment service.
 * Mirrors `AttachmentStore.saveImage` so the converter stays decoupled from the
 * concrete Cordis service (resolved at the use site and injected). Returns the
 * durable reference used to build the `ImageBlock`.
 */
export type SaveImageHook = (input: SaveImageAttachment) => Promise<ImageAttachmentRef>;

export interface MessageConvertOptions {
  /** Whether to prepend the `[channel=.. sender=.. message=..]` prefix. */
  includeMetadataPrefix?: boolean;
  /** Optional image-commit hook enabling the real attachment path. */
  saveImage?: SaveImageHook;
}

/** Convert a channel message-received event into a model-facing user message. */
export async function toHarnessUserMessage(
  event: MessageReceived,
  options: MessageConvertOptions = {},
): Promise<UserMessageLike> {
  const blocks: ContentBlock[] = [];
  const includePrefix = options.includeMetadataPrefix ?? true;
  if (includePrefix) {
    const prefix = metadataPrefix(event);
    if (prefix) blocks.push({ type: 'text', text: prefix });
  }

  const parts = event.message.content;
  const bodyText = await partsToText(parts, {
    saveImage: options.saveImage,
    onImage: (block) => blocks.push(block),
  });
  // Image blocks are emitted in place; the remaining (non-image) text is one block.
  if (bodyText) blocks.push({ type: 'text', text: bodyText });
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });

  return createUserMessage({
    content: blocks,
    source: { kind: 'plugin', plugin: 'channel-harness' },
  });
}

function metadataPrefix(event: MessageReceived): string {
  return `[channel=${event.channel} sender=${event.sender.id} message=${event.message.id}] `;
}

/**
 * Map structured parts to a single text line. Never embeds raw payloads.
 * Image parts with local bytes and a saveImage hook are surfaced via
 * `onImage` instead of being folded into text; they never contribute a text
 * placeholder (unless the attachment path is unavailable, in which case they
 * fall back to the ordinary `[image]` placeholder).
 */
export async function partsToText(
  parts: readonly MessagePart[],
  options: { saveImage?: SaveImageHook; onImage?: (block: ContentBlock) => void } = {},
): Promise<string> {
  const segments: string[] = [];
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        segments.push(part.text);
        break;
      case 'image': {
        const block = await imageBlock(part, options.saveImage);
        if (block) {
          options.onImage?.(block);
        } else {
          segments.push(part.alt ? `[image: ${part.alt}]` : part.url ? `[image: ${part.url}]` : '[image]');
        }
        break;
      }
      case 'file':
        segments.push(part.name ? `[file: ${part.name}]` : part.url ? `[file: ${part.url}]` : '[file]');
        break;
      case 'audio':
        segments.push(
          part.durationMs !== undefined ? `[audio: ${part.durationMs}ms]` : '[audio]',
        );
        break;
      case 'video':
        segments.push(
          part.durationMs !== undefined ? `[video: ${part.durationMs}ms]` : '[video]',
        );
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
  return segments.join('');
}

/**
 * Produce an image content block when the part carries local bytes and a
 * saveImage hook commits them. A media type is inferred from `mimeType`
 * (or the data URI / URL extension) and accepted only when it maps to a
 * supported raster type; otherwise the bytes are committed as-is and the
 * attachment service performs final validation. Any failure returns undefined
 * so the caller falls back to the text placeholder (never breaks delivery).
 */
async function imageBlock(
  part: ImagePart,
  saveImage?: SaveImageHook,
): Promise<ContentBlock | undefined> {
  if (!saveImage || !part.localData || part.localData.byteLength === 0) return undefined;
  const mediaType = inferImageMediaType(part);
  if (!mediaType) return undefined;
  try {
    const ref = await saveImage({
      data: part.localData as Uint8Array,
      mediaType,
      name: part.alt,
    });
    return { type: 'image', attachment: ref };
  } catch {
    return undefined;
  }
}

/** Infer a raster media type from a part's mimeType / url / dataUri. */
function inferImageMediaType(part: ImagePart): ImageMediaType | undefined {
  const candidate = part.mimeType ?? mimeFromDataUri(part.dataUri) ?? mimeFromUrl(part.url);
  if (!candidate) return undefined;
  const normalized = candidate.split(';')[0]!.trim().toLowerCase();
  switch (normalized) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/jpg':
      return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
    case 'image/webp':
    case 'image/gif':
      return normalized;
    default:
      return undefined;
  }
}

function mimeFromDataUri(dataUri?: string): string | undefined {
  if (!dataUri) return undefined;
  const m = /^data:([^;,]+)/.exec(dataUri);
  return m?.[1];
}

function mimeFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const m = /.(png|jpe?g|webp|gif)(?:[?#]|$)/i.exec(url);
  if (!m) return undefined;
  switch (m[1]!.toLowerCase()) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'webp': return 'image/webp';
    case 'gif': return 'image/gif';
    default: return undefined;
  }
}
