/**
 * @wsz987/channel-harness — the only package that imports Harness public APIs.
 *
 * Bridges ChannelEvents (from `@wsz987/channel-core` adapters) to Harness
 * sessions: inbound messages resolve to a SessionBinding, resolve/create an
 * agent via `ctx.agents`, and call `agent.followup`; outbound assistant
 * output flows back through the official `session/event` feed to the channel
 * adapter's reply pipeline.
 *
 * This package never imports platform SDKs and never depends on concrete
 * channel packages.
 */
export * from './config.js';
export * from './channel-label.js';
export * from './dsh-home.js';
export * from './session-router.js';
export * from './binding-store.js';
export * from './agent-router.js';
export * from './agent-manager.js';
export * from './message-converter.js';
export * from './reply-router.js';
export * from './reply-context-store.js';
export * from './bridge.js';
export * from './lifecycle.js';
export * from './workspace-resolver.js';
export { name, inject, apply } from './plugin.js';
