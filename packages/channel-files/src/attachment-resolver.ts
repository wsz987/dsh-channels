/**
 * Outbound attachment resolution (plan §63 / §64).
 *
 * `resolveAttachment` turns a private-store `attachment_id` into bounded raw
 * bytes for an outbound file part, enforcing the Session ACL (the asset's
 * `sessionId` must equal the sender's session). The outbound path is
 * by-private-store-id ONLY: there is NO model-visible `file_path` anywhere in
 * this milestone (plan §64), so the resolver never touches a filesystem path —
 * the store owns byte access.
 */
import type { ChannelInboundAssetStore } from './attachments/store.js';
import { AssetStoreError } from './attachments/store.js';
import { DEFAULT_ATTACHMENT_POLICY, rawReadLimit, type AttachmentPolicy } from './attachments/policy.js';
import { OutboxError } from '@wsz987/channel-harness';

/** Byte cap applied when the caller supplies no explicit policy. */
const DEFAULT_BOUND: AttachmentPolicy = DEFAULT_ATTACHMENT_POLICY;

export interface ResolvedOutboundAttachment {
  data: Uint8Array;
  name: string;
  mimeType: string | undefined;
}

/**
 * Resolve a private-store attachment id to bounded bytes for an outbound send
 * (plan §63). ACL: the asset must be owned by `sessionId`. Oversize reads
 * surface `ATTACHMENT_TOO_LARGE`; a missing asset `ATTACHMENT_NOT_FOUND`;
 * a foreign asset `ATTACHMENT_ACCESS_DENIED`.
 */
export async function resolveAttachment(
  attachmentId: string,
  sessionId: string,
  store: ChannelInboundAssetStore,
  options: { policy?: AttachmentPolicy },
): Promise<ResolvedOutboundAttachment> {
  const asset = await store.get(attachmentId);
  if (!asset) {
    throw new OutboxError('ATTACHMENT_NOT_FOUND', "no stored asset for '" + attachmentId + "'", { sessionId });
  }
  if (asset.sessionId !== sessionId) {
    throw new OutboxError(
      'ATTACHMENT_ACCESS_DENIED',
      "attachment '" + attachmentId + "' belongs to a different session",
      { sessionId },
    );
  }
  const limit = rawReadLimit(options.policy ?? DEFAULT_BOUND);
  let data: Uint8Array;
  try {
    data = await store.readRaw(attachmentId, { maxBytes: limit });
  } catch (error) {
    if (error instanceof AssetStoreError && error.code === 'ASSET_TOO_LARGE') {
      throw new OutboxError(
        'ATTACHMENT_TOO_LARGE',
        "attachment '" + attachmentId + "' exceeds the outbound size cap " + limit,
        { sessionId, cause: error },
      );
    }
    throw error;
  }
  return { data, name: asset.name, mimeType: asset.mimeType };
}
