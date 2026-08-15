import { describe, expect, it } from 'vitest';
import {
  BodyTooLargeError,
  RemoteMediaError,
  toIngressFailureCode,
} from '../src/media/bounded-response.js';
import type { FetchResponseLike } from '../src/media/secure-fetcher.js';
import { SecureRemoteMediaFetcher } from '../src/media/secure-fetcher.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

type Route = {
  url: string;
  status: number;
  headers?: Record<string, string>;
  body?: {
    chunks: Uint8Array[];
    /** Delay in ms between enqueues — used to exercise the read idle timeout. */
    delayMs?: number;
  } | null;
};

function makeBody(chunks: Uint8Array[], delayMs = 0): ReadableStream<Uint8Array> | null {
  return new ReadableStream<Uint8Array>({
    async start(c) {
      for (const chunk of chunks) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        c.enqueue(chunk);
      }
      c.close();
    },
  });
}

function makeFetch(routes: Route[], onRequest?: (url: string) => void): (input: string, init: unknown) => Promise<FetchResponseLike> {
  return async (input) => {
    onRequest?.(input);
    const url = new URL(input).href;
    const route = routes.find((r) => r.url === url);
    if (!route) {
      return { status: 404, ok: false, headers: new Headers(), body: null };
    }
    const headers = new Headers(route.headers ?? {});
    const body =
      route.body === undefined || route.body === null ? null : makeBody(route.body.chunks, route.body.delayMs);
    return { status: route.status, ok: route.status >= 200 && route.status < 300, headers, body };
  };
}

const resolverFor = (map: Record<string, string[]>) => async (host: string) => map[host] ?? [];

describe('SecureRemoteMediaFetcher.fetchBounded', () => {
  it('downloads bytes on a happy-path https URL', async () => {
    const fetchImpl = makeFetch([
      {
        url: 'https://cdn.example/a.png',
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '4' },
        body: { chunks: [enc('AB'), enc('CD')] },
      },
    ]);
    const fetcher = new SecureRemoteMediaFetcher({ fetch: fetchImpl, resolver: resolverFor({ 'cdn.example': ['93.184.216.34'] }) });
    const result = await fetcher.fetchBounded('https://cdn.example/a.png', { maxBytes: 1024 });
    expect(new TextDecoder().decode(result.data)).toBe('ABCD');
    expect(result.mimeType).toBe('image/png');
    expect(result.finalUrl).toBe('https://cdn.example/a.png');
  });

  it('rejects an oversized body with BodyTooLargeError and maps to too-large', async () => {
    const fetchImpl = makeFetch([
      {
        url: 'https://cdn.example/big.png',
        status: 200,
        body: { chunks: [enc('123456')] },
      },
    ]);
    const fetcher = new SecureRemoteMediaFetcher({ fetch: fetchImpl, resolver: resolverFor({ 'cdn.example': ['93.184.216.34'] }) });
    const err = await fetcher.fetchBounded('https://cdn.example/big.png', { maxBytes: 4 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BodyTooLargeError);
    expect(toIngressFailureCode(err)).toBe('too-large');
  });

  it('pre-checks Content-Length and rejects before reading when it exceeds the cap', async () => {
    const fetchImpl = makeFetch([
      {
        url: 'https://cdn.example/huge.png',
        status: 200,
        headers: { 'content-length': '999999' },
        body: { chunks: [] },
      },
    ]);
    const fetcher = new SecureRemoteMediaFetcher({ fetch: fetchImpl, resolver: resolverFor({ 'cdn.example': ['93.184.216.34'] }) });
    const err = await fetcher.fetchBounded('https://cdn.example/huge.png', { maxBytes: 100 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RemoteMediaError);
    expect((err as RemoteMediaError).code).toBe('CONTENT_LENGTH_EXCEEDED');
    expect(toIngressFailureCode(err)).toBe('too-large');
  });

  it('rejects an unsafe host before any fetch is attempted', async () => {
    let requested = 0;
    const fetchImpl = makeFetch([]);
    const fetcher = new SecureRemoteMediaFetcher({
      fetch: (input) => {
        requested++;
        return fetchImpl(input, {});
      },
      resolver: resolverFor({ 'evil.example': ['127.0.0.1'] }),
    });
    const err = await fetcher.fetchBounded('https://evil.example/x', { maxBytes: 1024 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(toIngressFailureCode(err)).toBe('resource-unavailable');
    expect(requested).toBe(0);
  });

  it('does not fetch for a non-http scheme', async () => {
    let requested = 0;
    const fetcher = new SecureRemoteMediaFetcher({
      fetch: async (input) => {
        requested++;
        return { status: 200, ok: true, headers: new Headers(), body: makeBody([enc('x')]) };
      },
      resolver: resolverFor({}),
    });
    const err = await fetcher.fetchBounded('data:text/plain,hi', { maxBytes: 1024 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(toIngressFailureCode(err)).toBe('resource-unavailable');
    expect(requested).toBe(0);
  });

  it('rejects a redirect hop that targets a private IP', async () => {
    let requested: string[] = [];
    const fetchImpl = makeFetch([
      {
        url: 'https://a.example/start',
        status: 302,
        headers: { location: 'https://private.example/x' },
      },
      {
        url: 'https://private.example/x',
        status: 200,
        body: { chunks: [enc('should-not')] },
      },
    ]);
    const fetcher = new SecureRemoteMediaFetcher({
      fetch: (input) => {
        requested.push(input);
        return fetchImpl(input, {});
      },
      resolver: resolverFor({ 'a.example': ['93.184.216.34'], 'private.example': ['10.0.0.9'] }),
    });
    const err = await fetcher.fetchBounded('https://a.example/start', { maxBytes: 1024 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(toIngressFailureCode(err)).toBe('resource-unavailable');
    // Only the first (public) hop reached the fetch layer; the unsafe second
    // hop was rejected by the SSRF re-check before its fetch was attempted.
    expect(requested).toEqual(['https://a.example/start']);
  });

  it('honors maxRedirects and rejects beyond the limit', async () => {
    const fetchImpl = makeFetch([
      {
        url: 'https://a.example/0',
        status: 302,
        headers: { location: 'https://a.example/1' },
      },
    ]);
    // Resolve a.example to a public IP so redirects are policy-legal.
    const resolver = resolverFor({ 'a.example': ['93.184.216.34'] });
    // A chain that always bounces off a.example: every hop finds a 302 with a
    // location pointing at itself — but our route map only knows /0, so the
    // first redirect lands on /1 with no route (404). Instead, simulate a
    // self-redirecting chain via a request-counting fake below.
    void fetchImpl;
    let hops = 0;
    const redirectingFetch = async (input: string) => {
      hops++;
      return {
        status: 302,
        ok: false,
        headers: (() => {
          const h = new Headers();
          h.set('location', 'https://a.example/loop');
          return h;
        })(),
        body: null,
      };
    };
    const fetcher = new SecureRemoteMediaFetcher({ fetch: redirectingFetch, resolver });
    const err = await fetcher
      .fetchBounded('https://a.example/0', { maxBytes: 1024, redirectPolicy: { maxRedirects: 2 } })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteMediaError);
    expect((err as RemoteMediaError).code).toBe('TOO_MANY_REDIRECTS');
    expect(toIngressFailureCode(err)).toBe('resource-unavailable');
    expect(hops).toBe(3);
  });

  it('strips auth headers on a cross-origin redirect and keeps them same-origin', async () => {
    const seenHeaders: (Headers | null)[] = [];
    let redirectToSameOrigin = true;

    const fetcher = new SecureRemoteMediaFetcher({
      resolver: resolverFor({ 'a.example': ['93.184.216.34'], 'cdn.example': ['93.184.216.33'] }),
      fetch: async (input, init) => {
        seenHeaders.push(init.headers);
        if (redirectToSameOrigin) {
          redirectToSameOrigin = false;
          const h = new Headers();
          h.set('location', 'https://cdn.example/final'); // cross-origin hop
          return { status: 302, ok: false, headers: h, body: null };
        }
        return { status: 200, ok: true, headers: new Headers(), body: makeBody([enc('ok')]) };
      },
    });

    const initial = new Headers();
    initial.set('authorization', 'Bearer secret');
    initial.set('x-trace', 't');
    const result = await fetcher.fetchBounded('https://a.example/start', {
      maxBytes: 1024,
      headers: initial,
    });

    expect(seenHeaders).toHaveLength(2);
    // Hops:
    //  hop1 → https://a.example/start   (authorization kept, same as initial origin)
    //  hop2 → https://cdn.example/final (cross-origin → authorization stripped)
    expect(seenHeaders[0]?.get('authorization')).toBe('Bearer secret');
    expect(seenHeaders[1]?.get('authorization')).toBeNull();
    expect(seenHeaders[1]?.get('x-trace')).toBe('t');
    expect(new TextDecoder().decode(result.data)).toBe('ok');
  });

  it('enforces the read idle timeout on a slow body', async () => {
    const fetchImpl = makeFetch([
      {
        url: 'https://cdn.example/slow.png',
        status: 200,
        body: { chunks: [enc('1')], delayMs: 40 },
      },
    ]);
    const fetcher = new SecureRemoteMediaFetcher({ fetch: fetchImpl, resolver: resolverFor({ 'cdn.example': ['93.184.216.34'] }) });
    const err = await fetcher
      .fetchBounded('https://cdn.example/slow.png', { maxBytes: 1024, idleTimeoutMs: 10 })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteMediaError);
    expect(toIngressFailureCode(err)).toBe('download-failed');
  }, 3000);

  it('rejects a non-2xx response as DOWNLOAD_FAILED', async () => {
    const fetchImpl = makeFetch([{ url: 'https://cdn.example/404', status: 404 }]);
    const fetcher = new SecureRemoteMediaFetcher({ fetch: fetchImpl, resolver: resolverFor({ 'cdn.example': ['93.184.216.34'] }) });
    const err = await fetcher.fetchBounded('https://cdn.example/404', { maxBytes: 1024 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RemoteMediaError);
    expect((err as RemoteMediaError).code).toBe('DOWNLOAD_FAILED');
  });
});
