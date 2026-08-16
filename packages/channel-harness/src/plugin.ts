/**
 * Cordis plugin entry for the channel-harness bridge (doc §30 / H0.6).
 *
 * The plugin injects `channels` (ChannelService), `agents` (AgentRegistry),
 * `agentDefaultModel`, `llm`, and `commands` (CommandRuntime). `sessionPersistence` is
 * NOT required: it is an optional capability resolved at the use site and
 * passed into the gateway, so `canResume()` reflects whether the service is
 * present. `commands` is a required capability (no optional fallback) so the
 * bridge can install Agent-scoped channel commands.
 *
 * The whole bridge lifecycle is registered as one `ctx.effect` whose disposer
 * is the teardown chain from `startBridge`.
 */
import { type Context } from '@deepseek-ai/cordis';
import type { Config } from './config.js';
import { startBridge } from './lifecycle.js';

export const name = 'channel-harness';

// `agentDefaultModel` is the Harness default-model service: an agent created
// without an explicit provider/model (the channel `agent.default` route) must
// inherit the user's Harness-wide default model so the `{{model}}` persona
// variable always resolves. See `resolveRoute` in agent-manager.ts.
export const inject: string[] = ['channels', 'agents', 'agentDefaultModel', 'llm', 'commands'];

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    // Optional service resolved at the use site (never required).
    const persistence = ctx.get('sessionPersistence');
    const lifecycle = startBridge(ctx, config, persistence);
    return () => lifecycle.dispose();
  });
}
