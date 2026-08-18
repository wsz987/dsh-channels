/**
 * Channel command plane (plan §4 / §23, spec §35).
 *
 * Composes the channel command factories and installs them into an Agent
 * scoped context via the official `@deepseek-ai/dsh-commands` registry —
 * there is no custom ChannelCommandRegistry / CommandMap here. Each factory
 * returns an official `CommandDefinition`; `installChannelCommands` mounts a
 * command-injected child plugin under the Agent's exact context. Channel
 * commands register in the AGENT scope, so they shadow same-named globals and
 * a same-scope duplicate throws (no custom priority/reserved-name system —
 * spec §11/§43).
 *
 * The `deps` argument is the bridge hook surface channel commands need —
 * every capability a handler uses arrives as a NARROW injected function or
 * object, mirroring `/new`'s `startNewSession`. Handlers must NEVER read
 * Harness services through `invocation.agent.ctx` (the agent-loop scoped
 * context does not inject `commands` / `llm` — Cordis throws "without
 * inject"); the bridge lazily bridges them through `deps` instead, exactly
 * like the official compact/goal/plan commands close over their plugin ctx.
 */
import { type Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { CommandDefinition, CommandDescriptor } from '@deepseek-ai/dsh-commands';
import type { LlmCallConfig, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import { createNewCommand } from './new.js';
import { createStopCommand } from './stop.js';
import { createHelpCommand } from './help.js';
import { createStatusCommand } from './status.js';
import { createModelsCommand } from './models.js';
import { createModelCommand } from './model.js';
import type { ChannelModelSelectionController } from '../model-selection.js';

/**
 * Narrow LLM seam handed to model commands (discovery + exact resolution).
 * Structural subset of `ctx.llm` (`LlmRuntime`); the bridge bridges it lazily
 * so handlers never touch the agent scoped context.
 */
export interface ChannelModelCatalog {
  /** Registered provider routes (display metadata). */
  listProviders(): LlmProviderInfo[];
  /** Advisory model catalog for one provider (never request validation). */
  listModels(provider: string): Promise<LlmModelInfo[]>;
  /** Exact model metadata resolution, independent of the advisory catalog. */
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  /** Validate a call config (incl. reasoning effort) against the exact model. */
  resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>;
}

/** Bridge-provided capabilities available to channel commands. */
export interface ChannelCommandDependencies {
  /** Start a brand-new Harness session for the current conversation. */
  startNewSession(agent: Agent): Promise<void>;
  /**
   * Per-agent model selection with exactly ONE backend per deployment (host
   * RPC when a Web Host is mounted, a local ref otherwise), backing /status
   * and /model. `select` also persists the switch as the Harness-wide
   * default through the owning backend.
   */
  modelSelection: ChannelModelSelectionController;
  /** Effective command view for an agent (global + agent-scope shadow). */
  listCommands(agent: Agent): readonly CommandDescriptor[];
  /** Resolve one effective command definition (scoped shadow or global). */
  findCommand(agent: Agent, name: string): CommandDefinition | undefined;
  /** Harness LLM catalog seam (discovery + exact resolution), bridged lazily. */
  llm: ChannelModelCatalog;
}

export type ChannelCommandDisposer = () => Promise<void>;

const commandFactories = [
  createStopCommand,
  createNewCommand,
  createHelpCommand,
  createStatusCommand,
  createModelsCommand,
  createModelCommand,
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
  const fiber = agentCtx.inject(['commands'], function* channelCommands(ctx) {
    for (const factory of commandFactories) {
      yield ctx.commands.register(factory(deps));
    }
  });
  return fiber.await().then(() => {
    let disposing: Promise<void> | undefined;
    return () => disposing ??= quiesceFiber(fiber);
  });
}

async function quiesceFiber(fiber: ReturnType<Context['plugin']>): Promise<void> {
  await Promise.resolve(fiber.dispose());
  while (fiber.inertia !== undefined) await fiber.inertia;
}