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
    levels: {
      default: -1,
      'channel-harness': 3,
    },
    export(message) {
      console[message.type](Logger.format(exporter, message));
    },
  };

  ctx.logger.exporter(exporter);
}
