import { Logger, type Context, type Exporter } from '@deepseek-ai/cordis';

export const CHANNELS_DEBUG_ENV = 'DSH_CHANNELS_DEBUG';

/**
 * Install an official Cordis exporter for local channel-harness diagnostics.
 * The Host's default exporter only keeps an in-memory buffer.
 */
export function installDebugConsoleExporter(ctx: Context): void {
  if (process.env[CHANNELS_DEBUG_ENV] !== '1') return;

  console.info(`[channel-harness] console diagnostics enabled (${CHANNELS_DEBUG_ENV}=1)`);

  const exporter: Exporter = {
    colors: false,
    // Surface harness + every channel adapter's logs (incl. the inbound
    // message info logs each adapter emits) to the console. Cordis levels:
    // ERROR=0 INFO=1 WARN=2 DEBUG=3 — threshold 3 shows everything.
    levels: {
      default: -1,
      'channel-harness': 3,
      'channel-weixin': 3,
      'channel-qq': 3,
      'channel-lark': 3,
      'channel-dingtalk': 3,
      'channel-telegram': 3,
    },
    export(message) {
      console[message.type](Logger.format(exporter, message));
    },
  };

  ctx.logger.exporter(exporter);
}
