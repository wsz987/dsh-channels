/**
 * @dsh/channel-weixin — Weixin channel adapter for DeepSeek Harness.
 *
 * Maps the weixin platform (via a self-hosted HTTP upstream driver) to the
 * stable Channel Contract. Streaming is `buffered` (Weixin has no native
 * streaming or editable cards).
 */
import { type Context } from '@deepseek-ai/cordis';
import {
  MemorySecretStore,
  MemoryStorage,
  type ChannelAdapterContext,
} from '@dsh/channel-core';
import type { WeixinConfig } from './config.js';
import { Config } from './config.js';
import { WeixinAdapter, type WeixinAdapterDeps } from './adapter.js';

export const name = 'channel-weixin';
export const inject: string[] = ['channels'];

export { Config };
export { WeixinAdapter } from './adapter.js';
export { WeixinAuthManager, type WeixinAuthState } from './auth.js';
export { InboundProcessor } from './inbound.js';
export { OutboundSender } from './outbound.js';
export { HttpWeixinUpstream, type WeixinUpstream } from './upstream.js';
export { FetchTransport, type HttpTransport } from './transport.js';
export {
  mapInbound,
  toTextPayload,
  dedupKey,
  simpleHash,
  type WeixinTextPayload,
} from './mapper.js';
export { manifest, type WeixinManifest } from './manifest.js';

export function apply(ctx: Context, config: WeixinConfig, deps: WeixinAdapterDeps = {}): void {
  if (!config.enabled) return;
  const adapter = new WeixinAdapter(config, deps);
  ctx.effect(async () => {
    const unregister = ctx.channels.register(adapter);
    const abort = new AbortController();
    const adapterCtx: ChannelAdapterContext = {
      emit: (event) => ctx.channels.emit(event),
      logger: ctx.logger('channel-weixin'),
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
