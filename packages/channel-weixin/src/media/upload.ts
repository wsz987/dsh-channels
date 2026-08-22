/**
 * Classification: C — duplicate media upload pipeline [@deprecated upstream-gap].
 *
 * getuploadurl → AES-128-ECB encrypt → CDN POST. The official composed flow
 * cdn/upload.js + cdn/cdn-upload.js is OpenClaw coupled (imports api/api +
 * util/logger). The crypto step is a local source-port. NOTE: the official
 * media_type values and upload sizing follow Tencent/openclaw-weixin v2.4.6:
 * IMAGE=1 and `filesize` is the AES-128-ECB PKCS#7 ciphertext length. Marked
 * upstream-gap because the Tencent package itself remains OpenClaw-coupled.
 */
/**
 * WX5 media — CDN upload (WX5.1 Image outbound).
 *
 * 1. Ask the getuploadurl CGI for an upload slot (upload_full_url + upload_param).
 * 2. AES-128-ECB encrypt the file body with a fresh random 16-byte key.
 * 3. Upload the ciphertext to the slot; the encrypted size is recorded.
 * 4. Return the reference fields the sendmessage item embeds.
 */
import { createHash, randomBytes } from 'node:crypto';
import { ChannelError } from '@wsz987/channel-core';
import { aes128Encrypt } from './encrypt.js';
import type { ILinkGetUploadUrlResponse } from '../ilink/types.js';
import { getUploadUrlResponseSchema, responseEnvelopeSchema } from '../ilink/schema.js';
import { buildHeaders } from '../ilink/headers.js';

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
  downloadEncryptedQueryParam: string;
  /** AES-128 key encoded as 32 lowercase hex characters. */
  aeskey: string;
  /** Plaintext file size in bytes. */
  fileSize: number;
  /** AES-128-ECB PKCS#7 ciphertext size in bytes. */
  fileSizeCiphertext: number;
}

export const WX5_MEDIA_TYPE_IMAGE = 1;
export const WX5_MEDIA_TYPE_VIDEO = 2;
export const WX5_MEDIA_TYPE_FILE = 3;
export const WX5_MEDIA_TYPE_VOICE = 4;

interface PreparedUpload {
  aeskey: Buffer;
  ciphertext: Buffer;
}

/** AES-128-ECB always emits one PKCS#7 block, including for block-aligned input. */
export function aesEcbPaddedSize(size: number): number {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError('aesEcbPaddedSize: size must be a non-negative safe integer');
  }
  return (Math.floor(size / 16) + 1) * 16;
}

export function buildUploadUrlRequest(
  file: Buffer,
  opts: UploadMediaOptions,
  prepared: PreparedUpload = prepareUpload(file),
): Record<string, unknown> {
  const md5 = createHash('md5').update(file).digest('hex');
  const ts = opts.now ? opts.now() : Date.now();
  return {
    filekey: opts.filekey ?? ('wx5-' + md5 + '-' + ts),
    media_type: opts.mediaType ?? WX5_MEDIA_TYPE_IMAGE,
    to_user_id: opts.toUserId,
    rawsize: file.length,
    rawfilemd5: md5,
    filesize: prepared.ciphertext.length,
    no_need_thumb: true,
    aeskey: prepared.aeskey.toString('hex'),
    base_info: {},
  };
}

export async function uploadMedia(file: Buffer, opts: UploadMediaOptions): Promise<UploadedMedia> {
  if (file.length === 0) {
    throw new ChannelError('CHANNEL_UNSUPPORTED', 'uploadMedia: cannot upload an empty file');
  }

  // The upload slot is bound to the exact AES key and padded ciphertext size.
  const prepared = prepareUpload(file);
  const request = buildUploadUrlRequest(file, opts, prepared);
  const getUploadUrl = opts.getUploadUrl ?? (async (req: Record<string, unknown>) => {
    const url = opts.apiBaseUrl.replace(/\/$/, '') + '/ilink/bot/getuploadurl';
    const response = await globalThis.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...buildHeaders({ token: opts.token }) },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new ChannelError('CHANNEL_ERROR', 'getuploadurl http ' + response.status);
    return response.json();
  });
  const rawUploadSlot: unknown = await getUploadUrl(request);
  const envelope = responseEnvelopeSchema.safeParse(rawUploadSlot);
  if (envelope.success &&
      ((envelope.data.ret !== undefined && envelope.data.ret !== 0) ||
       (envelope.data.errcode !== undefined && envelope.data.errcode !== 0))) {
    const code = envelope.data.ret !== undefined && envelope.data.ret !== 0
      ? `ret=${envelope.data.ret}`
      : `errcode=${envelope.data.errcode}`;
    throw new ChannelError('CHANNEL_ERROR', `uploadMedia: getuploadurl returned ${code}`);
  }
  const parsedUploadSlot = getUploadUrlResponseSchema.safeParse(rawUploadSlot);
  if (!parsedUploadSlot.success) {
    throw new ChannelError('CHANNEL_ERROR', 'uploadMedia: getuploadurl returned an invalid response shape');
  }
  const uploadSlot = parsedUploadSlot.data;

  if (!uploadSlot.upload_full_url && !uploadSlot.upload_param) {
    throw new ChannelError('CHANNEL_UNSUPPORTED', 'uploadMedia: getuploadurl returned no upload slot');
  }

  const form = new FormData();
  if (uploadSlot.thumb_upload_param) form.append('thumb_upload_param', uploadSlot.thumb_upload_param);
  if (uploadSlot.upload_param) form.append('upload_param', uploadSlot.upload_param);
  form.append('file', new Blob([prepared.ciphertext]));

  const upload = opts.upload ?? ((url: string, body: FormData) => globalThis.fetch(url, { method: 'POST', body }));
  const uploadUrl = uploadSlot.upload_full_url ?? buildCdnUploadUrl(opts.cdnBaseUrl, uploadSlot.upload_param!, String(request.filekey));
  const response = await upload(uploadUrl, form);
  if (!response.ok) throw new ChannelError('CHANNEL_ERROR', 'cdn upload http ' + response.status);
  const downloadEncryptedQueryParam = response.headers.get('x-encrypted-param');
  if (!downloadEncryptedQueryParam) {
    throw new ChannelError('CHANNEL_ERROR', 'cdn upload response missing x-encrypted-param header');
  }

  return {
    filekey: String(request.filekey),
    uploadFullUrl: uploadSlot.upload_full_url,
    downloadEncryptedQueryParam,
    aeskey: prepared.aeskey.toString('hex'),
    fileSize: file.length,
    fileSizeCiphertext: prepared.ciphertext.length,
  };
}

function prepareUpload(file: Buffer): PreparedUpload {
  const aeskey = randomBytes(16);
  const ciphertext = aes128Encrypt(file, aeskey);
  if (ciphertext.length !== aesEcbPaddedSize(file.length)) {
    throw new Error('uploadMedia: unexpected AES-128-ECB ciphertext size');
  }
  return { aeskey, ciphertext };
}

function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string {
  const base = cdnBaseUrl.replace(/\/+$/, '');
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}
