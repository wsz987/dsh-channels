/**
 * @dsh/channel-telegram — Telegram Bot API channel adapter for DeepSeek
 * Harness: the M5 extensibility proof.
 *
 * A fifth channel built against the PUBLIC Channel Contract
 * (@dsh/channel-core + @dsh/channel-testkit) with zero changes to
 * channel-core, channel-harness, the @dsh/channels bundle or the four
 * official adapters. Deliberately NOT part of the bundle — it is the
 * third-party proof that the contract is extensible from the outside.
 *
 * Streaming is `buffered` (Telegram editMessageText makes 'edit' reachable;
 * documented as a future capability): chunks accumulate and are delivered
 * once via `adapter.send` at turn/end. Supports dm and group conversations.
 * Auth is token-driven: getMe() at start, long-poll getUpdates receive loop
 * with offset ack; no beginAuth/pollAuth in V1.
 */
import { type Context } from '@deepseek-ai/cordis';
import {
  MemorySecretStore,
  MemoryStorage,
  type ChannelAdapterContext,
} from '@dsh/channel-core';
import type { TelegramConfig } from './config.js';
import { Config } from './config.js';
import { TelegramAdapter, type TelegramAdapterDeps } from './adapter.js';

export const name = 'channel-telegram';
export const inject: string[] = ['channels'];

export { Config };
export { TelegramAdapter } from './adapter.js';
export { InboundProcessor } from './inbound.js';
export { OutboundSender } from './outbound.js';
export { HttpTelegramUpstream, type TelegramUpstream, type TelegramBotUser, type TelegramMedia } from './upstream.js';
export { FetchTransport, type HttpTransport, type HttpRequestInit } from './transport.js';
export { mapInbound, dedupKey, simpleHash, type TelegramInboundMeta } from './mapper.js';
export { manifest, type TelegramManifest } from './manifest.js';

export function apply(ctx: Context, config: TelegramConfig, deps: TelegramAdapterDeps = {}): void {
  if (!config.enabled) return;
  const adapter = new TelegramAdapter(config, deps);
  ctx.effect(async () => {
    const unregister = ctx.channels.register(adapter);
    const abort = new AbortController();
    const adapterCtx: ChannelAdapterContext = {
      emit: (event) => ctx.channels.emit(event),
      logger: ctx.logger('channel-telegram'),
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
