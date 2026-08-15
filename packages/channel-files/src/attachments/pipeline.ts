import { randomUUID } from 'node:crypto';
import type { MessagePart } from '@wsz987/channel-core';
import type { ChannelInboundAssetStore } from './store.js';
import { sanitizeFilename } from './filename.js';
import type {
  StoredAssetDescriptor,
  ChannelAssetKind,
  AssetExtraction,
  StoredChannelAsset,
} from './types.js';

export interface AttachmentContext {
  sessionId: string;
  channelId: string;
  accountId: string;
  conversationId: string;
  conversationType?: 'dm' | 'group';
  threadId?: string;
  messageId: string;
}

export interface AttachmentExtractorHook {
  extract(input: {
    store: ChannelInboundAssetStore;
    asset: StoredChannelAsset;
    data: Uint8Array;
    signal?: AbortSignal;
  }): Promise<AssetExtraction>;
}

export interface StoreBinaryPartOptions {
  extractor?: AttachmentExtractorHook;
  signal?: AbortSignal;
}

function initialExtraction(kind: ChannelAssetKind): AssetExtraction {
  return kind === 'file' ? { status: 'not-needed' } : { status: 'unsupported' };
}

/** Store one channel-neutral file/audio/video part and optionally extract it. */
export async function storeBinaryPart(
  store: ChannelInboundAssetStore,
  context: AttachmentContext,
  part: Extract<MessagePart, { type: 'file' | 'audio' | 'video' }>,
  options: StoreBinaryPartOptions = {},
): Promise<StoredAssetDescriptor | undefined> {
  if (!part.localData || part.localData.byteLength === 0) return undefined;
  const asset = await store.put({
    attachmentId: 'att-' + randomUUID(),
    sessionId: context.sessionId,
    channelId: context.channelId,
    accountId: context.accountId,
    conversationId: context.conversationId,
    ...(context.conversationType ? { conversationType: context.conversationType } : {}),
    ...(context.threadId ? { threadId: context.threadId } : {}),
    messageId: context.messageId,
    kind: part.type,
    name: sanitizeFilename(part.name),
    mimeType: part.mimeType,
    data: part.localData,
    extraction: initialExtraction(part.type),
  });

  let extraction = asset.extraction;
  if (part.type === 'file' && options.extractor && asset.mimeType) {
    try {
      extraction = await options.extractor.extract({
        store,
        asset,
        data: part.localData,
        signal: options.signal,
      });
    } catch {
      if (store.recordExtraction) {
        try {
          await store.recordExtraction(asset.attachmentId, {
            status: 'failed',
            errorCode: 'parser-error',
          });
          extraction = { status: 'failed', errorCode: 'parser-error' };
        } catch {
          // File delivery remains best-effort even if extraction metadata fails.
        }
      }
    }
  }

  return {
    attachmentId: asset.attachmentId,
    name: asset.name,
    mimeType: asset.mimeType,
    bytes: asset.bytes,
    durable: true,
    readable: extraction.status === 'ready',
  };
}

