/**
 * @dsh/channel-qq — QQ channel adapter for DeepSeek Harness.
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
 * Streaming is target-aware: C2C with a triggering message id streams natively
 * (replace-semantics full-text); groups are buffered and delivered once at
 * `turn/end`.
 */
import { type Context } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import {
  MemorySecretStore,
  MemoryStorage,
  type ChannelAdapterContext,
} from '@dsh/channel-core';
import type { QQConfig } from './config.js';
import { Config } from './config.js';
import { QQAdapter, type QQAdapterDeps } from './adapter.js';

export const name = 'channel-qq';
export const inject: string[] = ['channels', 'credentials'];

export { Config };
export type { QQConfig } from './config.js';
export { QQAdapter, type QQAdapterDeps } from './adapter.js';
export {
  TencentQQSdkClient,
  FakeQQSdkClient,
  FakeStreamSession,
  adaptLogger,
  mediaOpts,
  type QQSdkClient,
  type QQReplyTarget,
  type QQStreamTarget,
  type QQStreamSession,
} from './sdk-client.js';
export { InboundProcessor } from './inbound.js';
export { OutboundSender, toReplyTarget } from './outbound.js';
export { QQStreamingReply } from './streaming-reply.js';
export { mapInbound, mapMessageParts, type QQInboundMeta } from './mapper.js';
export { manifest, type QQManifest } from './manifest.js';

export function apply(ctx: Context, config: QQConfig, deps: QQAdapterDeps = {}): void {
  if (!config.enabled) return;
  ctx.effect(async () => {
    const credential = await ctx.credentials.resolve(credentialRef(config.appSecretRef));
    if (!credential) {
      throw new Error(`QQ credential "${config.appSecretRef}" is not configured`);
    }

    const adapter = new QQAdapter(config, { ...deps, appSecret: credential.value });

    const unregister = ctx.channels.register(adapter);
    const abort = new AbortController();
    const adapterCtx: ChannelAdapterContext = {
      emit: (event) => ctx.channels.emit(event),
      logger: ctx.logger('channel-qq'),
      secrets: new MemorySecretStore(),
      storage: new MemoryStorage(),
      signal: abort.signal,
    };
    await adapter.start(adapterCtx);
    return async () => {
      abort.abort();
      await adapter.stop();
      unregister();
    };
  });
}
