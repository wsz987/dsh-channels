/**
 * @wsz987/channel-weixin — direct Tencent Weixin iLink channel adapter.
 *
 * Replaces the old self-hosted HTTP gateway client with a direct iLink client
 * (QR login, getUpdates long-poll, sendmessage). Streaming is `buffered`.
 */
import { type Context } from '@deepseek-ai/cordis';
import { settingsNamespace, type SettingsProvider } from '@deepseek-ai/dsh-settings';
import { mountChannelAdapter } from '@wsz987/channel-core';
import type { ChannelAdapter, ChannelDefinition } from '@wsz987/channel-control';
import type { WeixinConfig } from './config.js';
import { Config } from './config.js';
import { WeixinAdapter, type WeixinAdapterDeps } from './adapter.js';
import { createWeixinDefinition } from './definition.js';
import { AccountCredentialStore } from './auth/account-store.js';

export const name = 'channel-weixin';
export const inject: string[] = ['channels'];

// Adapter mounting uses the shared transactional `mountChannelAdapter`
// from @wsz987/channel-core (doc section 5): register -> start; on start error
// abort + best-effort stop + unregister + rethrow; on unload abort + stop + unregister.

export { Config };
export { WeixinAdapter, type WeixinAdapterDeps } from './adapter.js';
export {
  createWeixinDefinition,
  type WeixinDefinitionOptions,
} from './definition.js';
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
export {
  MemoryDedupStore,
  PersistentDedupStore,
  dedupKey,
  stableHash,
  type DedupStore,
  type DedupRecord,
  type DedupOptions,
} from './messaging/dedup.js';
export { mapInbound, mapItem } from './messaging/mapper.js';
export { WeixinMonitor, CursorCommitError, type WeixinMonitorOptions } from './messaging/monitor.js';
export { OutboundSender, buildSendTextPayload, type OutboundSenderOptions } from './messaging/send.js';
export { TypingController, type TypingControllerOptions } from './messaging/typing.js';
export { formatQuotedContext } from './messaging/quote.js';
export {
  transcodeSilkVoice,
  SILK_ENCODE_TYPE,
  DEFAULT_SILK_SAMPLE_RATE,
  type SilkTranscodeOptions,
  type SilkTranscodeResult,
} from './media/silk-transcode.js';
export { WeixinConfigManager, type WeixinConfigManagerOptions } from './upstream/config-manager.js';
export { FetchTransport, type HttpTransport, type HttpRequestInit } from './transport.js';
export { manifest, type WeixinManifest } from './manifest.js';
export {
  createWeixinUpstream,
  TencentWeixinUpstream,
  UpstreamCapabilityError,
  type WeixinUpstream,
  type WeixinUpstreamHostEnv,
  type WeixinQrTicket,
  type WeixinQrAuthPoll,
  type WeixinAuthCredential,
  type WeixinMediaRef,
  type WeixinDownloadResult,
  type WeixinTextParams,
  type WeixinImageParams,
  type WeixinFileParams,
  type WeixinVideoParams,
  type WeixinSendResult,
} from './upstream/index.js';
// WX5 media.
export { aes128Decrypt } from './media/decrypt.js';
export { aes128Encrypt } from './media/encrypt.js';
export {
  downloadMedia,
  resolveDownloadUrl,
  type DownloadedMedia,
  type DownloadMediaOptions,
} from './media/download.js';
export {
  uploadMedia,
  buildUploadUrlRequest,
  aesEcbPaddedSize,
  WX5_MEDIA_TYPE_IMAGE,
  WX5_MEDIA_TYPE_VIDEO,
  WX5_MEDIA_TYPE_FILE,
  WX5_MEDIA_TYPE_VOICE,
  type UploadedMedia,
  type UploadMediaOptions,
} from './media/upload.js';
export {
  sendMedia,
  buildSendMediaPayload,
  type SendMediaOptions,
} from './media/send-media.js';
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
  ILinkGetUploadUrlRequest,
  ILinkGetUploadUrlResponse,
  ILinkSendTypingRequest,
  ILinkSendTypingResponse,
  ILinkNotifyResponse,
  WeixinInboundMeta,
} from './ilink/types.js';

type ChannelControlLike = {
  definitions: { register(d: ChannelDefinition): unknown };
  runtime?: { adapter(channelId: string): ChannelAdapter | undefined };
};

export function apply(ctx: Context, config: WeixinConfig, deps: WeixinAdapterDeps = {}): void {
  const control = ctx.get('channelControl') as ChannelControlLike | undefined;
  if (control) {
    // Control-plane entry (doc §43): register the definition EVEN when
    // disabled — the control plane auto-starts it (autoStart) and a disabled
    // definition must stay visible so the Web control plane can re-enable it
    // later (doc §19/§20). The M1 QR flow is driven through the mounted adapter.
    const settings = ctx.get('settings') as SettingsProvider | undefined;
    const scope = settings?.register(settingsNamespace('channels-weixin'), Config, { base: config });
    // Weixin owner auto-discovery (plan §23): the control plane never reads
    // weixin credential storage; a closure here maps the stored scanning
    // user's canonical id out of the platform's own AccountCredentialStore.
    const resolveOwnerIdentity = async (accountId: string): Promise<string | undefined> => {
      const store = new AccountCredentialStore({
        secrets: ctx.channels.resources.secrets,
        storage: ctx.channels.resources.storage,
        accountId,
      });
      const credential = await store.load();
      return credential?.userId;
    };
    control.definitions.register(
      createWeixinDefinition({
        config: scope?.get() ?? config,
        deps,
        getAdapter: () => control.runtime?.adapter('weixin'),
        persistEnabled: (enabled) => scope?.update({ enabled }) ?? Promise.resolve(),
        resolveOwnerIdentity,
      }),
    );
    return;
  }
  // Legacy headless/standalone path (no channel-control): mount as today.
  // There is no directory/control surface to re-enable a disabled channel, so
  // the config `enabled` gate still applies (doc §20).
  if (!config.enabled) return;
  const adapter = new WeixinAdapter(config, deps);
  mountChannelAdapter(
    ctx,
    adapter,
    (signal) => ctx.channels.createAdapterContext({ channelId: 'weixin', signal }),
  );
}
