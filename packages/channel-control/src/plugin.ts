/**
 * Cordis plugin entry for @wsz987/channel-control (doc §12, §46).
 *
 * Instantiates the ChannelControlService, then auto-starts every configured
 * channel (headless support, doc §25/§27). autoStartAll is guarded so a single
 * misconfigured/broken channel can never crash profile activation. On fiber
 * unload the plugin stops and disposes every runtime mount.
 */
import { type Context } from '@deepseek-ai/cordis';
import { ChannelControlService } from './service.js';
import type { CredentialSeam } from './credentials/manager.js';

export const name = 'channel-control';
export const inject: string[] = ['channels', 'credentials'];

export function apply(ctx: Context): void {
  const credentials = (ctx as Context & { credentials: CredentialSeam }).credentials;
  const service = new ChannelControlService(ctx, { credentials });

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
}
