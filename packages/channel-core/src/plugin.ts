/**
 * Cordis plugin entry for the ChannelService.
 *
 * Instantiating the service inside a plugin fiber registers it at
 * `ctx.channels` and removes it automatically when the fiber unloads.
 */
import { type Context } from '@deepseek-ai/cordis';
import { ChannelService } from './service.js';

export const name = 'channel-core';

export function apply(ctx: Context) {
  // Construction registers `ctx.channels` for the current fiber.
  const service = new ChannelService(ctx);
  void service;
}
