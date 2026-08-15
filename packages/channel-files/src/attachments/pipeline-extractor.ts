/**
 * M4 pipeline extraction hook (plan §48 / §49 / §50).
 *
 * The concrete AttachmentExtractorHook used by the bridge: drives the
 * extractor registry (attemptExtraction) and persists the outcome through
 * the store — putExtracted for ready, recordExtraction for unsupported /
 * failed / too-large. Never throws (best-effort, plan §41): every failure
 * collapses to a typed extraction state.
 */
import { extname } from 'node:path';
import { attemptExtraction } from './extractors/registry.js';
import { type AttachmentPolicy } from './policy.js';
import type { AttachmentExtractorHook } from './pipeline.js';
import type { ChannelInboundAssetStore } from './store.js';
import type { AssetExtraction, StoredChannelAsset } from './types.js';

/**
 * Create the registry-backed extraction hook for a given policy.
 * Extraction can be disabled by not attaching the hook to the pipeline.
 */
export function createAttachmentExtractor(policy: AttachmentPolicy): AttachmentExtractorHook {
  return {
    async extract(input: {
      store: ChannelInboundAssetStore;
      asset: StoredChannelAsset;
      data: Uint8Array;
      signal?: AbortSignal;
    }): Promise<AssetExtraction> {
      const { store, asset, data, signal } = input;
      const extension = extname(asset.name).replace(/^\./, '') || undefined;
      const attempt = await attemptExtraction({
        mime: asset.mimeType,
        extension,
        data,
        caps: policy.extract,
        signal,
      });
      switch (attempt.status) {
        case 'ready': {
          const bytes = new TextEncoder().encode(attempt.result.text).byteLength;
          const stored = await store.putExtracted(asset.attachmentId, {
            text: attempt.result.text,
            format: attempt.result.format,
            bytes,
          });
          return (
            stored?.extraction ?? {
              status: 'ready' as const,
              format: attempt.result.format,
              bytes,
            }
          );
        }
        case 'unsupported':
          await record(store, asset.attachmentId, { status: 'unsupported' });
          return { status: 'unsupported' };
        case 'too-large':
          await record(store, asset.attachmentId, { status: 'too-large' });
          return { status: 'too-large' };
        case 'failed':
          await record(store, asset.attachmentId, { status: 'failed', errorCode: attempt.errorCode });
          return { status: 'failed', errorCode: attempt.errorCode };
      }
    },
  };
}

/** Record a non-ready extraction status through the store (additive-safe). */
async function record(
  store: ChannelInboundAssetStore,
  attachmentId: string,
  extraction: AssetExtraction,
): Promise<void> {
  if (store.recordExtraction) {
    await store.recordExtraction(attachmentId, extraction);
  }
}
