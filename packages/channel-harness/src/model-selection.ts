/**
 * ChannelModelSelectionController — per-Agent model-selection OWNERSHIP with
 * exactly ONE backend per Agent (spec §18–§24).
 *
 * The official Harness has two entry points that each couple a mutable
 * selection to prompt assembly and request routing through
 * `installModelSelection`:
 *
 * ① the Headless / channel entry point owns its own `ModelSelectionRef` and
 *    calls `installModelSelection(agentCtx, ref)`;
 * ② the Web Host (`dsh-host-apiproxy`) owns a `WeakMap<Agent,
 *    WebModelSelectionRef>` (`selectionFor`) and lazily calls
 *    `installModelSelection(agent.ctx, selection)` for every agent its
 *    `session.*` RPCs touch.
 *
 * `installModelSelection` registers two waterfalls (`system-prompt/assemble`
 * and `agent/request`) whose FINAL routing decision comes from the listener's
 * own ref. Installing BOTH entry points on the same agent creates two
 * independent routing owners that can disagree: the Web composer may show B
 * while the channel hook rewrites the request back to A (the first-registered
 * listener is the outermost waterfall wrapper and its return value is final).
 *
 * Therefore this controller picks ONE backend per deployment and never
 * installs the other:
 *
 * - **host** — a Web Host (`apiProxy`) is mounted. The Host is the sole
 *   ModelSelection owner: `install()` is a NO-OP (the Host's `selectionFor`
 *   installs its own waterfall on first RPC access), `select()` routes the
 *   switch through the official `session.selectModel` RPC (which sets the
 *   Host's per-session `current` AND persists the shared default), and
 *   `current()` reads the Host's authoritative per-session selection through
 *   `session.models`.
 * - **local** — no Host. The channel owns the `ModelSelectionRef` and
 *   `installModelSelection` exactly like official Headless; `select()` sets
 *   `ref.current` and persists the shared default via
 *   `agentDefaultModel.saveSelection` (headless parity — the session pick
 *   and the shared default are the two layers of one user preference).
 *
 * Reading priority (spec §21 + the official `selectionFor` fallback):
 * ① the picked selection (`ref.current` / Host `current`);
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
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model';

/** The mutable ref a channel agent's model selection is coupled through (local mode only). */
export type ChannelModelSelectionRef = ModelSelectionRef;

/** Which entry point owns the ModelSelection waterfall for channel agents. */
export type ChannelModelSelectionMode = 'host' | 'local';

/**
 * Structural subset of the official `dsh-host-apiproxy` `apiProxy` service
 * (no hard dependency — resolved via `ctx.get('apiProxy')`, mirroring the
 * bridge's other optional seams). `selectModel` / `models` mirror the
 * official `session.*` RPC shapes.
 */
export interface ChannelHostApiProxy {
  sessions?: {
    selectModel?(request: {
      payload: {
        sessionId: string;
        provider: string;
        model: string;
        reasoningEffort?: string;
      };
    }): Promise<ChannelHostApiResult>;
    models?(request: { payload: { sessionId: string } }): Promise<ChannelHostApiResult>;
  };
}

/** The RPC envelope both host calls return (`{ rpcId, result: { ok, value?, error? } }`). */
export interface ChannelHostApiResult {
  result?: {
    ok: boolean;
    value?: {
      /** `session.models` read: the host's authoritative per-session selection. */
      current?: HostModelSelection;
      /** `session.selectModel` write: the resolved selection the host applied. */
      selected?: HostModelSelection;
    };
    error?: {
      code?: string;
      message?: string;
      details?: unknown;
    };
  };
}

/** Wire shape of a ModelSelection on the host RPC (reasoningEffort arrives as a string). */
export interface HostModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export class ChannelModelSelectionController {
  /** agentCtx -> ref (LOCAL mode only). `agent.ctx` is the dsh-scope key, 1:1 with the Agent. */
  private readonly refs = new WeakMap<Context, ChannelModelSelectionRef>();

  constructor(private readonly rootCtx: Context) {}

  /**
   * The single backend for the CURRENT deployment. Re-checked on every call:
   * the decision is made when an Agent scope is set up (long after all
   * profile plugins — including a Web Host — have started), and never
   * changes for a live agent in practice.
   */
  get mode(): ChannelModelSelectionMode {
    return this.hostApiProxy() === undefined ? 'local' : 'host';
  }

  /**
   * Install the official model-selection coupling on an Agent scope. Called
   * from the bridge's agent setup, so fresh AND resumed sessions both get
   * `/model` support (spec §22).
   *
   * host mode: NO-OP — the Host's `selectionFor` is the sole owner of this
   * Agent's waterfall (it installs lazily on the first `session.*` RPC, and
   * our own `select()`/read paths always reach the Host). Installing a
   * second waterfall here would create a competing routing owner.
   */
  install(agentCtx: Context): void {
    if (this.mode === 'host') return;
    const ref: ChannelModelSelectionRef = { current: undefined, assembled: undefined };
    installModelSelection(agentCtx, ref);
    this.refs.set(agentCtx, ref);
  }

  /**
   * Current effective selection for an agent (spec §21 reading priority).
   *
   * host mode: the Host's authoritative per-session selection
   * (`selectionFor(agent).current` — picked → request header → default),
   * read through the official `session.models` RPC so the channel display
   * can never drift from the composer. A missing/failing host read falls back
   * to the local chain below (without a picked tier — there is none locally).
   */
  async current(agent: Agent): Promise<ModelSelection | undefined> {
    if (this.mode === 'host') {
      const host = await this.readHostCurrent(agent);
      if (host) return host;
    }
    return this.readLocal(agent);
  }

  /**
   * Pick a new selection for an agent; effective from the next model step
   * (spec §18/§24). Never touches `binding.route` and never disposes/resumes
   * the agent.
   *
   * host mode: routes the switch through the official `session.selectModel`
   * RPC — the Host updates its per-session `selectionFor(...).current` (the
   * composer model selector's source) and persists the shared default itself,
   * so the channel must NOT save the default again. A host rejection throws.
   *
   * local mode: sets `ref.current` and persists the shared default via
   * `agentDefaultModel.saveSelection` (headless parity with the official
   * switch handler). Default-save failure is best-effort: the session-level
   * switch holds (official logs a warn and keeps the switch).
   */
  async select(agent: Agent, selection: ModelSelection): Promise<void> {
    if (this.mode === 'host') {
      await this.selectHost(agent, selection);
      return;
    }
    await this.selectLocal(agent, selection);
  }

  // --- host backend ---------------------------------------------------------

  private hostApiProxy(): ChannelHostApiProxy | undefined {
    return this.rootCtx.get('apiProxy') as ChannelHostApiProxy | undefined;
  }

  private async selectHost(agent: Agent, selection: ModelSelection): Promise<void> {
    const selectModel = this.hostApiProxy()?.sessions?.selectModel;
    if (!selectModel) {
      throw new Error('host model selection is unavailable: apiProxy.sessions.selectModel is not mounted');
    }
    const response = await selectModel({
      payload: {
        sessionId: String(agent.id),
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort
          ? { reasoningEffort: String(selection.reasoningEffort) }
          : {}),
      },
    });
    if (response?.result?.ok === false) {
      const message = response.result.error?.message ?? 'model selection was rejected';
      throw new Error(message);
    }
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
        ...(current.reasoningEffort
          ? { reasoningEffort: ReasoningEffortId(current.reasoningEffort) }
          : {}),
      };
    } catch {
      // The host read is best-effort: fall back to the local chain so /model
      // and /status still render when the host RPC is missing or fails.
      return undefined;
    }
  }

  // --- local backend --------------------------------------------------------

  private async selectLocal(agent: Agent, selection: ModelSelection): Promise<void> {
    const ref = this.refs.get(agent.ctx);
    if (!ref) return;
    ref.current = selection;
    // Persist as the Harness-wide default (official headless parity: the
    // session pick and the shared default are the two layers of one user
    // preference — host-apiproxy saves the default in the same switch
    // handler). Best-effort: a failure must not fail the session-level
    // switch (official logs a warn and keeps the session switch).
    try {
      const defaultService = this.rootCtx.get('agentDefaultModel') as AgentDefaultModelConfig | undefined;
      await defaultService?.saveSelection(selection);
    } catch {
      // mirrors official host-apiproxy behavior
    }
  }

  /** Reading-priority chain shared by local mode and the host fallback. */
  private readLocal(agent: Agent): ModelSelection | undefined {
    const picked = this.refs.get(agent.ctx)?.current;
    if (picked) return picked;
    // Optional-call guard keeps the controller usable against minimal session
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
}
