/**
 * Base HTTP transport boundary — a clean `fetch` wrapper.
 *
 * This module knows NOTHING about Weixin endpoints or the iLink protocol. It
 * only turns a URL + method + body into a `fetch` call with a timeout and an
 * optional external abort signal, normalizing failures into `ChannelError`.
 * The iLink client (`src/ilink/client.ts`) owns endpoint knowledge and builds
 * the protocol headers on top of this transport.
 */
import { ChannelError } from '@dsh/channel-core';

export interface HttpRequestInit {
  method?: string;
  /** Optional custom headers; merged over the transport default. */
  headers?: Record<string, string>;
  /** JSON body (serialized by the transport). */
  body?: unknown;
  /** Per-request timeout override. */
  timeoutMs?: number;
}

export interface HttpTransport {
  /**
   * Perform one HTTP request against a full URL.
   *
   * @param url  Absolute URL (origin + path + query) to request.
   * @param init Request options.
   * @param signal Optional external abort signal (combined with the timeout).
   * @returns The parsed JSON response body.
   */
  request(url: string, init?: HttpRequestInit, signal?: AbortSignal): Promise<unknown>;
}

/** Default headers attached to every request unless overridden. */
const DEFAULT_HEADERS: Record<string, string> = {
  'content-type': 'application/json',
};

export interface FetchTransportOptions {
  /** Default request timeout in ms; overridden by `init.timeoutMs`. */
  timeoutMs: number;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
}

/**
 * Default transport backed by the standard `fetch`. Timeout and external
 * aborts are combined onto a single `AbortSignal`; HTTP non-2xx responses and
 * network/timeout/abort failures are normalized to `ChannelError`.
 */
export class FetchTransport implements HttpTransport {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FetchTransportOptions) {
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async request(url: string, init: HttpRequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const timeoutMs = init.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const response = await this.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers: { ...DEFAULT_HEADERS, ...init.headers },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ChannelError('CHANNEL_ERROR', `http ${response.status} on ${safeUrl(url)}`);
      }
      const text = await response.text();
      return text ? JSON.parse(text) : undefined;
    } catch (error) {
      if (error instanceof ChannelError) throw error;
      const aborted = controller.signal.aborted || (error as Error)?.name === 'AbortError';
      throw new ChannelError(
        'CHANNEL_ERROR',
        aborted ? `http request aborted on ${safeUrl(url)}` : `http request failed on ${safeUrl(url)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

/** Strip query strings (which may carry signatures) from log output. */
function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.search ? `${parsed.origin}${parsed.pathname}?<redacted>` : url;
  } catch {
    return url.length > 80 ? `${url.slice(0, 80)}…` : url;
  }
}
