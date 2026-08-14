/**
 * @dsh/channel-weixin — direct Tencent Weixin iLink channel adapter.
 *
 * Replaces the old self-hosted HTTP gateway client with a direct iLink client
 * (QR login, getUpdates long-poll, sendmessage). Streaming is `buffered`.
 */
import { type Context } from '@deepseek-ai/cordis';
import {
  MemorySecretStore,
  MemoryStorage,
  mountChannelAdapter,
} from '@dsh/channel-core';
import type { WeixinConfig } from './config.js';
import { Config } from './config.js';
import { WeixinAdapter, type WeixinAdapterDeps } from './adapter.js';

export const name = 'channel-weixin';
export const inject: string[] = ['channels'];

// Adapter mounting uses the shared transactional `mountChannelAdapter`
// from @dsh/channel-core (doc section 5): register -> start; on start error
// abort + best-effort stop + unregister + rethrow; on unload abort + stop + unregister.

export { Config };
export { WeixinAdapter, type WeixinAdapterDeps } from './adapter.js';
export { ILinkClient, type ILinkClientOptions } from './ilink/client.js';
export {
  buildHeaders,
  buildWechatUin,
  encodeClientVersion,
  clientVersionFromString,
  type BuildHeadersOptions,
} from './ilink/headers.js';
export { buildBaseInfo } from './ilink/base-info.js';
export {
  ILinkError,
  StaleTokenError,
  ILinkTimeoutError,
  ILinkAbortError,
  ILinkSendError,
  redactMessage,
  normalizeILinkError,
} from './ilink/errors.js';
export {
  WeixinQrAuth,
  toChannelState,
  type WeixinQrAuthInternalState,
} from './auth/login.js';
export {
  AccountCredentialStore,
  redactCredential,
  type WeixinAccountCredential,
} from './auth/account-store.js';
export { SyncCursorStore } from './storage/sync-cursor.js';
export { ContextTokenStore } from './storage/context-token.js';
export { DedupWindow, dedupKey, stableHash, type DedupOptions } from './messaging/dedup.js';
export { mapInbound, mapItem } from './messaging/mapper.js';
export { WeixinMonitor, type WeixinMonitorOptions } from './messaging/monitor.js';
export { OutboundSender, buildSendTextPayload, type OutboundSenderOptions } from './messaging/send.js';
export { TypingController, type TypingControllerOptions } from './messaging/typing.js';
export { FetchTransport, type HttpTransport, type HttpRequestInit } from './transport.js';
export { manifest, type WeixinManifest } from './manifest.js';
// WX5 media scaffold.
export { aes128Decrypt, wx5NotImplemented } from './media/decrypt.js';
export { aes128Encrypt } from './media/encrypt.js';
export { downloadMedia } from './media/download.js';
export { uploadMedia } from './media/upload.js';
export { sendMedia } from './media/send-media.js';
// Protocol types.
export type {
  ILinkBaseInfo,
  ILinkCDNMedia,
  ILinkMessage,
  ILinkMessageItem,
  ILinkGetUpdatesRequest,
  ILinkGetUpdatesResponse,
  ILinkSendMessageRequest,
  ILinkSendMessageResponse,
  ILinkQrCodeResponse,
  ILinkQrStatus,
  ILinkQrStatusResponse,
  ILinkGetConfigRequest,
  ILinkGetConfigResponse,
  ILinkSendTypingRequest,
  ILinkSendTypingResponse,
  ILinkNotifyResponse,
  WeixinInboundMeta,
} from './ilink/types.js';

export function apply(ctx: Context, config: WeixinConfig, deps: WeixinAdapterDeps = {}): void {
  if (!config.enabled) return;
  const adapter = new WeixinAdapter(config, deps);
  mountChannelAdapter(
    ctx,
    adapter,
    (signal) => ({
      emit: (event) => ctx.channels.emit(event),
      logger: ctx.logger('channel-weixin'),
      secrets: new MemorySecretStore(),
      storage: new MemoryStorage(),
      signal,
    }),
  );
}
