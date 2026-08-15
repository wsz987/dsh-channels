/**
 * @wsz987/channel-lark — Lark / Feishu channel adapter for DeepSeek Harness.
 *
 * Maps the Lark platform to the stable Channel Contract. Two upstream
 * drivers implement `LarkUpstream` behind `config.upstream.mode`:
 * - 'sdk'     — inbound via the official `@larksuiteoapi/node-sdk`
 *   (WebSocket long-connection, `im.message.receive_v1`) AND outbound via the
 *   official OpenAPI client. The AppId is a plain config string
 *   (`upstream.appId`); the AppSecret is resolved via `ctx.credentials`
 *   (`DSH_CHANNEL_LARK_MAIN_APP_SECRET`) — only the reference name ever lives
 *   in config. The secret value is never logged.
 * - 'gateway' — self-hosted HTTP gateway long-poll driver (legacy).
 *
 * Lifecycle: when the Channel Control Plane (`ctx.channelControl`) is present,
 * apply() performs a one-time migration of any legacy plaintext AppSecret into
 * ctx.credentials, then registers a `ChannelDefinition` ('lark'); the control
 * plane decides when to instantiate/mount the adapter (headless auto-start,
 * doc §27). When it is absent (standalone / older harness), apply() falls back
 * to resolving SDK credentials and mounting directly — never throwing when a
 * channel is merely unconfigured (doc §25).
 *
 * Streaming is `edit` (editable card): create card → update with content →
 * finalize → failure card. Threads are preserved (`conversation.threadId`)
 * so Harness sessions isolate per thread. Auth is connection-state driven —
 * the driver owns platform credentials (never logged).
 */
import { type Context } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
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
export { LarkAdapter, resolveDomain, type LarkAdapterDeps } from './adapter.js';
export { LarkCardReply, type LarkCardStatus, type LarkCardUpdate } from './card.js';
export { InboundProcessor } from './inbound.js';
export { OutboundSender } from './outbound.js';
export { HttpLarkUpstream, type LarkOutbound, type LarkUpstream } from './upstream.js';
export {
  LarkOpenApiOutbound,
  receiveIdType,
  cardContent,
  type LarkOpenApiClient,
  type LarkOpenApiOutboundOptions,
  type LarkCreateMessagePayload,
  type LarkCreateMessageResult,
  type LarkReceiveIdType,
  type LarkPatchMessagePayload,
  type LarkCreateImagePayload,
  type LarkCreateImageResult,
  type LarkApiResponse,
} from './openapi-outbound.js';
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

/**
 * One-time migration (doc §52 Task 5): promote a legacy plaintext
 * `config.upstream.appSecret` into ctx.credentials under `appSecretRef`, then
 * strip the plaintext from config. Returns true when a migration occurred.
 * The secret value is never logged.
 */
async function migrateLegacyAppSecret(
  ctx: Context,
  config: LarkConfig,
): Promise<boolean> {
  const legacy = config.upstream.appSecret;
  if (typeof legacy !== 'string' || legacy.length === 0) return false;
  const ref = config.upstream.appSecretRef ?? LARK_APP_SECRET_REF;
  await ctx.credentials.set(credentialRef(ref), legacy);
  // Mutate config to remove the migrated plaintext (documented migration-only).
  delete (config.upstream as { appSecret?: string }).appSecret;
  ctx.logger('channel-lark').info(
    `[channel-lark] legacy plaintext appSecret migrated into credentials ref "${ref}"`,
  );
  return true;
}

export function apply(ctx: Context, config: LarkConfig, deps: LarkAdapterDeps = {}): void {
  if (!config.enabled) return;

  // Adapt the CredentialProvider to the structural seam expected by the
  // definition (credentialRef branding is applied here, once).
  const seam = {
    resolve: (ref: string) => ctx.credentials.resolve(credentialRef(ref)),
    describe: (ref: string) => ctx.credentials.describe(credentialRef(ref)),
    set: (ref: string, value: string) => ctx.credentials.set(credentialRef(ref), value),
  };

  // One-time legacy plaintext AppSecret → credentials migration.
  void migrateLegacyAppSecret(ctx, config).then((migrated) => {
    if (migrated) ctx.logger('channel-lark').info('[channel-lark] legacy appSecret migrated (config plaintext removed)');
  }).catch((error) => {
    ctx.logger('channel-lark').warn('[channel-lark] legacy appSecret migration failed', error);
  });

  const control = ctx.get('channelControl') as
    | { definitions: { register(d: ChannelDefinition): unknown } }
    | undefined;

  if (control) {
    // Control plane present (doc §12/§26/§27): register the definition; the
    // plane owns adapter instantiation + headless auto-start.
    control.definitions.register(createLarkDefinition({ config, deps, credentials: seam }));
    return;
  }

  // Legacy fallback (standalone, no control plane): mount directly. Unconfigured
  // SDK mode must NOT throw (doc §25) — log a warning and stay idle.
  ctx.effect(async () => {
    let appId: string | undefined;
    let appSecret: string | undefined;
    if (config.upstream.mode === 'sdk') {
      appId = config.upstream.appId;
      const appSecretRef = config.upstream.appSecretRef ?? LARK_APP_SECRET_REF;
      appSecret = (await ctx.credentials.resolve(credentialRef(appSecretRef)))?.value;
      if (!appId || !appSecret) {
        ctx.logger('channel-lark').warn(
          `[channel-lark] sdk mode not configured (missing appId or appSecret ref "${appSecretRef}"); adapter not mounted`,
        );
        return () => {};
      }
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
