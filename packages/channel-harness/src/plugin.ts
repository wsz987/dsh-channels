/**
 * Cordis plugin entry for the channel-harness bridge (doc §30 / H0.6).
 *
 * The plugin injects `channels` (ChannelService), `agents` (AgentRegistry),
 * `agentDefaultModel`, `agentPresets`, `llm`, and `commands` (CommandRuntime).
 * `sessionPersistence` and the question transports are
 * NOT required: they are optional capabilities resolved LIVE at the use site
 * (a resolver passed into the gateway), so probes reflect whether the service
 * is present at probe time — including mounts/unmounts after startup.
 * `commands` is a required capability (no optional fallback) so the bridge can
 * install Agent-scoped channel commands.
 *
 * `apiProxy` is deliberately absent from `inject` (plan §5 / §21 P0-3): the
 * Web profile mounts it (questions then ride the official ApiProxy mux), but
 * headless deployments do not, and the channel-harness must still start there
 * — its question backend probes `apiProxy` once at startup and otherwise
 * registers the official UserQuestionProvider through `ctx.userQuestions`.
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
export const inject: string[] = [
  'channels',
  'agents',
  'agentDefaultModel',
  'agentPresets',
  'llm',
  'commands',
];

export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    // Optional service resolved LIVE at the use site (never required): the
    // resolver is re-queried on every probe, so a sessionPersistence mounted,
    // unmounted, or replaced AFTER the bridge started is observed on the next
    // `canResume()` / existence probe (no startup snapshot).
    const lifecycle = startBridge(ctx, config, () => ctx.get('sessionPersistence'));
    return () => lifecycle.dispose();
  });
}
