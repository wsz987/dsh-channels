import { join } from 'node:path';
import { resolveChannelDataDirectory } from '@wsz987/channel-core';

export function resolveAttachmentsRoot(): string {
  return join(resolveChannelDataDirectory(), 'attachments', 'v1');
}

export function resolveAssetDirectory(
  attachmentId: string,
  sessionId: string,
  messageId: string,
): string {
  return join(resolveAttachmentsRoot(), 'sessions', sessionId, messageId, attachmentId);
}
