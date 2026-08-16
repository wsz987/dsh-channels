/**
 * HTTP transport boundary.
 *
 * The transport is the single injection point for tests: the adapter is built
 * against `HttpTransport`, and a fake transport replaces the network without
 * touching driver logic. Timeouts abort the underlying fetch; an external
 * `signal` is combined with the request timeout.
 */
import { ChannelError } from '@wsz987/channel-core';

export interface HttpRequestInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Raw binary body (media upload). When set, `body` is ignored and `raw` is
   * sent verbatim with `contentType` (default `application/octet-stream`).
   */
  raw?: Uint8Array | string;
  /** Content-Type to send alongside a `raw` binary body. */
  contentType?: string;
  /**
   * Response decoding. `'json'` (default) parses the response body as JSON;
   * `'arraybuffer'` returns the raw bytes as a `Uint8Array` (media download,
   * where the body is binary and not JSON).
   */
  responseType?: 'json' | 'arraybuffer';
}

export interface HttpTransport {
  request(path: string, init?: HttpRequestInit, signal?: AbortSignal): Promise<unknown>;
}

export interface FetchTransportOptions {
  /** Request timeout; overridden per-request by `init.timeoutMs`. */
  timeoutMs: number;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
}

/** Default transport backed by the standard `fetch`. */
export class FetchTransport implements HttpTransport {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string, options: FetchTransportOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  private readonly baseUrl: string;

  async request(path: string, init: HttpRequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const timeoutMs = init.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const url = /^https?:\/\//i.test(path) ? path : `${this.baseUrl}${path}`;
      const headers: Record<string, string> = { ...init.headers };
      // `FormData` is passed through untouched so fetch creates the multipart
      // boundary. JSON and legacy raw bytes retain their existing paths.
      const body: string | Uint8Array | FormData | undefined =
        init.raw !== undefined
          ? (typeof init.raw === 'string' ? init.raw : new Uint8Array(init.raw.buffer, init.raw.byteOffset, init.raw.byteLength))
          : init.body instanceof FormData
            ? init.body
          : init.body !== undefined
            ? JSON.stringify(init.body)
            : undefined;
      if (init.raw !== undefined) {
        headers['content-type'] = init.contentType ?? 'application/octet-stream';
      } else if (init.body !== undefined && !(init.body instanceof FormData)) {
        headers['content-type'] = headers['content-type'] ?? 'application/json';
      }
      const response = await this.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers,
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 500);
        throw new ChannelError(
          'CHANNEL_ERROR',
          `dingtalk http ${response.status} on ${path}${detail ? `: ${detail}` : ''}`,
        );
      }
      if (init.responseType === 'arraybuffer') {
        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
      }
      const text = await response.text();
      return text ? JSON.parse(text) : undefined;
    } catch (error) {
      if (error instanceof ChannelError) throw error;
      const aborted = (error as Error)?.name === 'AbortError' || controller.signal.aborted;
      throw new ChannelError(
        'CHANNEL_ERROR',
        aborted ? `dingtalk http aborted on ${path}` : `dingtalk http failed on ${path}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}
