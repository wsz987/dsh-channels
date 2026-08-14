/**
 * WX5 media scaffold — CDN upload. Typed stub; throws while the CDN spec is
 * not pinned.
 */
import { wx5NotImplemented } from './decrypt.js';

export interface UploadMediaOptions {
  cdnBaseUrl: string;
  /** Base URL for the getuploadurl CGI. */
  apiBaseUrl: string;
  token?: string;
  toUserId?: string;
  filekey?: string;
}

export interface UploadedMedia {
  filekey: string;
  uploadFullUrl?: string;
  downloadEncryptedQueryParam?: string;
  aeskey?: string;
  fileSizeCiphertext?: number;
}

/** Upload a file to the Weixin CDN. */
export async function uploadMedia(_file: Buffer, _opts: UploadMediaOptions): Promise<UploadedMedia> {
  return wx5NotImplemented('uploadMedia');
}
