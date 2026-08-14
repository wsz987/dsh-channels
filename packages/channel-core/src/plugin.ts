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
 *   2. DSH_HOME + '/channels'       (Harness home convention)
 *   3. './data/channels'            (cwd fallback)
 */
import { type Context } from '@deepseek-ai/cordis';
import { env } from 'node:process';
import { join, resolve } from 'node:path';
import { ChannelService, type ChannelServiceOptions } from './service.js';
import { FileStorage } from './file-storage.js';
import { FileSecretStore } from './file-secret-store.js';

export const name = 'channel-core';

function resolveDataDirectory(): string {
  if (env.DSH_CHANNELS_DATA_DIR) return resolve(env.DSH_CHANNELS_DATA_DIR);
  if (env.DSH_HOME) return join(resolve(env.DSH_HOME), 'channels');
  return resolve('data', 'channels');
}

function resolveServiceOptions(): ChannelServiceOptions {
  const dir = resolveDataDirectory();
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
