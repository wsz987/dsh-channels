/**
 * @wsz987/channel-dingtalk — DingTalk channel adapter for DeepSeek Harness.
 *
 * Maps the DingTalk platform to the stable Channel Contract. Two upstream
 * drivers implement `DingTalkUpstream` behind `config.upstream.mode`:
 * - 'sdk'     — inbound via the official `dingtalk-stream` SDK (WebSocket
 *   stream mode); outbound via `sessionWebhook` and the AI Card OpenAPI.
 * - 'gateway' — self-hosted HTTP gateway long-poll driver (legacy).
 *
 * Credential model: the DingTalk AppSecret never lives in config. Config only
 * carries its credential reference (`upstream.clientSecretRef`, default
 * `DSH_CHANNEL_DINGTALK_MAIN_CLIENT_SECRET`); the value is resolved via
 * `ctx.credentials` and injected as `deps.clientSecret`. A legacy plaintext
 * `upstream.clientSecret` is migrated to the credentials seam ONCE on startup
 * and deleted. Streaming is `edit` (AI Card): create card → update with
 * content → finalize → failure card. Auth is connection-state driven — the
 * driver owns platform credentials (never logged).
 */
import { type Context } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { settingsNamespace, type SettingsProvider } from '@deepseek-ai/dsh-settings';
import { mountChannelAdapter } from '@wsz987/channel-core';
import type { DingTalkConfig } from './config.js';
import { Config, DINGTALK_CLIENT_SECRET_REF } from './config.js';
import { DingTalkAdapter, type DingTalkAdapterDeps } from './adapter.js';
import { createDingTalkDefinition } from './definition.js';

export const name = 'channel-dingtalk';
export const inject: string[] = ['channels', 'credentials'];

export { Config, DINGTALK_CLIENT_SECRET_REF };
export { createDingTalkDefinition } from './definition.js';
export {
  beginDingTalkDeviceAuth,
  pollDingTalkDeviceAuth,
  type DingTalkDeviceAuthOptions,
  type DingTalkDevicePollResult,
} from './auth/device-registration.js';
export { DingTalkAdapter, type DingTalkAdapterDeps } from './adapter.js';
export { DingTalkCardReply, type DingTalkCardStatus, type DingTalkCardUpdate } from './ai-card.js';
export { InboundProcessor } from './inbound.js';
export {
  IMAGE_IDLE_TIMEOUT_MS,
  IMAGE_MAX_BYTES,
  FILE_MAX_BYTES,
  defaultSecureFetcher,
  findFetchableImages,
  hydrateFiles,
  hydrateImages,
  type BinaryIngressFailureCode,
  type HydrateFilesOptions,
  type HydrateImagesOptions,
  type RemoteMediaFetchLike,
  type ResolvedImageLocator,
} from './image-hydrator.js';
export {
  OutboundSender,
  type OutboundSenderOptions,
} from './outbound.js';
export { HttpDingTalkUpstream, type CardCreateResult, type DingTalkUpstream } from './upstream.js';
export {
  DingTalkOfficialUpstream,
  DingTalkOpenApiPortImpl,
  OFFICIAL_BASIS,
  type DingTalkOfficialUpstreamOptions,
} from './official-upstream.js';
export {
  type AccessTokenResult,
  type DingTalkOpenApiCredentials,
  type DingTalkOpenApiPort,
  type MediaResolverLike,
  type MediaSendInput,
  type MediaUploadInput,
  type MediaUploadResult,
  type OutboxCapabilities,
  type ProactiveTextInput,
  type ResolvedMedia,
  type RobotMessageSendResult,
} from './openapi-port.js';
export {
  DingTalkStreamUpstream,
  ackRobotMessage,
  toGatewayRaw,
  type DingTalkStreamClient,
  type DingTalkStreamMessage,
  type DingTalkStreamUpstreamOptions,
} from './stream-upstream.js';
export { FetchTransport, type HttpTransport } from './transport.js';
export {
  mapInbound,
  toTextPayload,
  dedupKey,
  simpleHash,
  type DingTalkTextPayload,
} from './mapper.js';
export { manifest, type DingTalkManifest } from './manifest.js';

/**
 * Channel plugin entry point.
 *
 * Priority:
 * 1. One-time migration of a legacy plaintext `upstream.clientSecret` into the
 *    credentials seam (`upstream.clientSecretRef`), then delete the plaintext.
 *    This is the ONLY migration path — the value is never double-written.
 * 2. If the channel control plane (`ctx.channelControl`) is present, register a
 *    `DingTalkDefinition` so the control plane owns setup/credential/runtime.
 * 3. Legacy standalone fallback (channel-control absent, doc §25/§27): mount the
 *    adapter directly, resolving SDK-mode credentials via `ctx.credentials` and
 *    logging a warning instead of throwing when the credential is missing.
 */
type ChannelControlLike = {
  definitions: { register(def: unknown): unknown };
  runtime?: { restart(channelId: string, accountId?: string): Promise<void> };
};

export function apply(ctx: Context, config: DingTalkConfig, deps: DingTalkAdapterDeps = {}): void {
  if (!config.enabled) return;

  // --- One-time legacy plaintext -> credential-reference migration (§52 Task 4).
  // The value is written to the credentials seam exactly once, then the
  // plaintext is deleted from the in-memory config. Never double-written.
  const legacySecret = (config.upstream as { clientSecret?: string }).clientSecret;
  const ref = config.upstream.clientSecretRef ?? DINGTALK_CLIENT_SECRET_REF;
  if (typeof legacySecret === 'string' && legacySecret.length > 0) {
    void ctx.credentials.set(credentialRef(ref), legacySecret);
    // Mutate the config so the plaintext is never read or written again.
    delete (config.upstream as { clientSecret?: string }).clientSecret;
    ctx.logger('channel-dingtalk').info('migrated legacy dingtalk clientSecret to credentials');
  }

  const control = ctx.get('channelControl') as ChannelControlLike | undefined;
  if (control) {
    // The control plane owns lifecycle: register only, runtime auto-starts.
    const settings = ctx.get('settings') as SettingsProvider | undefined;
    const scope = settings?.register(settingsNamespace('channels-dingtalk'), Config, { base: config });
    const effectiveConfig = scope?.get() ?? config;
    control.definitions.register(
      createDingTalkDefinition({
        config: effectiveConfig,
        deps,
        credentials: ctx.credentials,
        persistSetup: (patch) => scope?.update(patch) ?? Promise.resolve(),
        onAuthCompleted: control.runtime
          ? async () => {
              try {
                await control.runtime!.restart('dingtalk', effectiveConfig.accountId);
              } catch (error) {
                // Provider authorization is complete even if adapter startup
                // needs attention; keep the public auth session terminal and
                // expose the startup failure through runtime status.
                ctx.logger('channel-dingtalk').error(
                  'dingtalk credentials saved but runtime restart failed',
                  error,
                );
              }
            }
          : undefined,
      }),
    );
    return;
  }

  // --- Legacy standalone mount (channel-control absent).
  const credentialsCtx = ctx as Context & { credentials: (typeof ctx.credentials) };
  ctx.effect(async () => {
    // SDK mode requires a resolved credential; gateway mode owns its own.
    let clientSecret: string | undefined;
    if (config.upstream.mode === 'sdk') {
      const resolved = await credentialsCtx.credentials.resolve(credentialRef(ref));
      clientSecret = resolved?.value;
      if (!clientSecret) {
        ctx.logger('channel-dingtalk').warn(
          `dingtalk upstream mode "sdk" credential "${ref}" is not configured; not mounting`,
        );
        return () => {};
      }
    }

    mountChannelAdapter(
      ctx,
      new DingTalkAdapter(config, clientSecret ? { ...deps, clientSecret } : deps),
      (signal) => ctx.channels.createAdapterContext({ channelId: 'dingtalk', signal }),
    );
    // The mount owns the adapter lifecycle; this outer effect only scopes the
    // async credential resolution, so its disposer is a no-op.
    return () => {};
  });
}
