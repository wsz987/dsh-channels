/**
 * HTTP transport boundary.
 *
 * The transport is the single injection point for tests: the adapter is built
 * against `HttpTransport`, and a fake transport replaces the network without
 * touching driver logic. Timeouts abort the underlying fetch; an external
 * `signal` is combined with the request timeout.
 *
 * Credential hygiene (§23): bearer-style path segments — the Telegram Bot API
 * embeds the token in the request path (`/bot<token>/...`) — are redacted
 * from error messages so a token can never reach logs.
 */
import { ChannelError } from '@wsz987/channel-core';

export interface HttpRequestInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** Binary body plus safe response metadata needed by the media pipeline. */
export interface HttpBinaryResponse {
  data: Uint8Array;
  contentType?: string;
  contentDisposition?: string;
}

export interface HttpTransport {
  request(path: string, init?: HttpRequestInit, signal?: AbortSignal): Promise<unknown>;
  /**
   * Binary request used for Telegram file downloads (`/file/bot<token>/...`).
   * Optional so test fakes only implement it when they exercise file ingress.
   */
  requestBinary?(path: string, init?: HttpRequestInit, signal?: AbortSignal): Promise<HttpBinaryResponse>;
}

export interface FetchTransportOptions {
  /** Request timeout; overridden per-request by `init.timeoutMs`. */
  timeoutMs: number;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
}

/** Redact bearer-style path segments (e.g. `/bot<token>` / `/file/bot<token>`) from messages. */
function redactPath(path: string): string {
  return path.replace(/\/bot[^/?#]+/g, '/bot<redacted>');
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
    const response = await this.requestResponse(path, init, signal);
    const text = await response.text();
    if (!text) {
      if (!response.ok) {
        throw new ChannelError('CHANNEL_ERROR', `telegram http ${response.status} on ${redactPath(path)}`);
      }
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ChannelError(
        'CHANNEL_ERROR',
        `telegram http returned invalid JSON on ${redactPath(path)}`,
        { cause: error },
      );
    }
  }

  async requestBinary(path: string, init: HttpRequestInit = {}, signal?: AbortSignal): Promise<HttpBinaryResponse> {
    const response = await this.requestResponse(path, init, signal);
    if (!response.ok) {
      throw new ChannelError('CHANNEL_ERROR', `telegram http ${response.status} on ${redactPath(path)}`);
    }
    const buffer = await response.arrayBuffer();
    return {
      data: new Uint8Array(buffer),
      contentType: response.headers.get('content-type') ?? undefined,
      contentDisposition: response.headers.get('content-disposition') ?? undefined,
    };
  }

  /** Fetch one response under the request timeout + outer signal. */
  private async requestResponse(
    path: string,
    init: HttpRequestInit = {},
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = init.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
        body: init.body instanceof FormData
          ? init.body
          : init.body !== undefined
            ? JSON.stringify(init.body)
            : undefined,
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      if (error instanceof ChannelError) throw error;
      const aborted = (error as Error)?.name === 'AbortError' || controller.signal.aborted;
      throw new ChannelError(
        'CHANNEL_ERROR',
        aborted ? `telegram http aborted on ${redactPath(path)}` : `telegram http failed on ${redactPath(path)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}
