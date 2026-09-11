/**
 * Thin channel adapter for Harness model selection.
 *
 * Harness owns the default model and the Web Host owns the session RPC. The
 * channel only bridges `/model` to those official surfaces. In headless mode
 * it uses the official Agent-scoped `ModelSelectionRef` required to affect the
 * current Session. There is no per-Agent owner pin, host identity cache,
 * first-turn prepare, or fallback state machine.
 *
 * Host transport: the official `ctx.sessionController`
 * (`@deepseek-ai/dsh-api-session-controller`), which the Web profile mounts as
 * the session business API. Selection goes through
 * `sessionController.selectModel()`; the current-selection read is a
 * best-effort local chain (a Web-side selection that is pending but not yet
 * used by a request is not visible here — the official controller does not
 * expose a host-side current-selection read).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model';
import type { SessionController } from '@deepseek-ai/dsh-api-session-controller';

export type ChannelModelSelectionRef = ModelSelectionRef;
export type ChannelModelSelectionMode = 'host' | 'local';

/**
 * Narrow channel view over the official Host session business API — only the
 * model surface this bridge consumes, derived from
 * `@deepseek-ai/dsh-api-session-controller` instead of a local duplicate.
 */
export type ChannelHostSessionController = Pick<SessionController, 'selectModel'>;

export class ChannelModelSelectionController {
  private readonly refs = new WeakMap<Context, ChannelModelSelectionRef>();
  /**
   * The owner strategy is fixed when the Agent scope is installed. The Host
   * service itself is resolved live so HMR can replace its implementation
   * without changing ownership of an existing Agent.
   */
  private readonly strategies = new WeakMap<Context, ChannelModelSelectionMode>();

  constructor(private readonly rootCtx: Context) {}

  get mode(): ChannelModelSelectionMode {
    return this.hostSessionController() ? 'host' : 'local';
  }

  /** Install only the headless hook; Web Host owns it when sessionController is present. */
  install(agentCtx: Context): () => void {
    const strategy = this.mode;
    this.strategies.set(agentCtx, strategy);
    if (strategy === 'host') {
      return () => {
        if (this.strategies.get(agentCtx) === strategy) this.strategies.delete(agentCtx);
      };
    }
    const ref: ChannelModelSelectionRef = { current: undefined, assembled: undefined };
    const dispose = installModelSelection(agentCtx, ref);
    this.refs.set(agentCtx, ref);
    return () => {
      dispose();
      if (this.refs.get(agentCtx) === ref) this.refs.delete(agentCtx);
      if (this.strategies.get(agentCtx) === strategy) this.strategies.delete(agentCtx);
    };
  }

  async current(agent: Agent): Promise<ModelSelection | undefined> {
    return this.readLocal(agent);
  }

  async selectionForStep(agent: Agent): Promise<ModelSelection | undefined> {
    if (this.strategyFor(agent) === 'local') {
      const ref = this.refs.get(agent.ctx);
      if (ref?.assembled) return ref.assembled;
    }
    return this.current(agent);
  }

  async select(agent: Agent, selection: ModelSelection): Promise<void> {
    if (this.strategyFor(agent) === 'host') {
      const controller = this.hostSessionController();
      if (!controller) {
        throw new Error('host model selection is unavailable: sessionController is not mounted');
      }
      try {
        await controller.selectModel({
          sessionId: agent.id,
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: String(selection.reasoningEffort) } : {}),
        });
      } catch (error) {
        throw new Error(
          `model selection was rejected: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }

    const ref = this.refs.get(agent.ctx);
    if (!ref) throw new Error(`model selection is not installed for session '${String(agent.id)}'`);
    ref.current = selection;
    try {
      await (this.rootCtx.get('agentDefaultModel') as AgentDefaultModelConfig | undefined)?.saveSelection(selection);
    } catch {
      // The current-session switch already holds; default persistence is best effort.
    }
  }

  private hostSessionController(): ChannelHostSessionController | undefined {
    return this.rootCtx.get('sessionController') as ChannelHostSessionController | undefined;
  }

  /**
   * Agents configured through the bridge always have a recorded strategy.
   * Keep the deployment-wide mode as a compatibility fallback for direct
   * controller callers that have not installed the Agent-scoped hook.
   */
  private strategyFor(agent: Agent): ChannelModelSelectionMode {
    return this.strategies.get(agent.ctx) ?? this.mode;
  }

  private readLocal(agent: Agent): ModelSelection | undefined {
    const picked = this.refs.get(agent.ctx)?.current;
    if (picked) return picked;
    const headerConfig = agent.session.requestHeader?.()?.config;
    if (headerConfig?.provider && headerConfig.model) {
      return {
        provider: headerConfig.provider,
        model: headerConfig.model,
        ...(headerConfig.reasoningEffort ? { reasoningEffort: ReasoningEffortId(String(headerConfig.reasoningEffort)) } : {}),
      };
    }
    const { provider, model } = agent.options;
    if (provider && model) return { provider, model };
    const defaults = (agent.ctx.get('agentDefaultModel') as AgentDefaultModelConfig | undefined)?.currentSelection();
    if (!defaults?.provider || !defaults.model) return undefined;
    return {
      provider: defaults.provider,
      model: defaults.model,
      ...(defaults.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
    };
  }
}
