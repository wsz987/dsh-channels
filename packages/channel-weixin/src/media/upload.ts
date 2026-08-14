/**
 * WX5 media — CDN upload (WX5.1 Image outbound).
 *
 * 1. Ask the getuploadurl CGI for an upload slot (upload_full_url + upload_param).
 * 2. AES-128-ECB encrypt the file body with a fresh random 16-byte key.
 * 3. Upload the ciphertext to the slot; the encrypted size is recorded.
 * 4. Return the reference fields the sendmessage item embeds.
 */
import { createHash, randomBytes } from 'node:crypto';
import { ChannelError } from '@dsh/channel-core';
import { aes128Encrypt } from './encrypt.js';
import type { ILinkGetUploadUrlResponse } from '../ilink/types.js';

export interface UploadMediaOptions {
  cdnBaseUrl: string;
  /** Base URL for the getuploadurl CGI. */
  apiBaseUrl: string;
  token?: string;
  toUserId?: string;
  filekey?: string;
  mediaType?: number;
  getUploadUrl?: (request: Record<string, unknown>) => Promise<ILinkGetUploadUrlResponse>;
  upload?: (url: string, form: FormData) => Promise<Response>;
  now?: () => number;
}

export interface UploadedMedia {
  filekey: string;
  uploadFullUrl?: string;
  downloadEncryptedQueryParam?: string;
  aeskey?: string;
  fileSizeCiphertext?: number;
}

export const WX5_MEDIA_TYPE_IMAGE = 2;

export function buildUploadUrlRequest(file: Buffer, opts: UploadMediaOptions): Record<string, unknown> {
  const md5 = createHash('md5').update(file).digest('hex');
  const ts = opts.now ? opts.now() : Date.now();
  return {
    filekey: opts.filekey ?? ('wx5-' + md5 + '-' + ts),
    media_type: opts.mediaType ?? WX5_MEDIA_TYPE_IMAGE,
    to_user_id: opts.toUserId,
    rawsize: file.length,
    rawfilemd5: md5,
    filesize: file.length,
    no_need_thumb: true,
    base_info: {},
  };
}

export async function uploadMedia(file: Buffer, opts: UploadMediaOptions): Promise<UploadedMedia> {
  if (file.length === 0) {
    throw new ChannelError('CHANNEL_UNSUPPORTED', 'uploadMedia: cannot upload an empty file');
  }

  const request = buildUploadUrlRequest(file, opts);
  const getUploadUrl = opts.getUploadUrl ?? (async (req: Record<string, unknown>) => {
    const url = opts.apiBaseUrl.replace(/\/$/, '') + '/ilink/bot/getuploadurl';
    const response = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new ChannelError('CHANNEL_ERROR', 'getuploadurl http ' + response.status);
    return (await response.json()) as ILinkGetUploadUrlResponse;
  });
  const uploadSlot = await getUploadUrl(request);

  if (!uploadSlot.upload_full_url || !uploadSlot.upload_param) {
    throw new ChannelError('CHANNEL_UNSUPPORTED', 'uploadMedia: getuploadurl returned no upload slot');
  }

  const key = randomBytes(16);
  const ciphertext = aes128Encrypt(file, key);

  const form = new FormData();
  if (uploadSlot.thumb_upload_param) form.append('thumb_upload_param', uploadSlot.thumb_upload_param);
  form.append('upload_param', uploadSlot.upload_param);
  form.append('file', new Blob([ciphertext]));

  const upload = opts.upload ?? ((url: string, body: FormData) => globalThis.fetch(url, { method: 'POST', body }));
  const response = await upload(uploadSlot.upload_full_url, form);
  if (!response.ok) throw new ChannelError('CHANNEL_ERROR', 'cdn upload http ' + response.status);

  return {
    filekey: String(request.filekey),
    uploadFullUrl: uploadSlot.upload_full_url,
    downloadEncryptedQueryParam: uploadSlot.upload_param,
    aeskey: key.toString('hex'),
    fileSizeCiphertext: ciphertext.length,
  };
}
