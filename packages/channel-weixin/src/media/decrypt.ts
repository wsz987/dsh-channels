/**
 * WX5 media scaffold — AES-128-ECB helpers (node:crypto) and typed stubs.
 *
 * The upstream CDN spec is not yet pinned to a full implementation, so the
 * end-to-end media path throws `WX5 not implemented`. The crypto helpers here
 * are provided exactly where the doc specifies them.
 */
import { createDecipheriv } from 'node:crypto';

/** AES-128-ECB decrypt (PKCS#7 padding). `key` may be 16 raw bytes or hex. */
export function aes128Decrypt(ciphertext: Buffer, key: Buffer | string): Buffer {
  const keyBuf = typeof key === 'string' ? Buffer.from(key, 'hex') : key;
  if (keyBuf.length !== 16) {
    throw new Error('aes128Decrypt: AES-128 key must be 16 bytes');
  }
  const decipher = createDecipheriv('aes-128-ecb', keyBuf, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Marker error thrown by not-yet-implemented WX5 media operations. */
export function wx5NotImplemented(operation: string): never {
  throw new Error(`WX5 media not implemented: ${operation}`);
}
