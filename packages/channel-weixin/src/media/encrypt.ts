/**
 * WX5 media — AES-128-ECB encrypt.
 *
 * Tencent's published plugin is OpenClaw-coupled and cannot be used as a DSH
 * runtime dependency. This small source-port intentionally uses Node crypto.
 */
import { createCipheriv } from 'node:crypto';

/** AES-128-ECB encrypt (PKCS#7 padding). `key` may be 16 raw bytes or hex. */
export function aes128Encrypt(plaintext: Buffer, key: Buffer | string): Buffer {
  const keyBuf = typeof key === 'string' ? Buffer.from(key, 'hex') : key;
  if (keyBuf.length !== 16) throw new Error('aes128Encrypt: AES-128 key must be 16 bytes');
  const cipher = createCipheriv('aes-128-ecb', keyBuf, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
