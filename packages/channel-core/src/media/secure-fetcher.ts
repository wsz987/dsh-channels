/**
 * `SecureRemoteMediaFetcher` — the DSH host's generic, untrusted remote
 * binary security boundary (plan §12 / §13).
 *
 * Combines the pure SSRF policy (`remote-policy.ts`) with the bounded stream
 * reader (`bounded-response.ts`) over an injectable `fetch`. It is the ONLY
 * code path that turns a real `http(s)` `url` on a binary part into bytes.
 *
 * It NEVER fetches a `resourceRef`. The fetcher accepts only genuine
 * `http(s)` URLs; resolving a platform opaque handle (image_key / file_key /
 * file_id / mediaId) is exclusively the platform upstream's job (plan §9).
 */

import {
  readBoundedBody,
  RemoteMediaError,
  type ReadBoundedBodyOptions,
} from './bounded-response.js';
import {
  assertSafeMediaUrl,
  DEFAULT_MAX_REDIRECTS,
  stripCrossOriginAuthHeader,
  type Resolver,
} from './remote-policy.js';

/** Minimal shape of a fetch response the fetcher requires from its `fetch`. */
export interface FetchResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: {
    get(name: string): string | null;
    has?(name: string): boolean;
  };
  /** Null means an explicit empty body. */
  readonly body: ReadableStream<Uint8Array> | null;
}

/** Minimal `fetch`-shaped function the fetcher drives. Defaults to the global `fetch`. */
export type FetchLike = (
  input: string,
  init: { signal: AbortSignal; headers: Headers; redirect: 'manual' },
) => Promise<FetchResponseLike>;

/** Result of a successful bounded download. */
export interface FetchBoundedResult {
  /** The fully-read remote body bytes. */
  data: Uint8Array;
  /** The response `Content-Type`, when present. */
  mimeType?: string;
  /** The URL actually fetched, after redirects (final hop). */
  finalUrl: string;
}

/** Options for `SecureRemoteMediaFetcher.fetchBounded`. */
export interface FetchBoundedOptions {
  /** Hard cumulative byte cap. */
  maxBytes: number;
  /** Read-idle timeout in ms (no data for N ms → reject). */
  idleTimeoutMs?: number;
  /** Header-probe timeout in ms (initial response not received in N ms → reject). */
  timeoutMs?: number;
  /** Redirect depth limit. */
  redirectPolicy?: { maxRedirects?: number };
  /** Expected total byte length (short read → reject). */
  expectedLength?: number;
  /** Explicitly allow the insecure `http` scheme. Defaults to false. */
  allowHttp?: boolean;
  /** Request headers to send on the first hop. */
  headers?: Headers | Record<string, string>;
  /** External cancellation signal. */
  signal?: AbortSignal;
  /** Optional per-fetch resolver override (falls back to the fetcher's own). */
  resolver?: Resolver;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function toHeaders(headers?: Headers | Record<string, string>): Headers {
  if (headers === undefined) return new Headers();
  if (typeof (headers as Headers).forEach === 'function') return new Headers(headers);
  return new Headers(headers as Record<string, string>);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Drive `fetch` once under a header timeout, combining the caller's abort
 * signal with a timeout-fired abort. Resolves the raw response (unread).
 */
async function fetchHeaders(
  fetchImpl: FetchLike,
  input: string,
  headers: Headers,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<FetchResponseLike> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onUserAbort = () => ctrl.abort();
  if (signal?.aborted) ctrl.abort();
  if (signal && !signal.aborted) signal.addEventListener('abort', onUserAbort, { once: true });
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
  }
  try {
    return await fetchImpl(input, {
      signal: ctrl.signal,
      headers,
      redirect: 'manual',
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onUserAbort);
  }
}

export class SecureRemoteMediaFetcher {
  readonly fetchImpl: FetchLike;
  readonly resolver?: Resolver;

  constructor(options: { fetch?: FetchLike; resolver?: Resolver } = {}) {
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.resolver = options.resolver;
  }

  /**
   * Download a real `http(s)` URL under the secure boundary.
   *
   * Validation order (plan §12):
   * 1. scheme + SSRF policy checked before any fetch (via `assertSafeMediaUrl`)
   * 2. every redirect hop re-checked against the policy
   * 3. redirect depth bounded by `redirectPolicy.maxRedirects`
   * 4. Content-Length pre-checked against `maxBytes`
   * 5. body streamed under the hard byte cap + idle timeout
   * 6. auth headers stripped on cross-origin redirect hops
   *
   * Rejects a non-http(s) URL or an unsafe host before touching the network.
   */
  async fetchBounded(url: string, options: FetchBoundedOptions): Promise<FetchBoundedResult> {
    const {
      maxBytes,
      idleTimeoutMs,
      timeoutMs,
      expectedLength,
      allowHttp = false,
      headers,
      signal,
    } = options;
    const maxRedirects = options.redirectPolicy?.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

    let currentUrl = url;
    let currentOrigin = originOf(url);
    let currentHeaders = toHeaders(headers);
    let hops = 0;

    for (;;) {
      // SSRF check (scheme + DNS) before this hop's fetch.
      const validated = await assertSafeMediaUrl(currentUrl, {
        allowHttp,
        resolver: options.resolver ?? this.resolver,
      });

      const response = await fetchHeaders(this.fetchImpl, validated.toString(), currentHeaders, signal, timeoutMs);

      if (REDIRECT_STATUSES.has(response.status)) {
        if (hops >= maxRedirects) {
          throw new RemoteMediaError(
            'TOO_MANY_REDIRECTS',
            `too many redirects (${hops + 1}) while fetching ${url}`,
          );
        }
        const location = response.headers.get('location');
        if (location === null) {
          throw new RemoteMediaError('DOWNLOAD_FAILED', `redirect (${response.status}) with no Location for ${url}`);
        }
        let nextUrl: string;
        try {
          nextUrl = new URL(location, validated).toString();
        } catch {
          throw new RemoteMediaError('DOWNLOAD_FAILED', `invalid redirect Location "${location}"`);
        }
        const nextOrigin = originOf(nextUrl);
        currentHeaders = stripCrossOriginAuthHeader(currentHeaders, currentOrigin, nextOrigin);
        currentUrl = nextUrl;
        currentOrigin = nextOrigin;
        hops++;
        continue;
      }

      if (!response.ok) {
        throw new RemoteMediaError('DOWNLOAD_FAILED', `fetch ${currentUrl} returned HTTP ${response.status}`);
      }

      // Content-Length pre-check.
      const contentLength = response.headers.get('content-length');
      if (contentLength !== null) {
        const n = Number(contentLength);
        if (Number.isFinite(n) && n > maxBytes) {
          throw new RemoteMediaError(
            'CONTENT_LENGTH_EXCEEDED',
            `Content-Length ${n} exceeds the ${maxBytes} byte cap for ${currentUrl}`,
          );
        }
      }

      let data: Uint8Array;
      if (response.body === null) {
        if (expectedLength !== undefined && expectedLength > 0) {
          throw new RemoteMediaError(
            'BODY_INCOMPLETE',
            `expected ${expectedLength} bytes but response has no body for ${currentUrl}`,
          );
        }
        data = new Uint8Array(0);
      } else {
        const readOptions: ReadBoundedBodyOptions = { maxBytes, idleTimeoutMs, expectedLength, signal };
        data = await readBoundedBody(response.body, readOptions);
      }

      const mimeType = response.headers.get('content-type') ?? undefined;
      return { data, mimeType, finalUrl: validated.toString() };
    }
  }
}
