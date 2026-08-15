/**
 * Cordis plugin entry for the ChannelService.
 *
 * Instantiating the service inside a plugin fiber registers it at
 * ctx.channels and removes it automatically when the fiber unloads.
 *
 * The service is wired with durable runtime resources (file-backed secrets +
 * storage) unless explicitly disabled; adapters read them from
 * ctx.channels.resources instead of instantiating their own stores.
 *
 * Data directory resolution order:
 *   1. DSH_CHANNELS_DATA_DIR        (explicit override)
 *   2. <Harness home>/dsh-channels  ($DSH_HOME, else ~/.dsh)
 */
import { type Context } from '@deepseek-ai/cordis';
import { join } from 'node:path';
import { ChannelService, type ChannelServiceOptions } from './service.js';
import { FileStorage } from './file-storage.js';
import { FileSecretStore } from './file-secret-store.js';
import { resolveChannelDataDirectory } from './paths.js';

export const name = 'channel-core';

function resolveServiceOptions(): ChannelServiceOptions {
  const dir = resolveChannelDataDirectory();
  return {
    resources: {
      secrets: new FileSecretStore({ directory: join(dir, 'secrets') }),
      storage: new FileStorage({ directory: join(dir, 'storage') }),
    },
  };
}

export function apply(ctx: Context) {
  // Construction registers 'ctx.channels' for the current fiber.
  const service = new ChannelService(ctx, resolveServiceOptions());
  void service;
}
