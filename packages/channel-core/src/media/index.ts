/**
 * Secure host boundary for remote binary media (plan §12 / §13).
 *
 * `@wsz987/channel-core/media` exports the pure bounded stream reader, the
 * pure SSRF/URL policy, and the `SecureRemoteMediaFetcher` that ties them
 * together over an injectable fetch. None of these modules perform network
 * I/O by themselves; the fetcher is the single seam that does.
 */
export * from './bounded-response.js';
export * from './mime-hint.js';
export * from './remote-policy.js';
export * from './secure-fetcher.js';
