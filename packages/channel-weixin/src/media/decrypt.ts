/**
 * WX5 media — AES-128-ECB decrypt.
 *
 * Tencent's published plugin is OpenClaw-coupled and cannot be used as a DSH
 * runtime dependency. This small source-port intentionally uses Node crypto.
 */
import { createDecipheriv } from 'node:crypto';

/** AES-128-ECB decrypt (PKCS#7 padding). `key` may be 16 raw bytes or hex. */
export function aes128Decrypt(ciphertext: Buffer, key: Buffer | string): Buffer {
  const keyBuf = typeof key === 'string' ? Buffer.from(key, 'hex') : key;
  if (keyBuf.length !== 16) throw new Error('aes128Decrypt: AES-128 key must be 16 bytes');
  const decipher = createDecipheriv('aes-128-ecb', keyBuf, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
