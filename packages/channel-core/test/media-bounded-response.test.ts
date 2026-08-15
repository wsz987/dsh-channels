import { describe, expect, it } from 'vitest';
import {
  BodyTooLargeError,
  concatenate,
  readBoundedBody,
  RemoteBodyIncompleteError,
  RemoteMediaAbortedError,
  RemoteMediaError,
  RemoteReadTimeoutError,
  toIngressFailureCode,
} from '../src/media/bounded-response.js';

function streamFrom(chunks: Uint8Array[], delayMs = 0): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(c);
      }
      controller.close();
    },
  });
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('readBoundedBody', () => {
  it('concatenates a happy-path stream within the cap', async () => {
    const data = await readBoundedBody(streamFrom([enc('hello '), enc('world')]), {
      maxBytes: 1024,
    });
    expect(new TextDecoder().decode(data)).toBe('hello world');
    expect(data.byteLength).toBe(11);
  });

  it('rejects when the cumulative byte cap is exceeded mid-stream', async () => {
    await expect(
      readBoundedBody(streamFrom([enc('abc'), enc('def')]), { maxBytes: 4 }),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('rejects with BodyTooLargeError even on an exact-bound overflow read', async () => {
    // received stays <= cap until a single chunk pushes it strictly above.
    await expect(
      readBoundedBody(streamFrom([enc('aaaa'), enc('aaaa')]), { maxBytes: 8 }),
    ).resolves.toHaveLength(8);
    await expect(
      readBoundedBody(streamFrom([enc('aaaa'), enc('aaaaa')]), { maxBytes: 8 }),
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it('rejects on a read-idle timeout when no chunk arrives', async () => {
    await expect(
      readBoundedBody(streamFrom([enc('x')], 50), { maxBytes: 1024, idleTimeoutMs: 10 }),
    ).rejects.toBeInstanceOf(RemoteReadTimeoutError);
  }, 2000);

  it('rejects as incomplete when the body ends short of the expected length', async () => {
    await expect(
      readBoundedBody(streamFrom([enc('abc')]), { maxBytes: 1024, expectedLength: 5 }),
    ).rejects.toBeInstanceOf(RemoteBodyIncompleteError);
  });

  it('succeeds when the expected length matches', async () => {
    const data = await readBoundedBody(streamFrom([enc('hello')]), {
      maxBytes: 1024,
      expectedLength: 5,
    });
    expect(new TextDecoder().decode(data)).toBe('hello');
  });

  it('rejects when an external AbortSignal fires', async () => {
    const ctrl = new AbortController();
    const wait = readBoundedBody(
      new ReadableStream<Uint8Array>({
        async pull() {
          await new Promise((r) => setTimeout(r, 100));
        },
      }),
      { maxBytes: 1024, signal: ctrl.signal },
    );
    // Let the reader arm its listeners, then abort.
    await new Promise((r) => setTimeout(r, 5));
    ctrl.abort();
    await expect(wait).rejects.toBeInstanceOf(RemoteMediaAbortedError);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      readBoundedBody(streamFrom([enc('x')]), { maxBytes: 1024, signal: ctrl.signal }),
    ).rejects.toBeInstanceOf(RemoteMediaAbortedError);
  });

  it('rejects a non-positive cap before reading', async () => {
    await expect(readBoundedBody(streamFrom([]), { maxBytes: 0 })).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
  });
});

describe('concatenate', () => {
  it('merges chunk buffers in order', () => {
    const out = concatenate([enc('a'), enc('bc'), enc('')], 3);
    expect(new TextDecoder().decode(out)).toBe('abc');
  });
});

describe('toIngressFailureCode', () => {
  it('maps specific errors to the stable ingress codes', () => {
    expect(toIngressFailureCode(new BodyTooLargeError(5))).toBe('too-large');
    expect(toIngressFailureCode(new RemoteMediaError('CONTENT_LENGTH_EXCEEDED', 'x'))).toBe('too-large');
    expect(toIngressFailureCode(new RemoteMediaError('UNSAFE_HOST', 'x'))).toBe('resource-unavailable');
    expect(toIngressFailureCode(new RemoteMediaError('NON_HTTP_SCHEME', 'x'))).toBe('resource-unavailable');
    expect(toIngressFailureCode(new RemoteMediaError('TOO_MANY_REDIRECTS', 'x'))).toBe('resource-unavailable');
    expect(toIngressFailureCode(new RemoteMediaError('BODY_INCOMPLETE', 'x'))).toBe('resource-unavailable');
    expect(toIngressFailureCode(new RemoteMediaError('ABORTED', 'x'))).toBe('download-failed');
    expect(toIngressFailureCode(new RemoteMediaError('DOWNLOAD_FAILED', 'x'))).toBe('download-failed');
    expect(toIngressFailureCode(new RemoteReadTimeoutError(10))).toBe('download-failed');
    expect(toIngressFailureCode(new RemoteMediaAbortedError())).toBe('download-failed');
  });

  it('falls back to download-failed for unknown thrown values', () => {
    expect(toIngressFailureCode(new Error('boom'))).toBe('download-failed');
    expect(toIngressFailureCode('nope')).toBe('download-failed');
    expect(toIngressFailureCode(undefined)).toBe('download-failed');
  });
});
