/**
 * HTTP transport boundary.
 *
 * The transport is the single injection point for tests: the adapter is built
 * against `HttpTransport`, and a fake transport replaces the network without
 * touching driver logic. Timeouts abort the underlying fetch; an external
 * `signal` is combined with the request timeout.
 */
import { ChannelError } from '@dsh/channel-core';

export interface HttpRequestInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
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
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: { 'content-type': 'application/json', ...init.headers },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ChannelError('CHANNEL_ERROR', `lark http ${response.status} on ${path}`);
      }
      const text = await response.text();
      return text ? JSON.parse(text) : undefined;
    } catch (error) {
      if (error instanceof ChannelError) throw error;
      const aborted = (error as Error)?.name === 'AbortError' || controller.signal.aborted;
      throw new ChannelError(
        'CHANNEL_ERROR',
        aborted ? `lark http aborted on ${path}` : `lark http failed on ${path}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}
