/**
 * Pure, bounded reader over a WHATWG `ReadableStream<Uint8Array>` (the fetch
 * response body shape).
 *
 * This module performs NO network I/O. It is a fully in-process utility used
 * by `SecureRemoteMediaFetcher` to defensively read an untrusted remote body
 * under hard limits:
 *
 * - hard cumulative byte cap (rejected once exceeded → `BODY_TOO_LARGE`)
 * - optional expected-length check (short actual body → `BODY_INCOMPLETE`)
 * - optional read-idle timeout (no data for N ms → `BODY_READ_TIMEOUT`)
 * - external `AbortSignal` (→ `ABORTED`)
 */

import type { BinaryIngressFailureCode } from '../messages.js';
import { UnsafeHostError } from './remote-policy.js';

/** Stable code carried by a `RemoteMediaError`. */
export type RemoteMediaErrorCode =
  | 'BODY_TOO_LARGE'
  | 'BODY_READ_TIMEOUT'
  | 'BODY_INCOMPLETE'
  | 'ABORTED'
  | 'NON_HTTP_SCHEME'
  | 'UNSAFE_HOST'
  | 'TOO_MANY_REDIRECTS'
  | 'CONTENT_LENGTH_EXCEEDED'
  | 'DOWNLOAD_FAILED';

/** Errors raised while reading or downloading a remote binary asset. */
export class RemoteMediaError extends Error {
  readonly code: RemoteMediaErrorCode;
  constructor(code: RemoteMediaErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RemoteMediaError';
    this.code = code;
    // Preserve stable instanceof across transpiled class hierarchies.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The cumulative body size exceeded the configured hard byte cap.
 */
export class BodyTooLargeError extends RemoteMediaError {
  /** The byte cap that was exceeded. */
  readonly maxBytes: number;
  constructor(maxBytes: number, message?: string) {
    super('BODY_TOO_LARGE', message ?? `Remote body exceeded the ${maxBytes} byte cap`);
    this.name = 'BodyTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/**
 * No body chunk arrived within the read-idle timeout window.
 */
export class RemoteReadTimeoutError extends RemoteMediaError {
  readonly idleTimeoutMs: number;
  constructor(idleTimeoutMs: number, message?: string) {
    super('BODY_READ_TIMEOUT', message ?? `Remote body idle timeout after ${idleTimeoutMs}ms`);
    this.name = 'RemoteReadTimeoutError';
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

/**
 * The body ended before delivering the expected byte length.
 */
export class RemoteBodyIncompleteError extends RemoteMediaError {
  readonly expected: number;
  readonly received: number;
  constructor(expected: number, received: number, message?: string) {
    super('BODY_INCOMPLETE', message ?? `Remote body incomplete: expected ${expected}, got ${received}`);
    this.name = 'RemoteBodyIncompleteError';
    this.expected = expected;
    this.received = received;
  }
}

/**
 * The download was aborted via an external `AbortSignal`.
 */
export class RemoteMediaAbortedError extends RemoteMediaError {
  constructor(message?: string, options?: ErrorOptions) {
    super('ABORTED', message ?? 'Remote media download was aborted', options);
    this.name = 'RemoteMediaAbortedError';
  }
}

/** Options accepted by `readBoundedBody`. */
export interface ReadBoundedBodyOptions {
  /**
   * Hard cumulative byte cap. Reading rejects as soon as a chunk would push
   * the running total strictly above `maxBytes`.
   */
  maxBytes: number;
  /**
   * Read-idle timeout in ms. If no chunk arrives within this window, reading
   * rejects with `RemoteReadTimeoutError`. Disabled when omitted or <= 0.
   */
  idleTimeoutMs?: number;
  /**
   * Expected total byte length (e.g. from Content-Length). When provided and
   * the stream ends with fewer bytes, reading rejects with
   * `RemoteBodyIncompleteError`.
   */
  expectedLength?: number;
  /** External cancellation signal. */
  signal?: AbortSignal;
}

/**
 * Await one `reader.read()`, racing the read-idle timeout and an external
 * abort signal. The idle timer is cleared on success and re-armed by the
 * caller on each iteration, so the "no progress" window measures wall-clock
 * silence, not total elapsed time.
 */
function readOne(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ done: boolean; value?: Uint8Array }> {
  return new Promise<{ done: boolean; value?: Uint8Array }>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new RemoteMediaAbortedError());
    };

    if (signal?.aborted) {
      reject(new RemoteMediaAbortedError());
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    reader.read().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );

    if (idleTimeoutMs > 0) {
      timer = setTimeout(() => {
        cleanup();
        reject(new RemoteReadTimeoutError(idleTimeoutMs));
      }, idleTimeoutMs);
    }
  });
}

/**
 * Read a `ReadableStream<Uint8Array>` to completion under the given limits.
 * Returns the concatenated bytes. Pure — never touches the network.
 */
export async function readBoundedBody(
  stream: ReadableStream<Uint8Array>,
  options: ReadBoundedBodyOptions,
): Promise<Uint8Array> {
  const { maxBytes, idleTimeoutMs = 0, expectedLength, signal } = options;

  if (maxBytes <= 0) {
    throw new BodyTooLargeError(maxBytes, `maxBytes must be positive, got ${maxBytes}`);
  }

  if (signal?.aborted) {
    throw new RemoteMediaAbortedError();
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    for (;;) {
      if (signal?.aborted) {
        throw new RemoteMediaAbortedError();
      }
      const result = await readOne(reader, idleTimeoutMs, signal);
      if (result.done) {
        break;
      }
      // Per the stream contract, a non-done read always carries a value.
      const chunk = result.value as Uint8Array;
      received += chunk.byteLength;
      if (received > maxBytes) {
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  if (expectedLength !== undefined && received < expectedLength) {
    throw new RemoteBodyIncompleteError(expectedLength, received);
  }

  return concatenate(chunks, received);
}

/** Concatenate byte chunks into a single `Uint8Array`. */
export function concatenate(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Map any thrown error to the stable, de-identified `BinaryIngressFailureCode`
 * used on `BinaryPartBase.ingressFailure`. Unknown errors fall back to
 * `download-failed`.
 */
export function toIngressFailureCode(error: unknown): BinaryIngressFailureCode {
  if (error instanceof BodyTooLargeError) return 'too-large';
  if (error instanceof UnsafeHostError) return 'resource-unavailable';
  if (error instanceof RemoteMediaError) {
    switch (error.code) {
      case 'BODY_TOO_LARGE':
      case 'CONTENT_LENGTH_EXCEEDED':
        return 'too-large';
      case 'BODY_INCOMPLETE':
      case 'NON_HTTP_SCHEME':
      case 'UNSAFE_HOST':
      case 'TOO_MANY_REDIRECTS':
        return 'resource-unavailable';
      case 'ABORTED':
      case 'BODY_READ_TIMEOUT':
      case 'DOWNLOAD_FAILED':
        return 'download-failed';
      default:
        return 'download-failed';
    }
  }
  return 'download-failed';
}
