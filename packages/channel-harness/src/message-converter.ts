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
import {
  mimeHintFromFilename,
  normalizeMimeHint,
  type AudioPart,
  type FilePart,
  type ImagePart,
  type MessagePart,
  type MessageReceived,
  type VideoPart,
} from '@wsz987/channel-core';
import type { ChannelFileDescriptor } from './file-provider.js';

/** Type-level alias: the bridge always produces Harness user messages. */
export type UserMessageLike = UserMessage;

/**
 * Bridge-provided seam to commit one image to the Harness attachment service.
 * Mirrors `AttachmentStore.saveImage` so the converter stays decoupled from the
 * concrete Cordis service (resolved at the use site and injected). Returns the
 * durable reference used to build the `ImageBlock`.
 */
export type SaveImageHook = (input: SaveImageAttachment) => Promise<ImageAttachmentRef>;

/** A binary (file / audio / video) part carrying local bytes. */
export type StoredBinaryPart = FilePart | AudioPart | VideoPart;

/**
 * Optional bridge-provided seam that persists a file/audio/video part with
 * `localData` into the private channel asset store and returns a compact
 * model descriptor (plan \u00a750/\u00a754). Mirrors `SaveImageHook`: the
 * converter stays decoupled from the concrete store (injected at the use
 * site). Absent -> the part falls back to its `[file: name]` placeholder;
 * a thrown/undefined result also falls back, never breaking delivery.
 */
export type FileStoreHook = (
  part: StoredBinaryPart,
) => Promise<ChannelFileDescriptor | undefined>;

export interface MessageConvertOptions {
  /** Whether to prepend the `[channel=.. sender=.. message=..]` prefix. Defaults to false. */
  includeMetadataPrefix?: boolean;
  /** Optional image-commit hook enabling the real attachment path. */
  saveImage?: SaveImageHook;
  /** Optional file/audio/video store hook enabling the private asset path. */
  fileStore?: FileStoreHook;
}

/** Convert a channel message-received event into a model-facing user message. */
export async function toHarnessUserMessage(
  event: MessageReceived,
  options: MessageConvertOptions = {},
): Promise<UserMessageLike> {
  const blocks: ContentBlock[] = [];
  const includePrefix = options.includeMetadataPrefix ?? false;
  if (includePrefix) {
    const prefix = metadataPrefix(event);
    if (prefix) blocks.push({ type: 'text', text: prefix });
  }

  blocks.push(...await partsToBlocks(event.message.content, options));
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });

  return createUserMessage({
    content: blocks,
    // Channel inbound messages are authored by the remote human. Marking
    // them as plugin context makes Harness skip user-only behavior such as
    // deterministic and LLM-backed session title generation.
    source: { kind: 'user' },
  });
}

/** Convert platform parts to Harness blocks without changing their order. */
async function partsToBlocks(
  parts: readonly MessagePart[],
  options: Pick<MessageConvertOptions, 'saveImage' | 'fileStore'>,
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = [];
  for (const part of parts) {
    if (part.type === 'image') {
      const block = await imageBlock(part, options.saveImage);
      if (block) {
        blocks.push(block);
        continue;
      }
    }
    const text = await partsToText([part], { fileStore: options.fileStore });
    if (text) blocks.push({ type: 'text', text });
  }
  return blocks;
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
  options: {
    saveImage?: SaveImageHook;
    fileStore?: FileStoreHook;
    onImage?: (block: ContentBlock) => void;
  } = {},
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
        segments.push(
          (await storedDescriptor(part, options.fileStore)) ??
            (part.name ? `[file: ${part.name}]` : part.url ? `[file: ${part.url}]` : '[file]'),
        );
        break;
      case 'audio':
        segments.push(
          (await storedDescriptor(part, options.fileStore)) ??
            (part.durationMs !== undefined ? `[audio: ${part.durationMs}ms]` : '[audio]'),
        );
        break;
      case 'video':
        segments.push(
          (await storedDescriptor(part, options.fileStore)) ??
            (part.durationMs !== undefined ? `[video: ${part.durationMs}ms]` : '[video]'),
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
  const candidate = normalizeMimeHint(part.mimeType)
    ?? normalizeMimeHint(mimeFromDataUri(part.dataUri))
    ?? mimeHintFromFilename(part.url);
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

/**
 * Render a stored file/audio/video descriptor line when the optional
 * `fileStore` hook persists the part's local bytes. Returns `undefined`
 * (fall back to the placeholder) on no local bytes, a missing hook, an
 * unrecognized result, or a hook failure — delivery never breaks.
 */
async function storedDescriptor(
  part: StoredBinaryPart,
  fileStore?: FileStoreHook,
): Promise<string | undefined> {
  if (!fileStore || !part.localData || part.localData.byteLength === 0) return undefined;
  try {
    const descriptor = await fileStore(part);
    return descriptor ? renderDescriptor(descriptor) : undefined;
  } catch {
    return undefined;
  }
}

function renderDescriptor(asset: ChannelFileDescriptor): string {
  const mime = asset.mimeType ? ' ' + asset.mimeType : '';
  const readable = asset.readable ? ' readable' : '';
  return `[attachment ${asset.attachmentId} ${asset.name}${mime} ${humanSize(asset.bytes)}${readable}]`;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  const kb = bytes / 1024;
  if (kb < 1024) return kb.toFixed(1) + ' KB';
  return (kb / 1024).toFixed(1) + ' MB';
}
