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
 *    `session.*` RPCs touch (and eagerly in its pre-publication setup).
 *
 * `installModelSelection` registers two waterfalls (`system-prompt/assemble`
 * and `agent/request`) whose FINAL routing decision comes from the listener's
 * own ref. Installing BOTH entry points on the same agent creates two
 * independent routing owners that can disagree: the Web composer may show B
 * while the channel hook rewrites the request back to A (the first-registered
 * listener is the outermost waterfall wrapper and its return value is final).
 *
 * Ownership is therefore pinned ONCE PER AGENT, at the moment the Agent's
 * scope is set up, and never re-evaluated afterwards:
 *
 * - **host** — a Web Host (`apiProxy`) is mounted when this Agent is set up.
 *   The Host is the sole ModelSelection owner: `install()` only records the
 *   pin (NO local waterfall — the Host's `selectionFor` installs its own on
 *   first `session.*` RPC access), `prepare()` forces that install BEFORE the
 *   first command execution / followup by calling the official
 *   `session.models` RPC (pre-publication parity), `select()` routes the
 *   switch through the official `session.selectModel` RPC (which sets the
 *   Host's per-session `current` AND persists the shared default), and
 *   `current()` reads the Host's authoritative per-session selection through
 *   `session.models`.
 * - **local** — no Host at setup time. The channel owns the `ModelSelectionRef`
 *   and `installModelSelection` exactly like official Headless; `select()` sets
 *   `ref.current` and persists the shared default via
 *   `agentDefaultModel.saveSelection` (headless parity — the session pick
 *   and the shared default are the two layers of one user preference).
 *
 * A pinned owner NEVER changes while the Agent lives: a live agent does not
 * auto-upgrade local → host when a Host mounts later (that would install a
 * second, competing waterfall), and does not auto-downgrade host → local when
 * the Host unmounts (a host-owned agent FAILS LOUDLY instead — the Host is
 * authoritative and never drifts). `install()` returns the disposer for the
 * pin (and, in local mode, for the two waterfall listeners), so a reloading
 * bridge releases borrowed agents' channel-owned hooks exactly once.
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

/**
 * Thrown when a HOST-owned agent's ModelSelection backend is unreachable:
 * the pinned `apiProxy` was unmounted or replaced since the Agent was set up,
 * or a `session.*` RPC failed / returned a malformed envelope. The agent is
 * NEVER silently downgraded to the local backend — the Host is authoritative,
 * so the operation fails loudly and the user (or a plugin reload that
 * re-pins against the current Host) must restore the backend.
 */
export class ChannelModelSelectionBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChannelModelSelectionBackendError';
  }
}

/**
 * Thrown when a LOCAL-owned agent's pin is missing — an internal invariant
 * violation (the agent never went through `install()`), not a recoverable
 * runtime condition.
 */
export class ChannelModelSelectionInvariantError extends Error {
  constructor(sessionId: string) {
    super(
      `model selection invariant violation: agent '${sessionId}' has no local ModelSelection pin ` +
        `(install() did not run for this agent scope)`,
    );
    this.name = 'ChannelModelSelectionInvariantError';
  }
}

/**
 * One Agent's pinned ModelSelection ownership. Written exactly once (at
 * `install()` / setup time) and never re-evaluated while the Agent lives.
 */
export type AgentModelSelectionState =
  | {
      mode: 'local';
      /** The channel-owned ref coupled to this Agent's waterfalls. */
      ref: ChannelModelSelectionRef;
      /** Disposer returned by the official `installModelSelection`. */
      dispose: () => void;
    }
  | {
      mode: 'host';
      /** The exact apiProxy object this Agent was pinned against. */
      hostIdentity: object;
      /** Whether `prepare()` already forced the official `selectionFor` install. */
      prepared: boolean;
    };

export class ChannelModelSelectionController {
  /** agentCtx -> pinned ownership state. `agent.ctx` is the dsh-scope key, 1:1 with the Agent. */
  private readonly states = new WeakMap<Context, AgentModelSelectionState>();

  constructor(private readonly rootCtx: Context) {}

  /**
   * The backend a NEWLY set-up agent would be pinned to right now
   * (`host` when an apiProxy is currently mounted, `local` otherwise). This
   * is a deployment probe for `install()` only — an already-pinned Agent
   * NEVER re-reads it (ownership is per-Agent, not per-deployment).
   */
  get mode(): ChannelModelSelectionMode {
    return this.hostApiProxy() === undefined ? 'local' : 'host';
  }

  /**
   * Pin ONE backend for an Agent scope, permanently. Called from the bridge's
   * agent setup, so fresh AND resumed sessions both get `/model` support and
   * a pinned owner before any driving happens (spec §22).
   *
   * host mode: records the pin against the current apiProxy and installs
   * NOTHING — the Host's `selectionFor` is the sole owner of this Agent's
   * waterfall (it installs lazily on the first `session.*` RPC, which
   * `prepare()` forces before the first turn). Installing a second waterfall
   * here would create a competing routing owner.
   *
   * local mode: creates the channel-owned ref and installs the official hook.
   *
   * @returns the disposer: unpins the Agent and (local mode) removes both
   * waterfall listeners — a reloading bridge must call it for every Agent it
   * set up, including borrowed ones it cannot dispose.
   */
  install(agentCtx: Context): () => void {
    if (!isValidContextKey(agentCtx)) {
      // A ctx-less agent scope was never published through Harness (minimal
      // test doubles only) — nothing to pin, nothing to dispose.
      return () => {};
    }
    const state = this.ensureState(agentCtx);
    return () => {
      this.states.delete(agentCtx);
      if (state.mode === 'local') state.dispose();
    };
  }

  /**
   * Drive-time readiness, called AFTER create/resume/borrow completes and
   * BEFORE any command execution or followup. Guarantees that by the time the
   * first request of a fresh/resumed/borrowed session is built, the Agent's
   * ModelSelection owner is installed:
   *
   * - host mode: calls the official `session.models` RPC ONCE, which forces
   *   the Host's `agentFor` + `selectionFor` (the exact install the official
   *   pre-publication setup performs for Web agents). A rejected or malformed
   *   RPC (or a missing / replaced apiProxy) fails loudly — the Agent is
   *   never driven without an owning backend.
   * - local mode: NO-OP (the owner was installed at setup time).
   *
   * Idempotent: the host RPC fires at most once per Agent; a FAILED prepare
   * stays un-prepared, so the next message retries until the Host recovers.
   */
  async prepare(agent: Agent): Promise<void> {
    const agentCtx = agent.ctx;
    // Real Harness agents always carry a scoped context; minimal test doubles
    // may not. A ctx-less agent was never set up through this controller and
    // has no owner to prepare — skip (production can never hit this path).
    if (!isValidContextKey(agentCtx)) return;
    const state = this.ensureState(agentCtx);
    if (state.mode === 'local') return;
    if (state.prepared) return;
    await this.prepareHost(agent, state);
  }

  /**
   * Current effective selection for an agent (spec §21 reading priority),
   * read through the agent's OWN pinned backend:
   *
   * host mode: the Host's authoritative per-session selection
   * (`selectionFor(agent).current` — picked → request header → default),
   * read through the official `session.models` RPC so the channel display
   * can never drift from the composer. Any host failure (unmounted/replaced
   * apiProxy, rejected or malformed RPC) THROWS — no silent fallback to a
   * local chain that would disagree with the Host.
   *
   * local mode: the channel's own reading chain below.
   */
  async current(agent: Agent): Promise<ModelSelection | undefined> {
    const state = this.stateOf(agent);
    if (!state) {
      // Defensive: an agent never set up through this controller (foreign
      // scope, or a ctx-less test double) gets a READ-ONLY local chain — no
      // picked tier exists.
      return this.readLocal(agent, undefined);
    }
    if (state.mode === 'host') return this.readHostCurrent(agent, state);
    return this.readLocal(agent, state.ref);
  }

  /**
   * Pick a new selection for an agent; effective from the next model step
   * (spec §18/§24). Never touches `binding.route` and never disposes/resumes
   * the agent.
   *
   * host mode: routes the switch through the official `session.selectModel`
   * RPC — the Host updates its per-session `selectionFor(...).current` (the
   * composer model selector's source) and persists the shared default itself,
   * so the channel must NOT save the default again. A host rejection OR
   * malformed envelope throws (fail-loud — never a silent no-op).
   *
   * local mode: sets `ref.current` and persists the shared default via
   * `agentDefaultModel.saveSelection` (headless parity with the official
   * switch handler). Default-save failure is best-effort: the session-level
   * switch holds (official logs a warn and keeps the switch).
   */
  async select(agent: Agent, selection: ModelSelection): Promise<void> {
    const state = this.stateOf(agent);
    if (!state) throw new ChannelModelSelectionInvariantError(String(agent.id));
    if (state.mode === 'host') {
      await this.selectHost(agent, selection, state);
      return;
    }
    await this.selectLocal(agent, selection, state);
  }

  // --- ownership pinning ----------------------------------------------------

  /** The pinned state for an agent, or `undefined` when it was never set up. */
  private stateOf(agent: Agent): AgentModelSelectionState | undefined {
    const agentCtx = agent.ctx;
    if (!isValidContextKey(agentCtx)) return undefined;
    return this.states.get(agentCtx);
  }

  /**
   * The pinned state for an agent scope, pinning it on first touch. A local
   * pin created here installs the official waterfall immediately (a ref
   * without its listeners would make `select()` silently ineffective).
   */
  private ensureState(agentCtx: Context): AgentModelSelectionState {
    const existing = this.states.get(agentCtx);
    if (existing) return existing;
    const state = this.pin(agentCtx);
    if (state.mode === 'local') {
      state.dispose = installModelSelection(agentCtx, state.ref);
    }
    return state;
  }

  private pin(agentCtx: Context): AgentModelSelectionState {
    const host = this.hostApiProxy();
    const state: AgentModelSelectionState = host
      ? { mode: 'host', hostIdentity: host, prepared: false }
      : { mode: 'local', ref: { current: undefined, assembled: undefined }, dispose: () => {} };
    this.states.set(agentCtx, state);
    return state;
  }

  // --- host backend ---------------------------------------------------------

  private hostApiProxy(): ChannelHostApiProxy | undefined {
    return this.rootCtx.get('apiProxy') as ChannelHostApiProxy | undefined;
  }

  /**
   * The apiProxy this host-owned agent was pinned against, verified STILL
   * mounted and UNCHANGED. A different apiProxy object (Host reload) or a
   * missing one (Host unmounted) is a failed backend, never a reason to
   * switch owners or fall back.
   */
  private requireHost(state: { mode: 'host'; hostIdentity: object }): ChannelHostApiProxy {
    const host = this.hostApiProxy();
    if (host === undefined || host !== state.hostIdentity) {
      throw new ChannelModelSelectionBackendError(
        'host model-selection backend is unavailable: the Web Host apiProxy was unmounted or ' +
          'replaced since this agent was set up; wait for the Host to recover or reload the ' +
          'channel plugin to re-pin this agent',
      );
    }
    return host;
  }

  private async prepareHost(
    agent: Agent,
    state: Extract<AgentModelSelectionState, { mode: 'host' }>,
  ): Promise<void> {
    const models = this.requireHost(state).sessions?.models;
    if (!models) {
      throw new ChannelModelSelectionBackendError(
        'host model selection is unavailable: apiProxy.sessions.models is not mounted',
      );
    }
    let response: ChannelHostApiResult;
    try {
      response = await models({ payload: { sessionId: String(agent.id) } });
    } catch (error) {
      throw new ChannelModelSelectionBackendError(
        'host model selection is unavailable: session.models RPC failed: ' + errorMessage(error),
      );
    }
    const current = response?.result?.ok ? response.result.value?.current : undefined;
    if (!current?.provider || !current.model) {
      throw new ChannelModelSelectionBackendError(
        'host model selection did not resolve a current selection (session.models rejected or returned a malformed envelope)',
      );
    }
    state.prepared = true;
  }

  private async selectHost(
    agent: Agent,
    selection: ModelSelection,
    state: Extract<AgentModelSelectionState, { mode: 'host' }>,
  ): Promise<void> {
    const selectModel = this.requireHost(state).sessions?.selectModel;
    if (!selectModel) {
      throw new ChannelModelSelectionBackendError(
        'host model selection is unavailable: apiProxy.sessions.selectModel is not mounted',
      );
    }
    let response: ChannelHostApiResult;
    try {
      response = await selectModel({
        payload: {
          sessionId: String(agent.id),
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort
            ? { reasoningEffort: String(selection.reasoningEffort) }
            : {}),
        },
      });
    } catch (error) {
      throw new ChannelModelSelectionBackendError(
        'host model selection is unavailable: session.selectModel RPC failed: ' + errorMessage(error),
      );
    }
    if (response?.result?.ok === false) {
      const message = response.result.error?.message ?? 'model selection was rejected';
      throw new Error(message);
    }
    const selected = response?.result?.ok ? response.result.value?.selected : undefined;
    if (!selected?.provider || !selected.model) {
      throw new ChannelModelSelectionBackendError(
        'host model selection applied no selection (session.selectModel returned a malformed envelope)',
      );
    }
  }

  private async readHostCurrent(
    agent: Agent,
    state: Extract<AgentModelSelectionState, { mode: 'host' }>,
  ): Promise<ModelSelection | undefined> {
    const models = this.requireHost(state).sessions?.models;
    if (!models) {
      throw new ChannelModelSelectionBackendError(
        'host model selection is unavailable: apiProxy.sessions.models is not mounted',
      );
    }
    let response: ChannelHostApiResult;
    try {
      response = await models({ payload: { sessionId: String(agent.id) } });
    } catch (error) {
      throw new ChannelModelSelectionBackendError(
        'host model selection is unavailable: session.models RPC failed: ' + errorMessage(error),
      );
    }
    const current = response?.result?.ok ? response.result.value?.current : undefined;
    if (!current?.provider || !current.model) {
      throw new ChannelModelSelectionBackendError(
        'host model selection did not resolve a current selection (session.models rejected or returned a malformed envelope)',
      );
    }
    return {
      provider: current.provider,
      model: current.model,
      ...(current.reasoningEffort
        ? { reasoningEffort: ReasoningEffortId(current.reasoningEffort) }
        : {}),
    };
  }

  // --- local backend --------------------------------------------------------

  private async selectLocal(
    agent: Agent,
    selection: ModelSelection,
    state: Extract<AgentModelSelectionState, { mode: 'local' }>,
  ): Promise<void> {
    state.ref.current = selection;
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

  /** Reading-priority chain used by local mode (and read-only foreign agents). */
  private readLocal(agent: Agent, ref: ChannelModelSelectionRef | undefined): ModelSelection | undefined {
    const picked = ref?.current;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** WeakMap keys must be objects; real scoped contexts always are. */
function isValidContextKey(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}
