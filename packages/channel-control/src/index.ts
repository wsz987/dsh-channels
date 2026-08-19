/**
 * @wsz987/channel-control — universal Channel Control Plane.
 *
 * Exports the control-plane types (doc §14–§18), the sub-managers
 * (definition registry, credential manager, auth session manager, runtime
 * manager), the [ChannelControlService] (Cordis Service at ctx.channelControl)
 * and the control-plane error hierarchy.
 *
 * This package is adapter-agnostic: it never imports channel-weixin/qq/
 * dingtalk/lark/web. Platform differences are sealed behind ChannelDefinition.
 *
 * The Cordis plugin entry lives in ./plugin.ts (package export "./plugin").
 */
export * from './types.js';
export * from './errors.js';
export * from './definitions/registry.js';
export * from './credentials/manager.js';
export * from './auth/sanitizer.js';
export * from './auth/session-manager.js';
export * from './runtime/manager.js';
export * from './runtime/mount-handle.js';
export * from './access/policy-store.js';
export * from './access/validation.js';
export * from './access/materialize.js';
export * from './access/manager.js';
export * from './service.js';
