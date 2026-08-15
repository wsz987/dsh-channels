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
): Promise<void> {
  const fiber = agentCtx.inject(['commands'], function* channelCommands(ctx) {
    for (const factory of commandFactories) {
      yield ctx.commands.register(factory(deps));
    }
  });
  return fiber.await().then(() => undefined);
}
