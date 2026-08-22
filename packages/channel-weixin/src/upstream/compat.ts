/**
 * compat.ts — glue that maps between the official upstream shapes and the
 * `WeixinUpstream` port (execution plan §7/§38).
 *
 * THIS FILE CONTAINS SHAPE MAPPING ONLY — no protocol logic, no AES, no token /
 * retry / reconnect / upload-algorithm implementation. Those rules live behind
 * `upstream-gap` markers in tencent-upstream.ts. If a mapping needs real
 * protocol behavior, it delegates to that implementation — it never
 * reimplements a wire rule here.
 */
import type { WeixinMediaRef, WeixinDownloadResult } from './port.js';
import type { ILinkCDNMedia } from '../ilink/types.js';

/**
 * Standardize a media download reference into the neutral `WeixinMediaRef`.
 * Accepts both the port shape (from the adapter) and a raw iLink CDN media
 * reference (from the monitor's mapped item) so callers stay shape-agnostic.
 */
export interface NormalizedMediaRef {
  cdnBaseUrl?: string;
  fullUrl?: string;
  encryptQueryParam?: string;
  /** 16-byte raw AES key (already decoded hex → bytes). */
  aesKey?: Buffer | string;
  /** base64 AES key as carried on the wire. */
  aesKeyBase64?: string;
  mimeType?: string;
}

/** Convert a raw iLink CDN media reference + item aeskey into a normalized ref. */
export function normalizeMediaRef(
  media: ILinkCDNMedia | undefined,
  aesKeyHex: string | undefined,
  opts: { cdnBaseUrl?: string; mimeType?: string } = {},
): NormalizedMediaRef | undefined {
  if (!media) return undefined;
  const encryptQueryParam = media.encrypt_query_param;
  const fullUrl = media.full_url;
  if (!fullUrl && !encryptQueryParam) return undefined;
  return {
    cdnBaseUrl: opts.cdnBaseUrl,
    fullUrl,
    encryptQueryParam,
    // item aeskey (hex, preferred) beats media aes_key (base64).
    aesKey: aesKeyHex,
    aesKeyBase64: media.aes_key,
    mimeType: opts.mimeType,
  };
}

/** Map a normalized ref back to the port `WeixinMediaRef`. */
export function toPortMediaRef(ref: NormalizedMediaRef): WeixinMediaRef {
  return {
    cdnBaseUrl: ref.cdnBaseUrl,
    fullUrl: ref.fullUrl,
    encryptQueryParam: ref.encryptQueryParam,
    aesKeyHex: typeof ref.aesKey === 'string' ? ref.aesKey : undefined,
    aesKeyBase64: ref.aesKeyBase64,
    mimeType: ref.mimeType,
  };
}

/**
 * Normalize a decoded download into the port result, preferring the supplied
 * MIME hint when the underlying fetch had none.
 */
export function toDownloadResult(
  data: Buffer,
  mimeHint: string | undefined,
): WeixinDownloadResult {
  return { data: new Uint8Array(data), mimeType: mimeHint };
}

/**
 * Build the CDN media reference embedded into an iLink sendmessage item from an
 * uploaded file's returned fields. Pure shape mapping of the wire reference
 * (Tencent 2.4.6 carries base64 of the ASCII hex key on outbound).
 */
export function toSendMediaRef(uploaded: {
  downloadEncryptedQueryParam?: string;
  aeskey?: string;
  fullUrl?: string;
}): { encrypt_query_param?: string; aes_key?: string; full_url?: string } {
  const ref: { encrypt_query_param?: string; aes_key?: string; full_url?: string } = {};
  if (uploaded.downloadEncryptedQueryParam) {
    ref.encrypt_query_param = uploaded.downloadEncryptedQueryParam;
  }
  if (uploaded.aeskey) {
    ref.aes_key = Buffer.from(uploaded.aeskey, 'ascii').toString('base64');
  }
  if (uploaded.fullUrl) ref.full_url = uploaded.fullUrl;
  return ref;
}
