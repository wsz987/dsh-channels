/**
 * @dsh/channel-<channel> — <ChannelName> channel adapter for DeepSeek Harness.
 *
 * Maps the platform (via a self-hosted HTTP upstream driver) to the stable
 * Channel Contract. Streaming is `buffered`: chunks accumulate and are
 * delivered once via `adapter.send` at turn/end.
 *
 * This file doubles as the Cordis plugin entry: it exports the plugin shape
 * (`name` / `inject` / `apply`) exactly like the official adapters, so the
 * DSH bundle patch in cordis.patch.yml can wire it into a Harness profile.
 */
import { type Context } from '@deepseek-ai/cordis';
import {
  defineChannelAdapter,
  MemorySecretStore,
  MemoryStorage,
  type ChannelAdapterContext,
} from '@dsh/channel-core';
import type { ChannelConfig } from './config.js';
import { Config } from './config.js';
import { ChannelNameAdapter, type ChannelAdapterDeps } from './adapter.js';

export const name = 'channel-<channel>';
export const inject: string[] = ['channels'];

export { Config };
export { ChannelNameAdapter, InboundProcessor } from './adapter.js';
export { HttpChannelUpstream, type ChannelUpstream, type ChannelMedia } from './upstream.js';
export { FetchTransport, type HttpTransport, type HttpRequestInit } from './transport.js';
export {
  mapInbound,
  toTextPayload,
  dedupKey,
  simpleHash,
  type ChannelInboundMeta,
  type ChannelTextPayload,
} from './mapper.js';

export function apply(ctx: Context, config: ChannelConfig, deps: ChannelAdapterDeps = {}): void {
  if (!config.enabled) return;
  const adapter = new ChannelNameAdapter(config, deps);
  ctx.effect(async () => {
    const unregister = ctx.channels.register(adapter);
    const abort = new AbortController();
    const adapterCtx: ChannelAdapterContext = {
      emit: (event) => ctx.channels.emit(event),
      logger: ctx.logger('channel-<channel>'),
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

/**
 * Object-form example using the `defineChannelAdapter` authoring helper
 * (architecture §33). Real adapters usually export a class like
 * `ChannelNameAdapter` instead — this shows the minimal supported surface.
 */
export default defineChannelAdapter({
  id: '<channel>',
  capabilities: {
    text: true,
    image: true,
    file: true,
    audio: true,
    video: false,
    markdown: true,
    cards: false,
    reactions: false,
    threads: false,
    streaming: 'buffered',
  },
  async start() {
    // Wire the upstream connection and receive loop here (see ChannelNameAdapter).
  },
  async stop() {
    // Tear down the upstream connection here.
  },
  async send() {
    return { delivered: true };
  },
});
