/**
 * Binary hydration for the QQ inbound path (plan §23 / §79A / §85).
 *
 * The mapper stays pure: it preserves the real `attachment.url` on image and
 * generic-file parts (plan §23). This module is the single place that turns a
 * genuine `http(s)` URL into trusted bytes, using the shared
 * `SecureRemoteMediaFetcher` from `@wsz987/channel-core` as the DSH host's
 * generic security boundary (plan §12 / §13). It never implements QQ upload /
 * token / gateway protocol — those belong to `qqbot-nodejs` (plan §23).
 *
 * Native image ingress (M2A) hydrates `image` parts so the harness
 * `saveImage()` / `ImageBlock` path receives real bytes. Generic file
 * ingress (M7B, plan §85) hydrates `file` parts the same way: the produced
 * `localData` is picked up automatically by the harness private asset store
 * + extractor, so the adapter never implements QQ file upload.
 *
 * Key guarantees:
 * - Only parts with `type === 'image'` OR `type === 'file'` AND a genuine
 *   `http(s)` URL are hydrated. A part already carrying `localData` /
 *   `dataUri`, or carrying an opaque `resourceRef`, is left untouched.
 * - On success the part gets `localData` (the downloaded bytes) and
 *   `mimeType` (prefer the fetcher's Content-Type, else keep the platform
 *   hint). File parts also record the hydrated byte length in `size`.
 * - On ANY failure the part is NOT dropped: its `url` is kept, a stable
 *   `ingressFailure` code is set, and hydration of other parts continues.
 *   A download failure must never block text delivery (plan §79A).
 */
import {
  SecureRemoteMediaFetcher,
  mimeHintFromFilename,
  toIngressFailureCode,
} from '@wsz987/channel-core';
import type { BinaryIngressFailureCode, BinaryPartBase, MessagePart } from '@wsz987/channel-core';

/** True when `value` is an absolute `http` / `https` URL. */
function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

export interface ImageHydratorOptions {
  /** Hard byte cap for one download. Defaults to 20 MiB. */
  maxBytes?: number;
  /** Read-idle timeout in ms (no body chunk for this long → fail). Defaults to 15_000. */
  idleTimeoutMs?: number;
  /** Header-probe timeout in ms (no response headers in this long → fail). Defaults to 15_000. */
  timeoutMs?: number;
  /** External cancellation signal (from the adapter context). */
  signal?: AbortSignal;
}

/**
 * Stable mapping from the expected failure to the ingress code placed on the
 * part. Mirrors core's `toIngressFailureCode`, but guards a `url` that is
 * not a genuine `http(s)` string — that is a platform-opaque locator that
 * the secure fetcher rejects as unavailable.
 */
function toFailureCode(url: string | undefined, error: unknown): BinaryIngressFailureCode {
  if (url !== undefined && !isHttpUrl(url)) {
    return 'resource-unavailable';
  }
  return toIngressFailureCode(error);
}

/**
 * Whether the secure fetcher may hydrate the part's real `url`.
 *
 * Hydration targets the binary parts whose raw bytes the host consumes
 * without any platform protocol: images (native harness `ImageBlock`) and
 * generic files (private asset store + extractor, plan §85). Audio/video are
 * left untouched in V1 — they have no DSH consumer yet (plan §79: no localData
 * forced for types without a consumer).
 */
function isHydratableBinaryType(type: string): boolean {
  return type === 'image' || type === 'file';
}

/**
 * Hydrate binary bytes on `parts` in place (the same array the mapper
 * produced). Returns the mutated array. Never throws — every download failure
 * is recorded as `ingressFailure` on the part and the event still carries
 * the part's `url` plus any text parts.
 */
export async function hydrateImageParts(
  parts: MessagePart[],
  fetcher: SecureRemoteMediaFetcher,
  options: ImageHydratorOptions = {},
): Promise<MessagePart[]> {
  const { maxBytes = 20 * 1024 * 1024, idleTimeoutMs = 15_000, timeoutMs = 15_000, signal } = options;

  await Promise.allSettled(
    parts.map(async (part) => {
      if (!isHydratableBinaryType(part.type)) return;
      const existing = part as BinaryPartBase & { type: string };
      const url = existing.url;

      if (url === undefined || url === '') {
        // resourceRef-only / dataUri-only / locator-free parts are left
        // untouched by hydration.
        return;
      }
      if (!isHttpUrl(url)) {
        // A `url` that is not a genuine http(s) URL cannot be ingested by the
        // secure fetcher → resource-unavailable.
        existing.ingressFailure = 'resource-unavailable';
        return;
      }
      // Trusted bytes already in hand take precedence — never re-download.
      if (existing.localData !== undefined || existing.dataUri !== undefined) {
        return;
      }

      const platformMime = existing.mimeType;
      const isFile = part.type === 'file';
      try {
        const result = await fetcher.fetchBounded(url, {
          maxBytes,
          idleTimeoutMs,
          timeoutMs,
          signal,
        });
        existing.localData = result.data;
        // Prefer the fetcher's Content-Type, else keep the platform hint.
        if (result.mimeType) {
          existing.mimeType = result.mimeType;
        } else if (platformMime === undefined) {
          existing.mimeType = mimeHintFromFilename(existing.name);
        }
        // Generic files also expose the hydrated byte length to the store.
        if (isFile) {
          existing.size = result.data.byteLength;
        }
        // A successful hydration clears any previous failure marker.
        delete existing.ingressFailure;
      } catch (error) {
        // Keep url, record the stable, de-identified failure code.
        existing.ingressFailure = toFailureCode(url, error);
      }
    }),
  );

  return parts;
}
