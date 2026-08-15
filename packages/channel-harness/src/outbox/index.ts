/**
 * Durable Channel Outbox (plan §60-§69 / §71 / §95).
 *
 * Public surface of the outbox module: the request + error types, the durable
 * binding/target/attachment resolvers, the proactive capability resolver, the
 * `ChannelOutboxService`, and the `send_channel_message` tool registration.
 */
export * from './types.js';
export * from './target.js';
export * from './binding-resolver.js';
export * from './capabilities.js';
export * from './service.js';
export * from './tool-send.js';
