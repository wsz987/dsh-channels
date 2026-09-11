/**
 * @wsz987/channel-lark — Lark / Feishu channel adapter for DeepSeek Harness.
 *
 * Maps the Lark platform to the stable Channel Contract. The upstream is the
 * OFFICIAL `@larksuiteoapi/node-sdk` only:
 * - inbound — WSClient + EventDispatcher (`im.message.receive_v1` +
 *   `card.action.trigger`);
 * - outbound — the official OpenAPI client (`im.v1.message.create` / `patch`,
 *   media uploads, CardKit 2.0 card entities and native streaming).
 * The AppId is a plain config string (`upstream.appId`); the AppSecret is
 * resolved via `ctx.credentials` (`DSH_CHANNEL_LARK_MAIN_APP_SECRET`) — only
 * the reference name ever lives in config. The secret value is never logged.
 * There is no self-hosted gateway mode, transport injection, plaintext secret
 * field, or runtime migration path.
 *
 * Lifecycle: when the Channel Control Plane (`ctx.channelControl`) is present,
 * apply() registers a `ChannelDefinition` ('lark'); the control plane decides
 * when to instantiate/mount the adapter (headless auto-start). When it is
 * absent (standalone / older harness), apply() falls back to resolving SDK
 * credentials and mounting directly — never throwing when a channel is merely
 * unconfigured.
 *
 * Streaming is `edit` (CardKit 2.0 native streaming card): create card entity
 * → send card reference → stream element content → close streaming at end.
 * Threads are preserved (`conversation.threadId`) so Harness sessions isolate
 * per thread. Auth is connection-state driven — the driver owns platform
 * credentials (never logged).
 */
import { type Context } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import type { SettingsProvider } from '@deepseek-ai/dsh-settings';
import { mountChannelAdapter } from '@wsz987/channel-core';
import type { ChannelDefinition } from '@wsz987/channel-control';
import type { LarkConfig } from './config.js';
import { Config, LARK_APP_SECRET_REF } from './config.js';
import { LarkAdapter, type LarkAdapterDeps } from './adapter.js';
import { createLarkDefinition } from './definition.js';

export const name = 'channel-lark';
export const inject: string[] = ['channels', 'credentials'];

export { Config, LARK_APP_SECRET_REF };
export { createLarkDefinition, type LarkCredentialSeam, type CreateLarkDefinitionOptions } from './definition.js';
export {
  beginLarkDeviceAuthorization,
  pollLarkDeviceAuthorization,
  type LarkDeviceAuthorizationOptions,
} from './auth/device-authorization.js';
export { LarkAdapter, resolveDomain, type LarkAdapterDeps } from './adapter.js';
export { LarkCardReply, truncateSummary, splitForRollover, type LarkCardStatus, type LarkCardUpdate } from './card.js';
export { InboundProcessor } from './inbound.js';
export { OutboundSender } from './outbound.js';
export {
  type LarkOutbound,
  type LarkUpstream,
  type LarkFileRef,
  type LarkMediaRef,
  type LarkStreamingCardRef,
} from './upstream.js';
export {
  LarkOpenApiOutbound,
  receiveIdType,
  cardContent,
  interactiveCardContent,
  streamingCardJson,
  STREAM_MARKDOWN_ELEMENT_ID,
  type LarkOpenApiClient,
  type LarkOpenApiOutboundOptions,
  type LarkCreateMessagePayload,
  type LarkCreateMessageResult,
  type LarkReceiveIdType,
  type LarkPatchMessagePayload,
  type LarkCreateImagePayload,
  type LarkCreateImageResult,
  fileTypeFromName,
  type LarkFileType,
  type LarkCreateFilePayload,
  type LarkCreateFileResult,
  type LarkApiResponse,
  type LarkCardkitCardCreatePayload,
  type LarkCardkitCardCreateResult,
  type LarkCardElementContentPayload,
  type LarkCardSettingsPayload,
} from './openapi-outbound.js';
export {
  LarkSdkUpstream,
  mapSdkMessageEvent,
  mapSdkCardAction,
  MESSAGE_EVENT_KEY,
  CARD_ACTION_EVENT_KEY,
  type LarkSdkClient,
  type LarkSdkDispatcher,
  type LarkSdkUpstreamOptions,
  type LarkMessageEventData,
} from './lark-sdk-upstream.js';
export {
  LarkOpenApiMediaPort,
  type LarkMediaClient,
  type LarkMediaPort,
  type LarkMediaPortOptions,
  type LarkResourceType,
  type LarkMessageResourceGetPayload,
  type LarkMessageResourceResult,
  type LarkImageGetPayload,
  type LarkImageCreatePayload,
  type LarkImageCreateResult,
  type LarkFileCreatePayload,
  type LarkFileCreateResult,
} from './upstream/media-port.js';
export {
  MediaHydrator,
  ImageHydrator,
  classifyIngressFailure,
  type MediaHydratorOptions,
  type ImageHydratorOptions,
} from './media-hydrator.js';
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
  // Adapt the CredentialProvider to the structural seam expected by the
  // definition (credentialRef branding is applied here, once).
  const seam = {
    resolve: (ref: string) => ctx.credentials.resolve(credentialRef(ref)),
    describe: (ref: string) => ctx.credentials.describe(credentialRef(ref)),
    set: (ref: string, value: string) => ctx.credentials.set(credentialRef(ref), value),
  };

  const control = ctx.get('channelControl') as
    | { definitions: { register(d: ChannelDefinition): unknown } }
    | undefined;

  if (control) {
    // Control plane present: register the definition EVEN when disabled — the
    // plane owns adapter instantiation + headless auto-start, and a disabled
    // definition must stay visible so the Web control plane can re-enable it
    // later.
    const settings = ctx.get('settings') as SettingsProvider | undefined;
    const scope = settings?.register('channels-lark', Config, { base: config });
    control.definitions.register(
      createLarkDefinition({
        config: scope?.get() ?? config,
        deps,
        credentials: seam,
        persistSetup: (patch) => scope?.update(patch) ?? Promise.resolve(),
        persistEnabled: (enabled) => scope?.update({ enabled }) ?? Promise.resolve(),
      }),
    );
    return;
  }

  // Legacy fallback (standalone, no control plane): mount directly. An
  // unconfigured adapter must NOT throw — log a warning and stay idle. In this
  // mode there is no directory/control surface, so the config `enabled` gate
  // still applies.
  if (!config.enabled) return;

  ctx.effect(async () => {
    const appId = config.upstream.appId;
    const appSecretRef = config.upstream.appSecretRef ?? LARK_APP_SECRET_REF;
    const appSecret = (await ctx.credentials.resolve(credentialRef(appSecretRef)))?.value;
    if (!appId || !appSecret) {
      ctx.logger('channel-lark').warn(
        `[channel-lark] not configured (missing appId or appSecret ref "${appSecretRef}"); adapter not mounted`,
      );
      return () => {};
    }

    const adapter = new LarkAdapter(config, { ...deps, appId, appSecret });
    mountChannelAdapter(
      ctx,
      adapter,
      (signal) => ctx.channels.createAdapterContext({ channelId: 'lark', signal }),
    );
    // The mount owns the adapter lifecycle; this outer effect only scopes the
    // async credential resolution, so its disposer is a no-op.
    return () => {};
  });
}
