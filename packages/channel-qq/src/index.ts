/**
 * @wsz987/channel-qq — QQ channel adapter for DeepSeek Harness.
 *
 * Maps the QQ platform (via the official Tencent SDK
 * `@tencent-connect/qqbot-nodejs`) to the stable Channel Contract. The SDK
 * owns Token acquisition/refresh, the WebSocket gateway, media upload and C2C
 * streaming; DSH keeps its own dedup policy and reply routing.
 *
 * The adapter requires `ctx.channels` and `ctx.credentials`: the QQ AppSecret
 * is resolved at startup through `ctx.credentials` (`appSecretRef`) and passed
 * to the adapter as `deps.appSecret`. The secret value never enters the
 * profile config — only its reference name does (v1.1 §7, QQ-R5).
 *
 * Since M2B, apply() is channel-control-aware (doc §25/§27/§47): when the
 * universal Channel Control Plane (ctx.channelControl) is present it registers
 * the QQ `ChannelDefinition` and lets the plane drive setup / credentials /
 * auto-start. When channel-control is absent it falls back to the legacy
 * headless mount — mounting ONLY when configured, and never throwing on an
 * unconfigured channel.
 *
 * Streaming is target-aware: C2C with a triggering message id streams natively
 * (replace-semantics full-text); groups are buffered and delivered once at
 * `turn/end`.
 */
import { type Context } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { mountChannelAdapter } from '@wsz987/channel-core';
import type { QQConfig } from './config.js';
import { Config, QQ_APP_SECRET_REF } from './config.js';
import { QQAdapter, type QQAdapterDeps } from './adapter.js';
import { createQQDefinition } from './definition.js';
import type { QQDefinitionOptions } from './definition.js';
import type { CredentialSeam } from './definition.js';

export const name = 'channel-qq';
export const inject: string[] = ['channels', 'credentials'];

export { Config, QQ_APP_SECRET_REF };
export type { QQConfig } from './config.js';
export { QQAdapter, type QQAdapterDeps } from './adapter.js';
export { createQQDefinition } from './definition.js';
export type { CredentialSeam, QQDefinitionOptions } from './definition.js';
export {
  TencentQQSdkClient,
  FakeQQSdkClient,
  FakeStreamSession,
  adaptLogger,
  mediaOpts,
  decodeDataUri,
  type QQSdkClient,
  type QQReplyTarget,
  type QQStreamTarget,
  type QQStreamSession,
  type MediaOptions,
} from './sdk-client.js';
export { InboundProcessor } from './inbound.js';
export { OutboundSender, toReplyTarget } from './outbound.js';
export { QQStreamingReply } from './streaming-reply.js';
export { mapInbound, mapMessageParts, type QQInboundMeta } from './mapper.js';
export { manifest, type QQManifest } from './manifest.js';

export function apply(ctx: Context, config: QQConfig, deps: QQAdapterDeps = {}): void {
  if (!config.enabled) return;

  const control = ctx.get('channelControl') as
    | { definitions: { register(d: unknown): unknown } }
    | undefined;

  if (control) {
    // Universal Channel Control Plane present: register the definition and
    // let the control plane drive setup/credential/auto-start (doc §25/§27).
    const credentials = (ctx as Context & { credentials: CredentialSeam }).credentials;
    control.definitions.register(createQQDefinition({ config, deps, credentials }));
    return;
  }

  // Legacy / headless fallback when channel-control is absent. Mount ONLY when
  // configured: an unconfigured channel logs a warning and returns WITHOUT
  // throwing, so it can never crash profile startup (doc §25).
  if (!config.appSecretRef) {
    ctx.logger.warn(`[channel-qq] no appSecretRef configured; skipping mount`);
    return;
  }

  ctx.effect(async () => {
    const credential = await ctx.credentials.resolve(credentialRef(config.appSecretRef));
    if (!credential) {
      ctx.logger.warn(
        `[channel-qq] QQ credential "${config.appSecretRef}" is not configured; skipping mount`,
      );
      return () => {};
    }

    const adapter = new QQAdapter(config, { ...deps, appSecret: credential.value });

    // Share the ChannelService's durable runtime resources (logger / emit /
    // secrets / storage / signal) instead of hand-rolling per-mount Memory
    // stores — QQ must not bypass the unified persistence backend.
    mountChannelAdapter(
      ctx,
      adapter,
      (signal) => ctx.channels.createAdapterContext({ channelId: 'qq', signal }),
    );
    // The mount owns the adapter lifecycle; this outer effect only scopes the
    // async credential resolution, so its disposer is a no-op.
    return () => {};
  });
}
