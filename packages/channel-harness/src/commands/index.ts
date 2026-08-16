/**
 * Channel command plane (plan §4 / §23).
 *
 * Composes the channel command factories and installs them into an Agent
 * scoped context via the official `@deepseek-ai/dsh-commands` registry —
 * there is no custom ChannelCommandRegistry / CommandMap here. Each factory
 * returns an official `CommandDefinition`; `installChannelCommands` registers
 * them with an `agentCtx.effect` so they share the Agent's disposal.
 *
 * The `deps` argument is the one bridge hook channel commands need (plan §16):
 * a pure, platform-agnostic way to mint a fresh session for the current
 * conversation.
 */
import { type Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createNewCommand } from './new.js';

/** Bridge-provided capabilities available to channel commands. */
export interface ChannelCommandDependencies {
  /** Start a brand-new Harness session for the current conversation. */
  startNewSession(agent: Agent): Promise<void>;
}

export type ChannelCommandDisposer = () => Promise<void>;

interface AgentCommandState {
  /** Serialize setup and disposal transitions for one live Agent scope. */
  queue: Promise<void>;
  owner?: symbol;
  disposer?: ChannelCommandDisposer;
}

// Agent scopes survive a bridge reload. Keep ownership outside AgentManager so
// a replacement manager can coordinate with the previous bridge instance.
const agentStates = new WeakMap<Context, AgentCommandState>();

const commandFactories = [
  createNewCommand,
];

/**
 * Install the channel commands on an Agent scoped context. Registrations live
 * for the life of that Agent scope and unwind together with it when the Agent
 * is disposed.
 */
export function installChannelCommands(
  agentCtx: Context,
  deps: ChannelCommandDependencies,
): Promise<ChannelCommandDisposer> {
  const state: AgentCommandState = agentStates.get(agentCtx) ?? { queue: Promise.resolve() };
  agentStates.set(agentCtx, state);
  const owner = Symbol('channel-harness-command-owner');

  const installed = enqueue(state, async () => {
    // A replacement bridge takes ownership before registering. This closes the
    // old fiber first, so CommandRuntime never sees two `new` registrations.
    const previous = state.disposer;
    state.owner = undefined;
    state.disposer = undefined;
    if (previous) await previous();

    const fiber = agentCtx.inject(['commands'], function* channelCommands(ctx) {
      for (const factory of commandFactories) {
        yield ctx.commands.register(factory(deps));
      }
    });
    try {
      await fiber.await();
    } catch (error) {
      await quiesceFiber(fiber);
      throw error;
    }

    let disposing: Promise<void> | undefined;
    state.owner = owner;
    state.disposer = () => disposing ??= quiesceFiber(fiber);
  });

  return installed.then(() => {
    let release: Promise<void> | undefined;
    return () => release ??= enqueue(state, async () => {
      // A late disposer from an older bridge must never remove the current
      // bridge's registration.
      if (state.owner !== owner) return;
      const disposer = state.disposer;
      state.owner = undefined;
      state.disposer = undefined;
      if (disposer) await disposer();
    });
  });
}

function enqueue(state: AgentCommandState, operation: () => Promise<void>): Promise<void> {
  const run = state.queue.then(operation);
  state.queue = run.catch(() => {});
  return run;
}

async function quiesceFiber(fiber: ReturnType<Context['plugin']>): Promise<void> {
  await Promise.resolve(fiber.dispose());
  while (fiber.inertia !== undefined) await fiber.inertia;
}
