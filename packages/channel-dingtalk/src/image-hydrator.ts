/**
 * DingTalk inbound image hydration (plan §32A / §79A).
 *
 * After the pure mapper (`mapInbound`) produces the stable `MessageReceived`
 * shape, this module walks the image parts and turns a genuine `http(s)`
 * locator into trusted bytes on the part itself:
 *
 * ```text
 * ImagePart.url (real http(s) URL)
 *   -> SecureRemoteMediaFetcher.fetchBounded()
 *   -> ImagePart.localData + mimeType
 *   -> existing Harness saveImage()/ImageBlock path (host owns that)
 * ```
 *
 * This module performs NO platform-protocol implementation. It only calls the
 * shared secure host boundary (`@wsz987/channel-core` `SecureRemoteMediaFetcher`)
 * — it never re-implements DingTalk download logic (plan §12 / §13 / §93).
 *
 * Failure handling (plan §79A DoD): a download failure never blocks text
 * delivery. On failure we KEEP the original locator, stamp a stable
 * de-identified `ingressFailure` code on the part (mapped through the core
 * `toIngressFailureCode` seam) and let the message continue to emit unaltered.
 *
 * mediaId/opaque handle handling (plan §32A): DingTalk modern robot picture
 * messages deliver a real `picture.url` (see `stream-upstream.ts` →
 * `picUrl`), so the common ingress is the URL path above. If a part carries
 * an opaque locator instead (a `mediaId` that is not a genuine http(s) URL),
 * we move it to `resourceRef` and do NOT attempt a generic fetch — resolving
 * an opaque handle is exclusively the platform upstream job and is left to
 * the `DingTalkOpenApiPort.resolveMedia(...)` milestone (§32A). We never
 * invent an HTTP downloader for a mediaId.
 */
import type { FilePart, MessagePart } from '@wsz987/channel-core';
import {
  SecureRemoteMediaFetcher,
  toIngressFailureCode,
  type BinaryIngressFailureCode,
  type FetchBoundedResult,
} from '@wsz987/channel-core';
import type { MediaResolverLike, ResolvedMedia } from './openapi-port.js';

/** Default hard byte cap for a downloaded image (20 MiB). */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** Default read-idle timeout (no body chunk for N ms -> fail). */
export const IMAGE_IDLE_TIMEOUT_MS = 15_000;


function classifyLocator(url: string | undefined): 'http-url' | 'opaque' | 'none' {
  if (url === undefined || url === '') return 'none';
  return /^https?:\/\//i.test(url) ? 'http-url' : 'opaque';
}

/**
 * One image part locator classified by the hydrator. A genuine http(s) URL is
 * fetched; an opaque locator (e.g. a bare mediaId) is deferred to the OpenAPI
 * resolution path and never fetched.
 */
export interface ResolvedImageLocator {
  kind: 'http-url' | 'opaque';
  /** Part array index (for diagnostics). */
  index: number;
  /** The locator string that will be fetched / deferred. */
  locator: string;
}

/**
 * Identify the http(s)-fetchable image parts in a message content. Opaque
 * (non-http) locators are surfaced separately so the ingestion policy can
 * route them to `resourceRef`.
 */
export function findFetchableImages(parts: readonly MessagePart[]): ResolvedImageLocator[] {
  const out: ResolvedImageLocator[] = [];
  parts.forEach((part, index) => {
    if (part.type !== 'image') return;
    const kind = classifyLocator(part.url);
    if (kind === 'none') return;
    out.push({ kind, index, locator: part.url! });
  });
  return out;
}

/**
 * Structural sub-surface of `SecureRemoteMediaFetcher` the hydrator depends
 * on — lets tests inject a plain fake fetcher without a real global `fetch`.
 */
export interface RemoteMediaFetchLike {
  fetchBounded(url: string, options: {
    maxBytes: number;
    idleTimeoutMs?: number;
    timeoutMs?: number;
    allowHttp?: boolean;
    signal?: AbortSignal;
  }): Promise<FetchBoundedResult>;
}

/** Options for one hydration pass over a message content parts. */
export interface HydrateImagesOptions {
  /**
   * The secure remote media fetcher. Injectable for offline tests; defaults to
   * a real `SecureRemoteMediaFetcher` bound to the global `fetch`.
   */
  secureFetch?: SecureRemoteMediaFetcher | RemoteMediaFetchLike;
  /** Abort signal threaded from the adapter context for prompt teardown. */
  signal?: AbortSignal;
  /** Hard byte cap per image (default 20 MiB). */
  maxBytes?: number;
  /** Read-idle timeout ms (default 15s). */
  idleTimeoutMs?: number;
  /**
   * DingTalk OpenAPI media resolver used to turn an opaque image handle
   * (picMediaId / downloadCode) into trusted bytes (plan §32A). Injectable for
   * offline tests; when absent, opaque handles stay on `resourceRef` and are
   * left unresolved (the message still delivers, as a text placeholder).
   */
  resolveMedia?: MediaResolverLike;
  /**
   * Per-message download context from the inbound callback (official schema):
   * the `downloadCode` (and `robotCode`) the official
   * `/v1.0/robot/messageFiles/download` API needs. Transient upstream state —
   * never persisted into core parts.
   */
  downloadContext?: { downloadCode?: string; robotCode?: string };
  /** Diagnostic callback; receives the original error without changing delivery. */
  onFailure?: (error: unknown, part: MessagePart) => void;
}

/**
 * Hydrate image parts in place: mutate `parts` so every image with a genuine
 * http(s) URL carries `localData` + `mimeType` (preferring the fetcher MIME
 * type) on success, and `ingressFailure` on failure. Opaque locators are
 * moved to `resourceRef` and left unresolved (OpenAPI milestone).
 *
 * This never throws and never blocks text delivery — any image failure only
 * annotates the part.
 */
export async function hydrateImages(parts: MessagePart[], options: HydrateImagesOptions = {}): Promise<void> {
  const fetcher: RemoteMediaFetchLike = options.secureFetch ?? new SecureRemoteMediaFetcher();
  const resolver = options.resolveMedia;
  const maxBytes = options.maxBytes ?? IMAGE_MAX_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs ?? IMAGE_IDLE_TIMEOUT_MS;

  for (const part of parts) {
    if (part.type !== 'image') continue;

    // Opaque handle: either the mapper already placed it in resourceRef, or a
    // non-http url needs moving there first. Resolve via the DingTalk OpenAPI
    // port (official downloadCode flow) when a resolver is wired — never via a
    // generic fetch (plan §9/§13).
    let opaque: string | undefined = part.resourceRef;
    if (!opaque) {
      const kind = classifyLocator(part.url);
      if (kind === 'none') continue;
      if (kind === 'opaque') {
        opaque = part.url;
        part.resourceRef = opaque;
        delete part.url;
      }
    }
    if (opaque) {
      if (!resolver) continue;
      try {
        const resolved = await resolver.resolveMedia(opaque, {
          signal: options.signal,
          name: part.alt,
          downloadCode: options.downloadContext?.downloadCode,
          robotCode: options.downloadContext?.robotCode,
        });
        applyResolvedImage(part, resolved);
      } catch (error) {
        part.ingressFailure = toIngressFailureCode(error);
        options.onFailure?.(error, part);
      }
      continue;
    }

    const url = part.url!;
    try {
      const result = await fetcher.fetchBounded(url, {
        maxBytes,
        idleTimeoutMs,
        signal: options.signal,
      });
      // Prefer the fetcher declared MIME type; fall back to any existing hint.
      part.localData = result.data;
      if (result.mimeType) part.mimeType = result.mimeType;
      if (part.size === undefined) part.size = result.data.byteLength;
    } catch (error) {
      // Keep the locator and annotate the failure; never throw into the caller.
      part.ingressFailure = toIngressFailureCode(error);
      options.onFailure?.(error, part);
    }
  }
}

/** Default hard byte cap for a downloaded generic file (50 MiB). */
export const FILE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Options for one generic-file hydration pass (plan §86 generic file inbound).
 * @extends HydrateImagesOptions
 */
export interface HydrateFilesOptions {
  /**
   * The secure remote media fetcher used for genuine http(s) file URLs.
   * Injectable for offline tests; defaults to a real `SecureRemoteMediaFetcher`.
   */
  secureFetch?: SecureRemoteMediaFetcher | RemoteMediaFetchLike;
  /**
   * The OpenAPI media resolver used to turn an opaque file mediaId into trusted
   * bytes (plan §32A). Injectable for offline tests. When absent, opaque file
   * handles are deferred to `resourceRef` and left unresolved.
   */
  resolveMedia?: MediaResolverLike;
  /** Abort signal threaded from the adapter context for prompt teardown. */
  signal?: AbortSignal;
  /** Hard byte cap per file (default 50 MiB). */
  maxBytes?: number;
  /** Read-idle timeout ms (default 15s). */
  idleTimeoutMs?: number;
  /**
   * Per-message download context (official schema): `downloadCode` +
   * `robotCode` for the official /v1.0/robot/messageFiles/download API.
   * Transient upstream state — never persisted onto core parts.
   */
  downloadContext?: { downloadCode?: string; robotCode?: string };
}

/**
 * Hydrate generic file parts in place (plan §86):
 *   - http(s) url  -> SecureRemoteMediaFetcher -> `localData` + `mimeType` + `size`
 *   - opaque mediaId -> move to `resourceRef` -> `resolveMedia` -> `localData`
 * On failure the original locator is kept and a stable `ingressFailure` is
 * stamped — this never throws and never blocks text delivery.
 */
export async function hydrateFiles(parts: MessagePart[], options: HydrateFilesOptions = {}): Promise<void> {
  const fetcher: RemoteMediaFetchLike = options.secureFetch ?? new SecureRemoteMediaFetcher();
  const resolver = options.resolveMedia;
  const maxBytes = options.maxBytes ?? FILE_MAX_BYTES;
  const idleTimeoutMs = options.idleTimeoutMs ?? IMAGE_IDLE_TIMEOUT_MS;

  for (const part of parts) {
    if (part.type !== 'file') continue;
    const file = part as FilePart;

    // Opaque handle: either the mapper already placed it in resourceRef, or a
    // non-http url needs moving there first. Resolve via the port (official
    // downloadCode flow) when a resolver is wired — never via a generic fetch.
    let opaque: string | undefined = file.resourceRef;
    if (!opaque) {
      const kind = classifyPartLocator(file.url);
      if (kind === 'none') continue;
      if (kind === 'opaque') {
        opaque = file.url;
        file.resourceRef = opaque;
        delete file.url;
      }
    }
    if (opaque) {
      if (resolver) {
        try {
          const resolved = await resolver.resolveMedia(opaque, {
            signal: options.signal,
            name: file.name,
            downloadCode: options.downloadContext?.downloadCode,
            robotCode: options.downloadContext?.robotCode,
          });
          applyResolved(file, resolved);
        } catch (error) {
          file.ingressFailure = toIngressFailureCode(error);
        }
      }
      continue;
    }

    const url = file.url!;
    try {
      const result = await fetcher.fetchBounded(url, { maxBytes, idleTimeoutMs, signal: options.signal });
      file.localData = result.data;
      if (result.mimeType) file.mimeType = result.mimeType;
      if (file.size === undefined) file.size = result.data.byteLength;
    } catch (error) {
      file.ingressFailure = toIngressFailureCode(error);
    }
  }
}

function classifyPartLocator(url: string | undefined): 'http-url' | 'opaque' | 'none' {
  if (url === undefined || url === '') return 'none';
  return /^https?:\/\//i.test(url) ? 'http-url' : 'opaque';
}

/** Apply a successful resolution to a file part. */
function applyResolved(part: FilePart, resolved: ResolvedMedia): void {
  part.localData = resolved.data;
  if (resolved.mimeType) part.mimeType = resolved.mimeType;
  if (resolved.size !== undefined) part.size = resolved.size;
  if (part.size === undefined) part.size = resolved.data.byteLength;
}

/** Apply a successful resolution to an image part. */
function applyResolvedImage(part: Extract<MessagePart, { type: 'image' }>, resolved: ResolvedMedia): void {
  part.localData = resolved.data;
  if (resolved.mimeType) part.mimeType = resolved.mimeType;
  if (resolved.size !== undefined) part.size = resolved.size;
  if (part.size === undefined) part.size = resolved.data.byteLength;
}

/** Convenience factory returning a real secure fetcher bound to global fetch. */
export function defaultSecureFetcher(): SecureRemoteMediaFetcher {
  return new SecureRemoteMediaFetcher();
}

// Re-export the failure-code type so consumers/tests share the same vocabulary.
export type { BinaryIngressFailureCode };
