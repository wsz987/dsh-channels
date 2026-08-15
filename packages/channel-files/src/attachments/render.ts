/**
 * User-visible descriptor rendering (plan \u00a754).
 *
 * Each stored asset appears on the model surface ONLY as a compact line: the
 * attachment id, filename, MIME, size and whether the extracted text is ready.
 * The extracted text itself is NEVER embedded here (M4 exposes it through the
 * `read_channel_attachment` tool instead).
 */
import type { StoredAssetDescriptor } from './types.js';

/** Human/readable size, e.g. "1.2 MB" or "340 B". */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  const kb = bytes / 1024;
  if (kb < 1024) return kb.toFixed(1) + ' KB';
  const mb = kb / 1024;
  return mb.toFixed(1) + ' MB';
}

/** Compact declarative descriptor (attachment id, name, mime, size, readable). */
export function renderDescriptor(asset: StoredAssetDescriptor): string {
  const mime = asset.mimeType ? ' ' + asset.mimeType : '';
  const readable = asset.readable ? ' readable' : '';
  return `[attachment ${asset.attachmentId} ${asset.name}${mime} ${humanSize(asset.bytes)}${readable}]`;
}

/** Structured object form (the non-raw shape M4 can extend). */
export function descriptorObject(asset: StoredAssetDescriptor): Record<string, unknown> {
  return {
    attachmentId: asset.attachmentId,
    name: asset.name,
    mimeType: asset.mimeType,
    bytes: asset.bytes,
    durable: asset.durable,
    readable: asset.readable,
  };
}
