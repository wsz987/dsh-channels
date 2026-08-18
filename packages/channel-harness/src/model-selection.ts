/**
 * Thin channel adapter for Harness model selection.
 *
 * Harness owns the default model and the Web Host owns the session RPC. The
 * channel only bridges `/model` to those official surfaces. In headless mode
 * it uses the official Agent-scoped `ModelSelectionRef` required to affect the
 * current Session. There is no per-Agent owner pin, apiProxy identity cache,
 * first-turn prepare, or fallback state machine.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model';

export type ChannelModelSelectionRef = ModelSelectionRef;
export type ChannelModelSelectionMode = 'host' | 'local';

export interface ChannelHostApiProxy {
  sessions?: {
    selectModel?(request: {
      payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string };
    }): Promise<ChannelHostApiResult>;
    models?(request: { payload: { sessionId: string } }): Promise<ChannelHostApiResult>;
  };
}

export interface ChannelHostApiResult {
  result?: {
    ok: boolean;
    value?: { current?: HostModelSelection; selected?: HostModelSelection };
    error?: { code?: string; message?: string; details?: unknown };
  };
}

export interface HostModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export class ChannelModelSelectionController {
  private readonly refs = new WeakMap<Context, ChannelModelSelectionRef>();

  constructor(private readonly rootCtx: Context) {}

  get mode(): ChannelModelSelectionMode {
    return this.hostApiProxy() ? 'host' : 'local';
  }

  /** Install only the headless hook; Web Host owns it when apiProxy is present. */
  install(agentCtx: Context): () => void {
    if (this.mode === 'host') return () => {};
    const ref: ChannelModelSelectionRef = { current: undefined, assembled: undefined };
    const dispose = installModelSelection(agentCtx, ref);
    this.refs.set(agentCtx, ref);
    return () => {
      dispose();
      this.refs.delete(agentCtx);
    };
  }

  /** No first-turn RPC: Harness creates/resumes the Session directly. */
  async prepare(_agent: Agent): Promise<void> {}

  async current(agent: Agent): Promise<ModelSelection | undefined> {
    if (this.mode === 'host') {
      const host = await this.readHostCurrent(agent);
      if (host) return host;
    }
    return this.readLocal(agent);
  }

  async selectionForStep(agent: Agent): Promise<ModelSelection | undefined> {
    if (this.mode === 'local') {
      const ref = this.refs.get(agent.ctx);
      if (ref?.assembled) return ref.assembled;
    }
    return this.current(agent);
  }

  async select(agent: Agent, selection: ModelSelection): Promise<void> {
    if (this.mode === 'host') {
      const selectModel = this.hostApiProxy()?.sessions?.selectModel;
      if (!selectModel) throw new Error('host model selection is unavailable: session.selectModel is not mounted');
      const response = await selectModel({
        payload: {
          sessionId: String(agent.id),
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: String(selection.reasoningEffort) } : {}),
        },
      });
      if (response?.result?.ok === false) {
        throw new Error(response.result.error?.message ?? 'model selection was rejected');
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

  private async readHostCurrent(agent: Agent): Promise<ModelSelection | undefined> {
    const models = this.hostApiProxy()?.sessions?.models;
    if (!models) return undefined;
    try {
      const response = await models({ payload: { sessionId: String(agent.id) } });
      const current = response?.result?.ok ? response.result.value?.current : undefined;
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
