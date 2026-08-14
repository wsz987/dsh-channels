/**
 * Cordis plugin entry for the channel-harness bridge.
 *
 * The plugin injects `channels` (ChannelService from `@dsh/channel-core`),
 * `agents` (AgentRegistry from `@deepseek-ai/dsh-agent`) and
 * `sessionPersistence` (SessionPersistence from
 * `@deepseek-ai/dsh-session-persistence`), so it only starts once all three
 * services are available. Without `sessionPersistence` the plugin stays
 * PENDING (v1.1 §31) rather than running a half-persisting channel runtime.
 * The whole bridge lifecycle is registered as one `ctx.effect` whose disposer
 * is the teardown chain from `startBridge`.
 */
import { type Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';
import { startBridge } from './lifecycle.js';

export const name = 'channel-harness';

export const inject: string[] = ['channels', 'agents', 'sessionPersistence'];

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    const lifecycle = startBridge(ctx, config);
    return () => lifecycle.dispose();
  });
}
