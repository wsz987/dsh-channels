/**
 * @wsz987/channel-telegram — Telegram Bot API channel adapter for DeepSeek
 * Harness.
 *
 * A fifth official channel built on the same Channel Contract as Weixin / QQ /
 * DingTalk / Lark. The Bot API token is resolved through `ctx.credentials`
 * (`tokenRef`, default `TELEGRAM_BOT_TOKEN`) — the secret value never lives in
 * profile config, logs, or fixtures.
 *
 * Lifecycle: when the Channel Control Plane (`ctx.channelControl`) is present,
 * apply() registers a `ChannelDefinition` ('telegram'); the control plane
 * decides when to instantiate/mount the adapter (headless auto-start). When it
 * is absent (standalone / older harness), apply() falls back to resolving the
 * token credential and mounting directly — never throwing when the channel is
 * merely unconfigured.
 *
 * Streaming is `edit`: one message is sent and then edited in place with
 * `editMessageText` as full-text previews arrive. Set
 * `config.streaming.enabled: false` to force the buffered send-once strategy.
 */
import { type Context } from '@deepseek-ai/cordis';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { settingsNamespace, type SettingsProvider } from '@deepseek-ai/dsh-settings';
import { mountChannelAdapter } from '@wsz987/channel-core';
import type { ChannelDefinition } from '@wsz987/channel-control';
import type { TelegramConfig } from './config.js';
import { Config, TELEGRAM_BOT_TOKEN_REF } from './config.js';
import { TelegramAdapter, type TelegramAdapterDeps } from './adapter.js';
import { createTelegramDefinition, type TelegramCredentialSeam } from './definition.js';

export const name = 'channel-telegram';
export const inject: string[] = ['channels', 'credentials'];

export { Config, TELEGRAM_BOT_TOKEN_REF };
export { TelegramAdapter, type TelegramAdapterDeps } from './adapter.js';
export { createTelegramDefinition, type TelegramCredentialSeam } from './definition.js';
export { InboundProcessor } from './inbound.js';
export { hydrateTelegramParts, type TelegramFileResolver, type TelegramMediaHydratorOptions } from './media-hydrator.js';
export { OutboundSender } from './outbound.js';
export { TelegramStreamingReply } from './streaming-reply.js';
export {
  HttpTelegramUpstream,
  type TelegramUpstream,
  type TelegramBotUser,
  type TelegramMedia,
  type TelegramSendOptions,
  type TelegramSentMessage,
  type TelegramFileInfo,
  type TelegramDownloadedFile,
} from './upstream.js';
export {
  FetchTransport,
  type HttpTransport,
  type HttpRequestInit,
  type HttpBinaryResponse,
} from './transport.js';
export { mapInbound, dedupKey, simpleHash, type TelegramInboundMeta } from './mapper.js';
export { manifest, type TelegramManifest } from './manifest.js';

/**
 * Host credential seam. The host's `ctx.credentials` accepts branded
 * credential references created with `credentialRef()`; the brand is applied
 * at the boundary so the definition stays host-agnostic and offline-testable.
 */
interface HostCredentialSeam {
  resolve(ref: unknown): Promise<{ value: string; source: string } | undefined>;
  describe(ref: unknown): Promise<{ configured: boolean; source?: string; writable: boolean }>;
  set(ref: unknown, value: string): Promise<void>;
}

/** Cordis Context with the credentials seam provided by the host. */
type ContextWithCredentials = Context & { credentials: HostCredentialSeam };

/**
 * One-time legacy plaintext `config.token` -> credential reference migration.
 * The value is written to the credentials seam once, then the plaintext is
 * stripped from the in-memory config. The secret value is never logged.
 */
function migrateLegacyToken(ctx: ContextWithCredentials, config: TelegramConfig): void {
  const legacy = config.token;
  if (typeof legacy !== 'string' || legacy.length === 0) return;
  const ref = config.tokenRef ?? TELEGRAM_BOT_TOKEN_REF;
  void ctx.credentials
    .set(credentialRef(ref), legacy)
    .then(() => {
      ctx.logger('channel-telegram').info(`[channel-telegram] legacy plaintext token migrated into credentials ref "${ref}"`);
    })
    .catch((error) => {
      ctx.logger('channel-telegram').warn('[channel-telegram] legacy plaintext token migration failed', error);
    });
  delete (config as { token?: string }).token;
}

export function apply(ctx: Context, config: TelegramConfig, deps: TelegramAdapterDeps = {}): void {
  if (!config.enabled) return;

  const credentialsCtx = ctx as ContextWithCredentials;
  migrateLegacyToken(credentialsCtx, config);
  const ref = config.tokenRef ?? TELEGRAM_BOT_TOKEN_REF;

  const control = ctx.get('channelControl') as
    | { definitions: { register(def: ChannelDefinition): unknown } }
    | undefined;

  if (control) {
    // Control plane present (doc §25/§27): register the definition; the plane
    // owns adapter instantiation + headless auto-start.
    const settings = ctx.get('settings') as SettingsProvider | undefined;
    const scope = settings?.register(settingsNamespace('channels-telegram'), Config, { base: config });
    const effectiveConfig = scope?.get() ?? config;
    control.definitions.register(
      createTelegramDefinition({
        config: effectiveConfig,
        deps,
        credentials: {
          resolve: (name) => credentialsCtx.credentials.resolve(credentialRef(name)),
          describe: (name) => credentialsCtx.credentials.describe(credentialRef(name)),
          set: (name, value) => credentialsCtx.credentials.set(credentialRef(name), value),
        },
      }),
    );
    return;
  }

  // Legacy fallback (standalone, no control plane): mount directly. Unconfigured
  // token must NOT throw (doc §25) — log a warning and stay idle.
  ctx.effect(async () => {
    const token = deps.token ?? (await credentialsCtx.credentials.resolve(credentialRef(ref)))?.value;
    if (!token) {
      ctx.logger('channel-telegram').warn(
        `[channel-telegram] telegram credential "${ref}" is not configured; adapter not mounted`,
      );
      return () => {};
    }

    mountChannelAdapter(
      ctx,
      new TelegramAdapter(config, { ...deps, token }),
      (signal) => ctx.channels.createAdapterContext({ channelId: 'telegram', signal }),
    );
    // The mount owns the adapter lifecycle; this outer effect only scopes the
    // async credential resolution, so its disposer is a no-op.
    return () => {};
  });
}
