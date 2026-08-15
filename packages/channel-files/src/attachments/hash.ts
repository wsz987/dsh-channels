/**
 * SHA-256 helpers for the private channel asset store (plan \u00a747).
 */
import { createHash } from 'node:crypto';

/** Hex-encoded SHA-256 of the given bytes. */
export function sha256Hex(bytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Hex-encoded SHA-256 of a UTF-8 string. */
export function sha256HexText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
