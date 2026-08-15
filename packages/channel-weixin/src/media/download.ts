/**
 * Classification: C — duplicate media download orchestration [@deprecated upstream-gap].
 *
 * CDN download + AES decrypt for inbound media. The official composed flow
 * cdn/pic-decrypt.js is OpenClaw coupled (imports util/logger). The developer
 * AES remains a small local source-port because the Tencent plugin is coupled
 * to OpenClaw. The URL
 * resolution here (legacy <cdnBaseUrl>/<encrypt_query_param>) is DSH glue kept
 * for the verified CDN path (official buildCdnDownloadUrl uses a different URL
 * form). Marked upstream-gap for the orchestration; DO NOT delete wholesale.
 */
/**
 * WX5 media — CDN download (WX5.1 Image).
 *
 * Resolves the download URL from `full_url` (server-returned) or the CDN base
 * URL + `encrypt_query_param`, fetches the raw body, then AES-128-ECB decrypts
 * it. The AES key source is resolved in priority order:
 *   1. `aesKey`      — hex (16 bytes) as surfaced on the message item
 *                      (`image_item.aeskey`); preferred per the wire comment.
 *   2. `media.aes_key` — base64-encoded bytes (JSON transport convention).
 */
import { aes128Decrypt } from './decrypt.js';
import type { ILinkCDNMedia } from '../ilink/types.js';

export interface DownloadedMedia {
  /** Decrypted plaintext bytes. */
  data: Buffer;
  mimeType?: string;
}

export interface DownloadMediaOptions {
  cdnBaseUrl: string;
  /** Optional AES-128 key (hex, 16 bytes) to decrypt after download. */
  aesKey?: string;
  /** Optional base64 AES key from the CDN media reference. */
  aesKeyBase64?: string;
  /** Optional MIME type (known from item metadata). */
  mimeType?: string;
  /** Injectable fetch for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/** Resolve the CDN download URL for a media reference. */
export function resolveDownloadUrl(media: ILinkCDNMedia, cdnBaseUrl: string): string | undefined {
  if (media.full_url) return media.full_url;
  const base = cdnBaseUrl.replace(/\/+$/, '');
  if (media.encrypt_query_param) return `${base}/${media.encrypt_query_param}`;
  return undefined;
}

/** Download an iLink CDN media reference and AES-decrypt the body. */
export async function downloadMedia(media: ILinkCDNMedia, opts: DownloadMediaOptions): Promise<DownloadedMedia> {
  const url = resolveDownloadUrl(media, opts.cdnBaseUrl);
  if (!url) {
    throw new Error('downloadMedia: no full_url or encrypt_query_param to resolve a CDN URL');
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`downloadMedia: http ${response.status} on CDN url`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  const key = opts.aesKey ?? opts.aesKeyBase64 ?? media.aes_key ? decodeAesKey(opts, media) : undefined;
  if (!key) {
    return { data: body, mimeType: opts.mimeType };
  }
  return { data: aes128Decrypt(body, key), mimeType: opts.mimeType };
}

/**
 * Decode the AES key honoring the two wire forms: hex (item `aeskey`) and
 * base64 (CDN `aes_key`). `aesKey` (hex) is preferred when present.
 */
function decodeAesKey(opts: DownloadMediaOptions, media: ILinkCDNMedia): string | Buffer {
  if (opts.aesKey) return opts.aesKey;
  const base64 = opts.aesKeyBase64 ?? media.aes_key;
  if (base64) return Buffer.from(base64, 'base64');
  throw new Error('downloadMedia: no AES key to decrypt');
}
