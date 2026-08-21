/**
 * Thin channel adapter for Harness model selection.
 *
 * Harness owns the default model and the Web Host owns the session RPC. The
 * channel only bridges `/model` to those official surfaces. In headless mode
 * it uses the official Agent-scoped `ModelSelectionRef` required to affect the
 * current Session. There is no per-Agent owner pin, apiProxy identity cache,
 * first-turn prepare, or fallback state machine.
 */
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model';
import {
  RpcId,
  type ApiProxy,
} from '@deepseek-ai/dsh-host-apiproxy/api';

export type ChannelModelSelectionRef = ModelSelectionRef;
export type ChannelModelSelectionMode = 'host' | 'local';

/**
 * Narrow channel view over the official Host ApiProxy contract — only the
 * session model surfaces this bridge consumes, derived from
 * `@deepseek-ai/dsh-host-apiproxy/api` instead of a local duplicate.
 */
export type ChannelHostApiProxy = Pick<ApiProxy, 'sessions'> & {
  sessions: Pick<ApiProxy['sessions'], 'models' | 'selectModel'>;
};

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
    return this.hostApiProxy() ? 'host' : 'local';
  }

  /** Install only the headless hook; Web Host owns it when apiProxy is present. */
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
    if (this.strategyFor(agent) === 'host') {
      const host = await this.readHostCurrent(agent);
      if (host) return host;
    }
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
      const selectModel = this.hostApiProxy()?.sessions.selectModel;
      if (!selectModel) throw new Error('host model selection is unavailable: session.selectModel is not mounted');
      const response = await selectModel({
        // Locally minted correlation id: in-process calls only need the echo;
        // the official RpcRequest contract requires it on every request.
        rpcId: RpcId(randomUUID()),
        payload: {
          sessionId: agent.id,
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: String(selection.reasoningEffort) } : {}),
        },
      });
      if (response.result.ok === false) {
        throw new Error(response.result.error.message || 'model selection was rejected');
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

  private hostApiProxy(): ChannelHostApiProxy | undefined {
    return this.rootCtx.get('apiProxy') as ChannelHostApiProxy | undefined;
  }

  /**
   * Agents configured through the bridge always have a recorded strategy.
   * Keep the deployment-wide mode as a compatibility fallback for direct
   * controller callers that have not installed the Agent-scoped hook.
   */
  private strategyFor(agent: Agent): ChannelModelSelectionMode {
    return this.strategies.get(agent.ctx) ?? this.mode;
  }

  private async readHostCurrent(agent: Agent): Promise<ModelSelection | undefined> {
    const models = this.hostApiProxy()?.sessions.models;
    if (!models) return undefined;
    try {
      const response = await models({
        rpcId: RpcId(randomUUID()),
        payload: { sessionId: agent.id },
      });
      const current = response.result.ok ? response.result.value.current : undefined;
      if (!current?.provider || !current.model) return undefined;
      return {
        provider: current.provider,
        model: current.model,
        ...(current.reasoningEffort ? { reasoningEffort: ReasoningEffortId(current.reasoningEffort) } : {}),
      };
    } catch {
      return undefined;
    }
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
