/**
 * WX5 media scaffold — CDN download. Typed stub; throws while the CDN spec is
 * not pinned.
 */
import { wx5NotImplemented } from './decrypt.js';
import type { ILinkCDNMedia } from '../ilink/types.js';

export interface DownloadedMedia {
  /** Decrypted plaintext bytes. */
  data: Buffer;
  mimeType?: string;
}

export interface DownloadMediaOptions {
  cdnBaseUrl: string;
  /** Optional AES-128 key (hex) to decrypt after download. */
  aesKey?: string;
}

/** Download an iLink CDN media reference. */
export async function downloadMedia(_media: ILinkCDNMedia, _opts: DownloadMediaOptions): Promise<DownloadedMedia> {
  return wx5NotImplemented('downloadMedia');
}
