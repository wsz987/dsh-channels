import { join } from 'node:path';
import { resolveChannelDataDirectory } from '@wsz987/channel-core';

/**
 * One on-disk directory segment for an attachment id.
 *
 * Raw harness attachment ids may carry characters that are illegal in
 * Windows path segments (the content-addressed `sha256:...` form, issue #7).
 * Only the unsafe set is encoded deterministically - legacy `att-*` ids and
 * every plain id map to themselves, so existing stores keep their on-disk
 * layout. Must stay in sync with every path this store derives from an id.
 */
export function assetPathSegment(attachmentId: string): string {
  return attachmentId.replace(/[<>:"/\|?*\u0000-\u001f]/g, (char) => {
    return '_' + char.charCodeAt(0).toString(16).padStart(2, '0') + '_';
  });
}

export function resolveAttachmentsRoot(): string {
  return join(resolveChannelDataDirectory(), 'attachments', 'v1');
}

export function resolveAssetDirectory(
  attachmentId: string,
  sessionId: string,
  messageId: string,
): string {
  return join(resolveAttachmentsRoot(), 'sessions', sessionId, messageId, assetPathSegment(attachmentId));
}
