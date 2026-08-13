/**
 * @dsh/channel-dingtalk — DingTalk channel adapter for DeepSeek Harness.
 *
 * Maps the DingTalk platform (via a self-hosted HTTP upstream driver) to the
 * stable Channel Contract. Streaming is `edit` (AI Card): create card →
 * update with content → finalize → failure card. Auth is connection-state
 * driven — the gateway owns platform credentials.
 */
import { type Context } from '@deepseek-ai/cordis';
import {
  MemorySecretStore,
  MemoryStorage,
  type ChannelAdapterContext,
} from '@dsh/channel-core';
import type { DingTalkConfig } from './config.js';
import { Config } from './config.js';
import { DingTalkAdapter, type DingTalkAdapterDeps } from './adapter.js';

export const name = 'channel-dingtalk';
export const inject: string[] = ['channels'];

export { Config };
export { DingTalkAdapter } from './adapter.js';
export { DingTalkCardReply, type DingTalkCardStatus, type DingTalkCardUpdate } from './ai-card.js';
export { InboundProcessor } from './inbound.js';
export { OutboundSender } from './outbound.js';
export { HttpDingTalkUpstream, type DingTalkUpstream } from './upstream.js';
export { FetchTransport, type HttpTransport } from './transport.js';
export {
  mapInbound,
  toTextPayload,
  dedupKey,
  simpleHash,
  type DingTalkTextPayload,
} from './mapper.js';
export { manifest, type DingTalkManifest } from './manifest.js';

export function apply(ctx: Context, config: DingTalkConfig, deps: DingTalkAdapterDeps = {}): void {
  if (!config.enabled) return;
  const adapter = new DingTalkAdapter(config, deps);
  ctx.effect(async () => {
    const unregister = ctx.channels.register(adapter);
    const abort = new AbortController();
    const adapterCtx: ChannelAdapterContext = {
      emit: (event) => ctx.channels.emit(event),
      logger: ctx.logger('channel-dingtalk'),
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
