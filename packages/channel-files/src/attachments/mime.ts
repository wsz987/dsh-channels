/**
 * MIME detection by magic-signature sniffing (plan \u00a747).
 *
 * The adapter's `mimeType` is only a HINT from an untrusted boundary. Before
 * we trust what a stored asset claims to be, we re-verify it against the raw
 * bytes' magic signatures. This module recognizes common binary containers
 * (png/jpeg/gif/webp/pdf, OOXML zip members docx/xlsx, and zip) plus runs of
 * printable ASCII/UTF-8 (plain text). Anything unrecognized yields
 * `undefined` and the store keeps the (hint) value as-is.
 */

const TEXT_SCAN_BYTES = 512;

/** Result of a sniff: a re-verified MIME (or undefined when unknown). */
export interface MagicSniffResult {
  mimeType: string | undefined;
  /** True when the bytes were recognized as printable text. */
  isPlainText: boolean;
}

function isUtf8OrAscii(bytes: Uint8Array): boolean {
  // Reject on any NUL / most control chars; accept printable ASCII and valid
  // UTF-8 multi-byte sequences. This is intentionally permissive but blocks
  // null-terminated or binary gibberish.
  const max = Math.min(bytes.length, TEXT_SCAN_BYTES);
  for (let i = 0; i < max; i++) {
    const b = bytes[i]!;
    if (b === 0) return false;
    if (b < 0x09) return false;
    if (b >= 0x7f && (b === 0x7f || (b >= 0x80 && b <= 0xbf && i === 0))) {
      // 0x7f is DEL (control); 0x80-0xbf as a lead byte is invalid.
      return false;
    }
    if (b >= 0xc2 && b <= 0xdf && i + 1 < max && bytes[i + 1]! >= 0x80 && bytes[i + 1]! <= 0xbf) {
      i++; // 2-byte sequence
    } else if (b >= 0xe0 && b <= 0xef && i + 2 < max) {
      const b1 = bytes[i + 1]!;
      const b2 = bytes[i + 2]!;
      if (b1 >= 0x80 && b1 <= 0xbf && b2 >= 0x80 && b2 <= 0xbf) {
        i += 2; // 3-byte sequence
      } else {
        return false;
      }
    } else if (b >= 0xf0 && b <= 0xf4 && i + 3 < max) {
      const b1 = bytes[i + 1]!;
      const b2 = bytes[i + 2]!;
      const b3 = bytes[i + 3]!;
      if (b1 >= 0x80 && b1 <= 0xbf && b2 >= 0x80 && b2 <= 0xbf && b3 >= 0x80 && b3 <= 0xbf) {
        i += 3; // 4-byte sequence
      } else {
        return false;
      }
    }
  }
  return true;
}

/** Inflate a ZIP central directory / local header fingerprint for OOXML. */
function sniffZip(bytes: Uint8Array): string | undefined {
  // ZIP local file header: PK\u0003\u0004 (or empty/fast: PK\u0005\u0006, spanned PK\u0007\u0008).
  if (bytes.length < 4) return undefined;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return undefined;
  if (bytes[2] === 0x03 && bytes[3] === 0x04) {
    // OOXML packages carry "[Content_Types].xml" with the first member often
    // "_rels/.rels". Peek further down for the signature.
    const marker = findAscii(bytes, '_rels/.rels') || findAscii(bytes, '[Content_Types].xml');
    if (marker) {
      if (findAscii(bytes, 'word/')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      if (findAscii(bytes, 'xl/')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      if (findAscii(bytes, 'ppt/')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      return 'application/zip';
    }
    return 'application/zip';
  }
  if ((bytes[2] === 0x05 && bytes[3] === 0x06) || (bytes[2] === 0x07 && bytes[3] === 0x08)) {
    return 'application/zip';
  }
  return undefined;
}

function findAscii(bytes: Uint8Array, token: string): boolean {
  const needle = new TextEncoder().encode(token);
  const scan = Math.min(bytes.length, 4096);
  outer: for (let i = 0; i + needle.length <= scan; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Sniff a re-verified MIME from raw bytes. `hint` (adapter mimeType) is never
 * trusted on its own — it is only used as a tiebreaker/fallback when the magic
 * is ambiguous (e.g. zip). Returns the detected type.
 */
export function sniffMime(bytes: Uint8Array, hint?: string): string | undefined {
  if (!bytes || bytes.length === 0) return undefined;
  const magic = magicMime(bytes, hint);
  if (magic) return magic;
  if (isUtf8OrAscii(bytes)) return hint?.startsWith('text/') ? hint : sniffPlainText(bytes);
  return hint; // unknown binary — keep the adapter hint (best effort).
}

/** Magic-signature detection for the recognized binary containers. */
function magicMime(bytes: Uint8Array, hint?: string): string | undefined {
  // PNG: \u0089PNG\r\n\u001a\n
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e
    && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: GIF87a / GIF89a
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
    && (bytes[3] === 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif';
  }
  // WEBP: RIFF....WEBP
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46
    && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  // PDF: %PDF-
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44
    && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return 'application/pdf';
  }
  return sniffZip(bytes);
}

/** Plain-text detection: pick a textual MIME when bytes look like readable text. */
function sniffPlainText(bytes: Uint8Array): string | undefined {
  // Cheap heuristic: JSON/XML/YAML-ish markers win for the common feed types,
  // otherwise generic text/plain.
  const sample = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(0, TEXT_SCAN_BYTES))
    .trimStart();
  if (sample.startsWith('{') && sample.includes('"')) return 'application/json';
  if (sample.startsWith('<?xml') ) return 'application/xml';
  if (sample.startsWith('#') || sample.includes(': ')) return 'text/plain';
  return 'text/plain';
}

/** Whether the sniffed bytes were recognized as plain readable text. */
export function sniffIsPlainText(bytes: Uint8Array): boolean {
  return bytes.length > 0 && isUtf8OrAscii(bytes);
}

/** Re-verified MIME, preferring magic over the adapter hint (plan \u00a747). */
export function verifiedMime(bytes: Uint8Array, hint?: string): string | undefined {
  const magic = magicMime(bytes, hint);
  if (magic) return magic;
  return sniffMime(bytes, hint);
}
