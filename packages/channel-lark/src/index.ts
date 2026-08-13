/**
 * @dsh/channel-lark — Lark / Feishu channel adapter for DeepSeek Harness.
 *
 * Maps the Lark platform (via a self-hosted HTTP upstream driver) to the
 * stable Channel Contract. Streaming is `edit` (editable card): create card →
 * update with content → finalize → failure card. Threads are preserved
 * (`conversation.threadId`) so Harness sessions isolate per thread. Auth is
 * connection-state driven — the gateway owns platform credentials.
 */
import { type Context } from '@deepseek-ai/cordis';
import {
  MemorySecretStore,
  MemoryStorage,
  type ChannelAdapterContext,
} from '@dsh/channel-core';
import type { LarkConfig } from './config.js';
import { Config } from './config.js';
import { LarkAdapter, type LarkAdapterDeps } from './adapter.js';

export const name = 'channel-lark';
export const inject: string[] = ['channels'];

export { Config };
export { LarkAdapter } from './adapter.js';
export { LarkCardReply, type LarkCardStatus, type LarkCardUpdate } from './card.js';
export { InboundProcessor } from './inbound.js';
export { OutboundSender } from './outbound.js';
export { HttpLarkUpstream, type LarkUpstream } from './upstream.js';
export { FetchTransport, type HttpTransport } from './transport.js';
export {
  mapInbound,
  mapInteraction,
  toTextPayload,
  dedupKey,
  simpleHash,
  type LarkTextPayload,
} from './mapper.js';
export { manifest, type LarkManifest } from './manifest.js';

export function apply(ctx: Context, config: LarkConfig, deps: LarkAdapterDeps = {}): void {
  if (!config.enabled) return;
  const adapter = new LarkAdapter(config, deps);
  ctx.effect(async () => {
    const unregister = ctx.channels.register(adapter);
    const abort = new AbortController();
    const adapterCtx: ChannelAdapterContext = {
      emit: (event) => ctx.channels.emit(event),
      logger: ctx.logger('channel-lark'),
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
