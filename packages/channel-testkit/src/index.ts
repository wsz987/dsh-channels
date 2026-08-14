/**
 * @wsz987/channel-testkit — contract tests, fake adapter/upstream/harness,
 * fixture loader and E2E helpers for channel adapters.
 *
 * Depends only on `@wsz987/channel-core` and cordis. Never imports
 * channel-harness or any Harness internals; the Harness side is only
 * exercised through the minimal `HarnessPort` defined here.
 */
export * from './contract-tests.js';
export * from './fake-adapter.js';
export * from './fake-upstream.js';
export * from './fixture-loader.js';
export * from './fake-harness.js';
export * from './harness-compat.js';
export * from './e2e.js';
