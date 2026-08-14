/**
 * @dsh/channel-qq — QQ channel adapter for DeepSeek Harness.
 *
 * Maps the QQ platform to the stable Channel Contract. Two upstream drivers
 * implement `QQUpstream` behind `config.upstream.mode`:
 * - 'sdk'     — the official QQ 开放平台 WebSocket gateway protocol
 *   implemented in-source (isolated source, no third-party SDK): token auth
 *   (AppId + ClientSecret → access token), gateway connect/identify/
 *   heartbeat/reconnect, inbound C2C / group-@ dispatch, and real v2 OpenAPI
 *   outbound sends.
 * - 'gateway' — self-hosted HTTP gateway long-poll driver (legacy; QR auth
 *   via beginAuth/pollAuth).
 *
 * Streaming is `buffered` (QQ has no native streaming or editable cards):
 * chunks accumulate and are delivered once via `adapter.send` at turn/end.
 * Supports direct (`dm`) and group conversations.
 */
import { type Context } from '@deepseek-ai/cordis';
import {
  MemorySecretStore,
  MemoryStorage,
  type ChannelAdapterContext,
} from '@dsh/channel-core';
import type { QQConfig } from './config.js';
import { Config } from './config.js';
import { QQAdapter, type QQAdapterDeps } from './adapter.js';

export const name = 'channel-qq';
export const inject: string[] = ['channels'];

export { Config };
export { QQAdapter, type QQAdapterDeps } from './adapter.js';
export { QQAuthManager, type QQAuthState } from './auth.js';
export { InboundProcessor } from './inbound.js';
export { OutboundSender } from './outbound.js';
export { HttpQQUpstream, type QQUpstream } from './upstream.js';
export {
  QQGatewayUpstream,
  createDefaultGatewayClient,
  toGatewayRaw,
  QQ_INTENT_GROUP_AND_C2C,
  QQ_OP,
  QQ_EVENT_C2C_MESSAGE_CREATE,
  QQ_EVENT_GROUP_AT_MESSAGE_CREATE,
  type QQGatewayClient,
  type QQGatewayFrame,
  type QQGatewayUpstreamOptions,
} from './qq-gateway-upstream.js';
export { FetchTransport, type HttpTransport } from './transport.js';
export {
  mapInbound,
  toTextPayload,
  dedupKey,
  simpleHash,
  type QQTextPayload,
} from './mapper.js';
export { manifest, type QQManifest } from './manifest.js';

export function apply(ctx: Context, config: QQConfig, deps: QQAdapterDeps = {}): void {
  if (!config.enabled) return;
  const adapter = new QQAdapter(config, deps);
  ctx.effect(async () => {
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
