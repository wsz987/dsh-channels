/**
 * Cordis plugin entry for the channel-harness bridge.
 *
 * The plugin injects `channels` (ChannelService from `@dsh/channel-core`) and
 * `agents` (AgentRegistry from `@deepseek-ai/dsh-agent`), so it only starts
 * once both services are available. The whole bridge lifecycle is registered
 * as one `ctx.effect` whose disposer is the teardown chain from
 * `startBridge`.
 */
import { type Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';
import { startBridge } from './lifecycle.js';

export const name = 'channel-harness';

export const inject: string[] = ['channels', 'agents'];

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    const lifecycle = startBridge(ctx, config);
    return () => lifecycle.dispose();
  });
}
