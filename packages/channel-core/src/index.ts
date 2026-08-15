/**
 * @wsz987/channel-core — stable cross-channel contract and Cordis ChannelService.
 *
 * Exports identity types, structured messages, channel events, capabilities,
 * the `ChannelAdapter` contract, `ReplyHandle`, the `ChannelMountHandle`
 * disposer (returned by `mountChannelAdapter`), the `ChannelService` (Cordis
 * Service at `ctx.channels`), error codes, health, storage and secrets.
 *
 * This package never imports Harness Agent APIs and never depends on any
 * specific messaging platform.
 */
export * from './account.js';
export * from './adapter.js';
export * from './capabilities.js';
export * from './define.js';
export * from './context.js';
export * from './errors.js';
export * from './events.js';
export * from './file-secret-store.js';
export * from './file-storage.js';
export * from './health.js';
export * from './messages.js';
export * from './mount.js';
export * from './paths.js';
export * from './registry.js';
export * from './reply.js';
export * from './runtime-resources.js';
export * from './secrets.js';
export * from './service.js';
export * from './storage.js';
