/**
 * index.ts — public surface of the Weixin upstream layer (plan §15/§38).
 *
 * Re-exports the DSH-side port (`WeixinUpstream`) and the factory
 * (`createWeixinUpstream`). Consumers (the adapter) depend only on the port;
 * the Tencent implementation and the vendor deep-import boundary stay internal.
 */
import type { HttpTransport } from '../transport.js';
import type { WeixinConfig } from '../config.js';
import type { SecureRemoteMediaFetcher } from '@wsz987/channel-core';
import { TencentWeixinUpstream, type WeixinUpstreamOptions } from './tencent-upstream.js';
import type { WeixinUpstream } from './port.js';

export type {
  WeixinUpstream,
  WeixinUpstreamHostEnv,
  WeixinQrTicket,
  WeixinQrAuthPoll,
  WeixinAuthCredential,
  WeixinMediaRef,
  WeixinDownloadResult,
  WeixinTextParams,
  WeixinImageParams,
  WeixinFileParams,
  WeixinSendResult,
  QrAuthState,
} from './port.js';
export { UpstreamCapabilityError } from './port.js';
export { TencentWeixinUpstream, type WeixinUpstreamOptions } from './tencent-upstream.js';
export { normalizeMediaRef, toPortMediaRef, toDownloadResult, toSendMediaRef } from './compat.js';

export interface CreateWeixinUpstreamOptions {
  config: WeixinConfig;
  transport?: HttpTransport;
  now?: () => number;
  rand?: () => number;
  /** Injectable fetch for media download (tests); defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable shared secure downloader (tests). */
  mediaFetcher?: SecureRemoteMediaFetcher;
}

/**
 * Create the Weixin upstream facade. Call [WeixinUpstream.extend/bind] with a
 * host env before using startMonitor/send/download — see [WeixinUpstreamHostEnv]
 * and [TencentWeixinUpstream.bind].
 */
export function createWeixinUpstream(options: CreateWeixinUpstreamOptions): WeixinUpstream & {
  bind(env: import('./port.js').WeixinUpstreamHostEnv): void;
  loadCredential(): Promise<boolean>;
  startTyping(peer: string): Promise<void>;
  stopTyping(peer: string): Promise<void>;
  getHealthInfo(): Promise<{ authenticated: boolean; connection: import('./tencent-upstream.js').WeixinConnectionState }>;
  get_iLinkClient(): import('../ilink/client.js').ILinkClient | undefined;
} {
  return new TencentWeixinUpstream(options);
}
