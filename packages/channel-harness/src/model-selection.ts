/**
 * ChannelModelSelectionManager — per-Agent ModelSelection coupling via the
 * official Harness `installModelSelection` seam (spec §18–§24).
 *
 * Every channel Agent scope the bridge sets up gets ONE mutable
 * `ModelSelectionRef`; the official hook couples it to prompt assembly and
 * request routing, so a `/model` switch takes effect from the next model step
 * and never splits the prompt surface from the request config. The ref is
 * owned here by the calling entry point (exactly like `dsh-headless` /
 * `dsh-host-apiproxy` in rc.6).
 *
 * Reading priority (spec §21 + the official `selectionFor` fallback):
 * ① the picked selection (`ref.current` after a `/model` switch);
 * ② the session request header (the config the loop ACTUALLY used last —
 *    persisted across process restarts via the `request/header` log event);
 * ③ the agent options snapshot (the create/resume route provider/model,
 *    when pinned);
 * ④ the Harness-wide default model selection (`ctx.agentDefaultModel` —
 *    capability-seams documents it as the shared default-ModelSelection state
 *    owner, exactly like the official `selectionFor` fallback).
 *
 * `install()` is safe with an empty current selection: the official hook
 * leaves prompt assembly and request config untouched until a selection is
 * picked, so fresh sessions keep their normal (header/options-derived)
 * routing.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model';

/** The mutable ref a channel agent's model selection is coupled through. */
export type ChannelModelSelectionRef = ModelSelectionRef;

export class ChannelModelSelectionManager {
  /** agentCtx -> ref. `agent.ctx` is the dsh-scope key, 1:1 with the Agent. */
  private readonly refs = new WeakMap<Context, ChannelModelSelectionRef>();

  /**
   * Install the official model-selection coupling on an Agent scope. Called
   * from the bridge's agent setup, so fresh AND resumed sessions both get
   * `/model` support (spec §22).
   */
  install(agentCtx: Context): void {
    const ref: ChannelModelSelectionRef = { current: undefined, assembled: undefined };
    installModelSelection(agentCtx, ref);
    this.refs.set(agentCtx, ref);
  }

  /** Current effective selection for an agent (spec §21 reading priority). */
  current(agent: Agent): ModelSelection | undefined {
    const picked = this.refs.get(agent.ctx)?.current;
    if (picked) return picked;
    // Optional-call guard keeps the manager usable against minimal session
    // shapes in tests; the real Session always has requestHeader().
    const headerConfig = agent.session.requestHeader?.()?.config;
    if (headerConfig?.provider && headerConfig.model) {
      return {
        provider: headerConfig.provider,
        model: headerConfig.model,
        ...(headerConfig.reasoningEffort
          ? { reasoningEffort: headerConfig.reasoningEffort }
          : {}),
      };
    }
    const { provider, model } = agent.options;
    if (provider && model) return { provider, model };
    // ④ Harness-wide default (capability-seams: ctx.agentDefaultModel is the
    //    shared default-ModelSelection state owner). Resolves through the
    //    agent's scoped context inheritance to the root-provided service.
    const defaultService = agent.ctx.get('agentDefaultModel') as AgentDefaultModelConfig | undefined;
    const defaults = defaultService?.currentSelection();
    if (defaults?.provider && defaults.model) {
      return {
        provider: defaults.provider,
        model: defaults.model,
        ...(defaults.reasoningEffort ? { reasoningEffort: defaults.reasoningEffort } : {}),
      };
    }
    return undefined;
  }

  /**
   * Pick a new selection for an agent; effective from the next model step
   * (spec §18/§24). Never touches `binding.route` and never disposes/resumes
   * the agent.
   */
  select(agent: Agent, selection: ModelSelection): void {
    const ref = this.refs.get(agent.ctx);
    if (!ref) return;
    ref.current = selection;
  }
}