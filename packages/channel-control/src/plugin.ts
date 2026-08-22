/**
 * Cordis plugin entry for @wsz987/channel-control (doc §12, §46).
 *
 * Instantiates the ChannelControlService, then auto-starts every configured
 * channel (headless support, doc §25/§27). autoStartAll is guarded so a single
 * misconfigured/broken channel can never crash profile activation. On fiber
 * unload the plugin stops and disposes every runtime mount.
 *
 * The access manager is wired over the shared, durable channel-domain storage
 * (`ctx.channels.resources.storage`) so policies written here and read by the
 * harness resolver share one KV namespace (plan §15). Owner identity resolution
 * delegates to each registered definition's optional `resolveOwnerIdentity`.
 */
import { type Context } from '@deepseek-ai/cordis';
import type { ChannelService } from '@wsz987/channel-core';
import { ChannelControlService } from './service.js';
import type { CredentialSeam } from './credentials/manager.js';
import { ChannelStorageAccessPolicyStore } from './access/policy-store.js';
import { Config, type Config as ChannelControlConfig } from './config.js';

export const name = 'channel-control';
export const inject: string[] = ['channels', 'credentials'];

export { Config };

export function apply(ctx: Context, config: ChannelControlConfig): void {
  const credentials = (ctx as Context & { credentials: CredentialSeam }).credentials;
  const channels = (ctx as Context & { channels: ChannelService }).channels;

  // The resolver closure references `service`; annotate it explicitly so the
  // self-reference resolves without circular-inference.
  let service: ChannelControlService;
  service = new ChannelControlService(ctx, {
    credentials,
    // Durable policy store over the same ChannelStorage the harness resolver reads.
    accessStore: new ChannelStorageAccessPolicyStore(() => channels.resources.storage),
    // Owner identity resolution delegates to the registered definition's hook.
    resolveOwnerIdentity: async (
      channelId: string,
      accountId: string,
    ): Promise<string | undefined> =>
      service.definitions.get(channelId)?.resolveOwnerIdentity?.(accountId),
    // Prompt-only bundle update check over the same durable channel storage.
    updateCheck: {
      enabled: config.updateCheck.enabled,
      intervalHours: config.updateCheck.intervalHours,
      storage: () => channels.resources.storage,
    },
  });

  // Fire-and-forget startup check (never blocks activation; offline-tolerant;
  // prompt-only — it never installs anything).
  void service.updates.trigger();

  // Headless auto-start: definitions registered BEFORE this plugin activates
  // are swept here; definitions registered afterwards (channel plugins
  // activate after channel-control) are auto-started by the service's
  // onRegister hook (doc §27). Unconfigured channels are skipped silently and
  // a failed start never crashes plugin activation.
  void (async () => {
    try {
      await service.runtime.autoStartAll();
    } catch (error) {
      ctx.logger('channel-control').error(
        '[channel-control] autoStartAll failed during activation',
        error,
      );
    }
  })();

  // On fiber unload, stop and dispose every mounted runtime adapter.
  ctx.effect(() => {
    return () => service.runtime.stopAll().catch(() => {});
  });

  // Owner-claim event listener (plan §22). observe() NEVER throws (it catches
  // and logs internally), but wrap it anyway so a failure can never propagate
  // back to the adapter inbound loop (which would treat the whole platform
  // message as failed). The disposer is returned through ctx.effect teardown.
  ctx.effect(() => {
    const off = channels.on((event) => {
      try {
        service.ownerClaims.observe(event);
      } catch (error) {
        ctx.logger('channel-control').warn(
          '[channel-control] owner claim observe failed',
          error,
        );
      }
    });
    return off;
  });
}
