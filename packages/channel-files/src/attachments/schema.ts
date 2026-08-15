/**
 * Zod schema for `meta.json` — used to validate a `StoredChannelAsset` when it
 * is read back from disk (plan \u00a745 / \u00a747). Anything that fails this
 * schema is treated as missing/corrupt rather than partially trusted.
 */
import { z } from 'zod';
import { ASSET_SCHEMA_VERSION, type StoredChannelAsset } from './types.js';

const extractionStatusSchema = z.enum([
  'not-needed',
  'ready',
  'unsupported',
  'failed',
  'too-large',
]);

const extractionSchema = z.object({
  status: extractionStatusSchema,
  format: z.enum(['text', 'markdown']).optional(),
  bytes: z.number().int().nonnegative().optional(),
  errorCode: z.string().optional(),
});

export const StoredChannelAssetSchema = z.object({
  schemaVersion: z.literal(ASSET_SCHEMA_VERSION),
  attachmentId: z.string().min(1),
  sessionId: z.string().min(1),
  channelId: z.string().min(1),
  accountId: z.string().min(1),
  conversationId: z.string().min(1),
  conversationType: z.enum(['dm', 'group']).optional(),
  threadId: z.string().optional(),
  messageId: z.string().min(1),
  kind: z.enum(['file', 'audio', 'video']),
  name: z.string().min(0),
  mimeType: z.string().optional(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  extraction: extractionSchema,
  createdAt: z.number(),
});

/** Parse and validate a stored asset from parsed JSON meta. */
export function parseStoredChannelAsset(value: unknown): StoredChannelAsset {
  return StoredChannelAssetSchema.parse(value) as StoredChannelAsset;
}

/** Type-safe structured parse (throws ZodError on mismatch). */
export function parseStoredChannelAssetSafe(
  value: unknown,
): { ok: true; value: StoredChannelAsset } | { ok: false; error: unknown } {
  const result = StoredChannelAssetSchema.safeParse(value);
  if (result.success) return { ok: true, value: result.data as StoredChannelAsset };
  return { ok: false, error: result.error };
}
