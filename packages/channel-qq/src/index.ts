/**
 * @dsh/channel-qq — QQ channel adapter for DeepSeek Harness.
 *
 * Maps the QQ platform (via a self-hosted HTTP upstream driver) to the stable
 * Channel Contract. Streaming is `buffered` (QQ has no native streaming or
 * editable cards): chunks accumulate and are delivered once via `adapter.send`
 * at turn/end. Supports direct (`dm`) and group conversations. Auth is QR
 * based: the gateway owns the platform session and the adapter relays an
 * opaque AuthChallenge/AuthStatePoll.
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
export { QQAdapter } from './adapter.js';
export { QQAuthManager, type QQAuthState } from './auth.js';
export { InboundProcessor } from './inbound.js';
export { OutboundSender } from './outbound.js';
export { HttpQQUpstream, type QQUpstream } from './upstream.js';
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
