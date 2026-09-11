/**
 * Binary hydration for the QQ inbound path.
 *
 * The mapper stays pure: it preserves the real `attachment.url` on image,
 * generic-file, audio (`voice_wav_url` ?? `url`) and video parts.
 * This module is the single place that turns a genuine `http(s)` URL into
 * trusted bytes, using the shared `SecureRemoteMediaFetcher` from
 * `@wsz987/channel-core` as the DSH host's generic security boundary. It
 * never implements QQ upload / token / gateway protocol —
 * those belong to `qqbot-nodejs`.
 *
 * Native image ingress (M2A) hydrates `image` parts so the harness
 * `saveImage()` / `ImageBlock` path receives real bytes. Generic file
 * ingress hydrates `file` parts the same way: the produced
 * `localData` is picked up automatically by the harness private asset store
 * + extractor, so the adapter never implements QQ file upload. Since
 * `audio` and `video` parts are hydrated through the same secure
 * fetcher — the adapter is the transport layer and must deliver bytes for
 * every binary kind it maps, regardless of whether a model consumer exists
 * yet.
 *
 * The apply step reuses core's protocol-agnostic `applyHydrationResult`
 * for all four binary kinds: it owns the byte cap, the
 * AbortSignal handling, the localData/size/mime merge and the stable
 * `ingressFailure` mapping. This module only owns the QQ-specific gate
 * (which parts, which URLs) and the URL-level failure mapping.
 *
 * Key guarantees:
 * - Only the four binary kinds (`image` / `file` / `audio` / `video`) with a
 *   genuine `http(s)` `url` are hydrated. A part already carrying `localData`
 *   / `dataUri`, or carrying an opaque `resourceRef` / no locator, is left
 *   untouched.
 * - On success the part gets `localData` (the downloaded bytes), `size` (the
 *   hydrated byte length) and `mimeType` (prefer the fetcher's Content-Type,
 *   else keep the platform hint, else sniff the filename). Image parts keep
 *   their intrinsic shape: the `size` field is intentionally NOT set there.
 * - On ANY failure the part is NOT dropped: its `url` is kept, a stable
 *   `ingressFailure` code is set, and hydration of other parts continues.
 *   A download failure must never block text delivery, and this
 *   function never throws.
 */
import {
  SecureRemoteMediaFetcher,
  applyHydrationResult,
  isHydratableBinaryPart,
  mimeHintFromFilename,
} from '@wsz987/channel-core';
import type { MessagePart } from '@wsz987/channel-core';

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

export interface MediaHydratorOptions {
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
 * Hydrate binary bytes on `parts` in place (the same array the mapper
 * produced). Returns the mutated array. Never throws — every download failure
 * is recorded as `ingressFailure` on the part and the event still carries
 * the part's `url` plus any text parts.
 */
export async function hydrateMediaParts(
  parts: MessagePart[],
  fetcher: SecureRemoteMediaFetcher,
  options: MediaHydratorOptions = {},
): Promise<MessagePart[]> {
  const { maxBytes = 20 * 1024 * 1024, idleTimeoutMs = 15_000, timeoutMs = 15_000, signal } = options;

  await Promise.allSettled(
    parts.map(async (part) => {
      // Only the four binary kinds participate in hydration.
      if (!isHydratableBinaryPart(part)) return;
      const url = part.url;

      if (url === undefined || url === '') {
        // resourceRef-only / dataUri-only / locator-free parts are left
        // untouched by hydration.
        return;
      }
      if (!isHttpUrl(url)) {
        // A `url` that is not a genuine http(s) URL cannot be ingested by the
        // secure fetcher → resource-unavailable.
        part.ingressFailure = 'resource-unavailable';
        return;
      }
      // Trusted bytes already in hand take precedence — never re-download.
      // (`applyHydrationResult` also skips parts with `localData`; the
      // `dataUri` skip is QQ's own gate to keep the legacy behavior.)
      if (part.localData !== undefined || part.dataUri !== undefined) {
        return;
      }

      const platformMime = part.mimeType;
      const isImage = part.type === 'image';
      await applyHydrationResult(
        part,
        async () => {
          const result = await fetcher.fetchBounded(url, {
            maxBytes,
            idleTimeoutMs,
            timeoutMs,
            signal,
          });
          return {
            data: result.data,
            // Prefer the fetcher's Content-Type, else keep the platform hint,
            // else fall back to a filename sniff.
            mimeType: result.mimeType ?? platformMime ?? mimeHintFromFilename(part.name),
          };
        },
        { maxBytes, signal },
      );
      // Image parts never carry `size` (keep that shape stable), while
      // audio/video/file take the authoritative `size` from the real bytes.
      if (isImage) delete part.size;
    }),
  );

  return parts;
}