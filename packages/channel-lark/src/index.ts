/**
 * @wsz987/channel-lark — Lark / Feishu channel adapter for DeepSeek Harness.
 *
 * Maps the Lark platform to the stable Channel Contract. Two upstream
 * drivers implement `LarkUpstream` behind `config.upstream.mode`:
 * - 'sdk'     — inbound via the official `@larksuiteoapi/node-sdk`
 *   (WebSocket long-connection, `im.message.receive_v1`); outbound
 *   delegated to the HTTP driver.
 * - 'gateway' — self-hosted HTTP gateway long-poll driver (legacy).
 *
 * Streaming is `edit` (editable card): create card → update with content →
 * finalize → failure card. Threads are preserved (`conversation.threadId`)
 * so Harness sessions isolate per thread. Auth is connection-state driven —
 * the driver owns platform credentials (never logged).
 */
import { type Context } from '@deepseek-ai/cordis';
import { mountChannelAdapter } from '@wsz987/channel-core';
import type { LarkConfig } from './config.js';
import { Config } from './config.js';
import { LarkAdapter, type LarkAdapterDeps } from './adapter.js';

export const name = 'channel-lark';
export const inject: string[] = ['channels'];

export { Config };
export { LarkAdapter, resolveDomain, type LarkAdapterDeps } from './adapter.js';
export { LarkCardReply, type LarkCardStatus, type LarkCardUpdate } from './card.js';
export { InboundProcessor } from './inbound.js';
export { OutboundSender } from './outbound.js';
export { HttpLarkUpstream, type LarkUpstream } from './upstream.js';
export {
  LarkSdkUpstream,
  toGatewayRaw,
  MESSAGE_EVENT_KEY,
  type LarkSdkClient,
  type LarkSdkDispatcher,
  type LarkSdkUpstreamOptions,
  type LarkMessageEventData,
} from './lark-sdk-upstream.js';
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
  mountChannelAdapter(
    ctx,
    adapter,
    (signal) => ctx.channels.createAdapterContext({ channelId: 'lark', signal }),
  );
}