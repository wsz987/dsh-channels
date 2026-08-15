import { describe, expect, it, vi } from 'vitest';
import { FetchTransport } from '../src/transport.ts';

describe('FetchTransport', () => {
  it('does not add content-type to signed media GET requests', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      expect(new Headers(init?.headers).has('content-type')).toBe(false);
      return new Response(bytes, { status: 200 });
    });
    const transport = new FetchTransport('https://api.dingtalk.com', {
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await transport.request(
      'http://oss.example/image.jpg?x-oss-signature=signed',
      { method: 'GET', responseType: 'arraybuffer' },
    );

    expect(result).toEqual(bytes);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('still adds application/json when a JSON body is present', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
      return new Response('{}', { status: 200 });
    });
    const transport = new FetchTransport('https://api.dingtalk.com', {
      timeoutMs: 1_000,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await transport.request('/v1.0/example', { method: 'POST', body: { ok: true } });
  });
});
