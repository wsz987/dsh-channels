/**
 * Cross-channel MIME hint helpers.
 *
 * These functions normalize untrusted platform/HTTP metadata and consult the
 * maintained `mime-types` database for filename fallbacks. They do not inspect
 * bytes and therefore never establish trusted content identity; consumers
 * that persist or parse files must verify the bytes at their trust boundary.
 */
import { lookup } from 'mime-types';

const GENERIC_BINARY_MIMES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
]);

/** Normalize a Content-Type-like value into a useful advisory MIME hint. */
export function normalizeMimeHint(value?: string | null): string | undefined {
  const mime = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (!mime || GENERIC_BINARY_MIMES.has(mime)) return undefined;
  return mime;
}

/** Resolve an advisory MIME hint from a filename, URL path, or platform path. */
export function mimeHintFromFilename(value?: string | null): string | undefined {
  if (!value) return undefined;
  const clean = value.split(/[?#]/, 1)[0];
  const result = clean ? lookup(clean) : false;
  return typeof result === 'string' ? normalizeMimeHint(result) : undefined;
}
