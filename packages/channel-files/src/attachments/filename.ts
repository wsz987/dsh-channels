/**
 * Filename sanitization for stored channel assets (plan \u00a747).
 *
 * A platform-supplied name is a hint from an untrusted boundary: it may carry
 * path separators, control characters, leading dots or a bogus extension. We
 * keep a safe, short basename plus its extension and NEVER let it influence
 * the on-disk path (the store lays files out under generated attachment ids,
 * so the sanitized name only appears in metadata).
 */
import { extname } from 'node:path';

/** Strip control characters (including NUL) from a rendered string. */
export function stripControlChars(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\u0000-\u001f\u007f]/g, '');
}

/**
 * Sanitize a channel-provided filename into a safe display basename.
 *
 * - removes any path separators (`/`, `\\`) and drive/colon prefixes;
 * - strips control characters;
 * - strips leading dots and trims;
 * - removes Windows-reserved characters along with trailing dots/spaces;
 * - limits the whole name to `maxLength` bytes-safe characters (the extension
 *   is preserved);
 * - falls back to a default stem when nothing survives.
 */
export function sanitizeFilename(
  input: string | undefined,
  options: { maxLength?: number; fallback?: string } = {},
): string {
  const maxLength = options.maxLength ?? 80;
  const fallback = options.fallback ?? 'attachment';
  if (!input) return fallback;
  // 1. Drop any path separator so a name can never traverse or hide a subpath.
  let name = stripControlChars(input).replace(/[\\/]/g, '');
  // 2. Strip a windows-ish drive prefix ("C:" ...) and leading dots.
  name = name.replace(/^[a-zA-Z]:/, '').replace(/^\.+/, '');
  name = name.trim();
  // 3. Remove Windows-reserved characters and trailing dots/spaces.
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[<>:"|?*\u0000-\u001f\u007f]/g, '');
  name = name.replace(/[. ]+$/g, '');
  if (!name) return fallback;

  // Preserve the extension but bound the whole name.
  const ext = extname(name); // ".pdf"
  const stem = name.slice(0, name.length - ext.length);
  if (stem.length === 0) return (ext || fallback).slice(0, maxLength);
  const budget = Math.max(1, maxLength - ext.length);
  const kept = stem.slice(0, budget);
  return kept + ext;
}

/**
 * Normalize an adapter-provided MIME hint into a safe token. Returns
 * `undefined` when the hint is missing or clearly invalid.
 */
export function normalizeMimeHint(mimeType: string | undefined): string | undefined {
  if (!mimeType) return undefined;
  const m = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.exec(mimeType.trim());
  return m ? m[0].toLowerCase() : undefined;
}

