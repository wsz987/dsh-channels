/**
 * Legacy -> Catalog v2 backfill builder.
 *
 * A pure function mapping a `StoredChannelAsset` (schemaVersion 1) to an
 * `AttachmentCatalogRecordV2` that points `storage.backend` at `channel-v1`.
 * It only RE-INDEXES already-stored v1 data — it never rewrites or moves the
 * v1 tree (旧数据不动 / 新 writer 写最新格式 / 旧 reader 永远兼容).
 *
 * This module performs NO file I/O by design: constructing the in-memory
 * record is pure; all store I/O lives in `catalog/store.ts`.
 */
import type { StoredChannelAsset } from '../attachments/types.js';
import {
  CATALOG_SCHEMA_VERSION,
  type AttachmentCatalogRecordV2,
} from './types.js';

/**
 * Guard: only generic (non-image) kinds can be cataloged. Images never enter
 * the v1 store (the image mirror writes live assets only, issue #7), so this
 * stays a type-level contract: the catalog v2 `file.kind` vocabulary is
 * file/audio/video.
 */
export function isCatalogableLegacyKind(
  asset: StoredChannelAsset,
): asset is StoredChannelAsset & { kind: 'file' | 'audio' | 'video' } {
  return asset.kind === 'file' || asset.kind === 'audio' || asset.kind === 'video';
}

/**
 * Build the catalog v2 index record for an existing legacy v1 asset.
 *
 * - `storage.backend` -> `'channel-v1'` (bytes still live in `attachments/v1`).
 * - `migration.sourceBackend` -> `'channel-v1'` records where this record
 *   originated; no `migratedAt` / `verifiedAt` (nothing migrated yet).
 * - provenance / file fields map 1:1 from the legacy metadata.
 * - Fails loud on non-catalogable kinds (e.g. the issue #7 image mirror) —
 *   v1 trees can never contain them.
 */
export function buildCatalogRecordFromLegacy(
  asset: StoredChannelAsset,
): AttachmentCatalogRecordV2 {
  if (!isCatalogableLegacyKind(asset)) {
    throw new Error(`legacy catalog backfill received a non-catalogable kind '${asset.kind}'`);
  }
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    attachmentId: asset.attachmentId,
    owner: { sessionId: asset.sessionId },
    provenance: {
      channelId: asset.channelId,
      accountId: asset.accountId,
      conversationId: asset.conversationId,
      ...(asset.conversationType ? { conversationType: asset.conversationType } : {}),
      ...(asset.threadId ? { threadId: asset.threadId } : {}),
      messageId: asset.messageId,
    },
    file: {
      kind: asset.kind,
      name: asset.name,
      ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
      bytes: asset.bytes,
      sha256: asset.sha256,
    },
    storage: { backend: 'channel-v1' },
    migration: { sourceBackend: 'channel-v1' },
    createdAt: asset.createdAt,
  };
}