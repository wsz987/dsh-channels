/**
 * AgentManager — the single place that touches `ctx.agents`.
 *
 * Ownership model (doc H0.4/H0.7):
 * - `ctx.agents.get()` returns a live agent the bridge does NOT own — it is
 *   never disposed here.
 * - `ctx.agents.create()` / `ctx.agents.resume()` return an `AgentHandle`;
 *   the bridge MUST hold every handle it created/resumed and dispose it on
 *   plugin unload. Owned handles live in `owned` and are disposed exactly
 *   once by `disposeAll()`.
 *
 * Routing is expressed as an `AgentRouteSpec`, never an `agentId` (the
 * Harness Agent identity is the `SessionId`). `create` and `resume` receive
 * the SAME route so provider/model/maxTokens stay identical on both paths
 * (doc H0.5 route parity).
 *
 * Create-vs-resume is decided by the CALLER (the bridge), not by error-regex
 * fallback. Persistence is an OPTIONAL capability resolved LIVE at the use
 * site: `canResume()` tells the caller whether a sessionPersistence service
 * is currently mounted, `exists()` probes membership via the live service,
 * and `probePersisted()` answers the atomic unavailable/present/missing
 * question in one resolver call (no canResume/exists TOCTOU across a
 * persistence HMR) — corruption / unsupported-format / backend failures
 * propagate loudly rather than being misread as "no persistence".
 *
 * Global concurrency gate: at most `maxConcurrency` `create()`/`resume()` calls
 * are in flight at once across all sessions; `get()` (a live lookup) is never
 * limited.
 */
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentHandle, AgentOptions, AgentSetup, ModelSelection } from '@deepseek-ai/dsh-agent';
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { ChannelLogger } from '@wsz987/channel-core';
import type { AgentRouteSpec } from './agent-router.js';
import type { SessionBinding } from './session-router.js';

/** A live agent as seen through the gateway (id + raw Agent + drive surface). */
export interface GatewayAgent {
  id: string;
  /** The raw Harness Agent — the dsh-scope key used to install Agent-scoped commands. */
  agent: Agent;
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
}

/** A gateway-created/resumed agent that the caller must dispose. */
export interface GatewayAgentHandle extends GatewayAgent {
  dispose(): Promise<void>;
}

/**
 * Whether a persisted session exists, probed through the optional persistence
 * service. Implemented via membership/inspection, NEVER by matching an error
 * message against a /persistence|persist/i regex.
 */
export interface PersistenceProbe {
  exists(sessionId: string): Promise<boolean>;
}

/**
 * Atomic result of probing ONE session through the LIVE persistence
 * capability: `unavailable` (no sessionPersistence service mounted right
 * now), `present`, or `missing`. Resolving the capability once per probe
 * closes the canResume/exists TOCTOU window (a persistence HMR between the
 * two lookups would otherwise pair different backends).
 */
export type PersistedProbeResult = 'unavailable' | 'present' | 'missing';

/**
 * A durable binding references a persisted session that no longer exists
 * (session-not-found, aligned with the official Host's
 * "persisted identity missing -> session-not-found"). With a
 * sessionPersistence service mounted, a missing persisted session behind an
 * existing binding is a binding/session durability inconsistency — NEVER a
 * first create — so resolution fails loudly instead of silently
 * blank-recreating the same session id. Deployments WITHOUT persistence
 * (ephemeral semantics) never throw this: they recreate on the recorded id.
 */
export class SessionNotFoundError extends Error {
  constructor(
    readonly sessionId: string,
    readonly bindingKey?: string,
  ) {
    super(
      `session '${sessionId}' not found in persistence: the binding` +
        (bindingKey ? ` '${bindingKey}'` : '') +
        ` references a durable session that no longer exists (binding/session ` +
        `durability inconsistency); refusing to silently recreate it. Restore ` +
        `the session or clear/repair the binding.`,
    );
    this.name = 'SessionNotFoundError';
  }
}

/** Caller-supplied metadata for a fresh agent create (plan §8). */
export interface AgentCreateMeta {
  /** Explicit working directory for the new session's header.cwd. */
  cwd?: string;
}

/** Minimal port the bridge needs from the Harness agent runtime. */
export interface AgentGateway {
  get(sessionId: string): GatewayAgent | undefined;
  create(
    sessionId: string,
    route: AgentRouteSpec,
    setup?: AgentSetup,
    meta?: AgentCreateMeta,
  ): Promise<GatewayAgentHandle>;
  resume(sessionId: string, route: AgentRouteSpec, setup?: AgentSetup): Promise<GatewayAgentHandle>;
  /** Whether a sessionPersistence service is available (enables resume). */
  canResume(): boolean;
  /** Probe whether a persisted session exists. */
  exists(sessionId: string): Promise<boolean>;
  /**
   * Atomic persistence probe (live capability resolved once). Optional on
   * the interface so minimal test doubles can rely on the AgentManager's
   * canResume+exists fallback; the real gateway implements it.
   */
  probePersisted?(sessionId: string): Promise<PersistedProbeResult>;
}

/** A resolved agent reference handed to the caller. */
export interface AgentRef {
  sessionId: string;
  route: AgentRouteSpec;
  /** The raw Harness Agent — the dsh-scope key used to install Agent-scoped commands. */
  agent: Agent;
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
  /**
   * Marks the caller done with the ref. Simple v1 semantics: the ref never
   * disposes the underlying handle itself — the manager owns lifecycle and
   * disposes each handle exactly once during `disposeAll()`.
   */
  release(): void;
}

/** Filter out undefined optional agentOptions fields (route parity helper). */
export function optionsFor(route: AgentRouteSpec): AgentOptions | undefined {
  const options: AgentOptions = {};
  if (route.provider) options.provider = route.provider;
  if (route.model) options.model = route.model;
  if (route.maxTokens !== undefined) options.maxTokens = route.maxTokens;
  return Object.keys(options).length > 0 ? options : undefined;
}

/**
 * Resolve a route's provider/model, falling back to Harness's default model
 * selection when the route leaves the model unset.
 *
 * `{{model}}` (the persona variable that fails with "prompt variable has no
 * value") depends only on `model`, so a route that already pins a model —
 * with or without a provider — is left untouched. Only a missing model is
 * filled from the default (and the default's provider rides along when the
 * route also left provider unset).
 *
 * The default model is read live (per agent creation), so new channel sessions
 * follow the user's Harness-wide default while sessions pinned to an explicit
 * route keep their own provider/model.
 */
export function resolveRoute(
  route: AgentRouteSpec,
  defaultSelection: ModelSelection | undefined,
): AgentRouteSpec {
  if (route.model) return route;

  if (!defaultSelection?.model) return route;

  return {
    ...route,
    model: defaultSelection.model,
    provider: route.provider ?? defaultSelection.provider,
  };
}

/**
 * Probe a persisted session's existence through the persistence service's
 * `list()` membership. A session that is absent returns `false`; any backend
 * failure (corruption, unsupported format, connectivity) propagates loudly.
 *
 * The persistence service is resolved LIVE on every call (a resolver, not a
 * startup snapshot): a sessionPersistence mounted/unmounted/replaced after
 * the bridge started is observed on the next probe — reversible Cordis
 * lifecycle parity, since `ctx.get` only returns currently active providers.
 */
export class PersistenceMembershipProbe implements PersistenceProbe {
  constructor(private readonly resolvePersistence: () => SessionPersistence | undefined) {}

  async exists(sessionId: string): Promise<boolean> {
    const persistence = this.resolvePersistence();
    if (!persistence) return false;
    const headers = await persistence.list();
    const target = sessionId;
    return headers.some((header) => String(header.id) === target);
  }

  /** Atomic probe: the live capability is resolved exactly once per call. */
  async probe(sessionId: string): Promise<PersistedProbeResult> {
    const persistence = this.resolvePersistence();
    if (!persistence) return 'unavailable';
    const headers = await persistence.list();
    return headers.some((header) => String(header.id) === sessionId) ? 'present' : 'missing';
  }
}

/**
 * Real gateway over `ctx.agents`. This is the only Harness import surface in
 * the bridge (besides the `session/event` feed consumed by ReplyRouter).
 *
 * Persistence is an OPTIONAL capability resolved LIVE at the use site: the
 * caller passes a resolver (`() => ctx.get('sessionPersistence')`), so
 * `canResume()` and the existence probe reflect the service's CURRENT
 * presence — mounting, unmounting, or replacing the service after the bridge
 * started is observed on the next probe (never a startup snapshot).
 */
export class HarnessAgentGateway implements AgentGateway {
  private readonly probe: PersistenceMembershipProbe;
  private readonly resolvePersistence: () => SessionPersistence | undefined;

  constructor(
    private readonly ctx: Context,
    resolvePersistence?: () => SessionPersistence | undefined,
  ) {
    this.resolvePersistence = resolvePersistence ?? (() => undefined);
    this.probe = new PersistenceMembershipProbe(this.resolvePersistence);
  }

  get(sessionId: string): GatewayAgent | undefined {
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (!agent) return undefined;
    return {
      id: agent.id,
      agent,
      followup: (message) => agent.followup(message as UserMessage),
      whenIdle: () => agent.whenIdle(),
    };
  }

  canResume(): boolean {
    // Only a currently mounted sessionPersistence service enables resume.
    return this.resolvePersistence() !== undefined;
  }

  async exists(sessionId: string): Promise<boolean> {
    return this.probe.exists(sessionId);
  }

  async probePersisted(sessionId: string): Promise<PersistedProbeResult> {
    return this.probe.probe(sessionId);
  }

  /** Read Harness's live default-model selection (undefined when absent). */
  private defaultSelection(): ModelSelection | undefined {
    const service = this.ctx.get('agentDefaultModel') as AgentDefaultModelConfig | undefined;
    return service?.currentSelection();
  }

  async create(
    sessionId: string,
    route: AgentRouteSpec,
    setup?: AgentSetup,
    meta?: AgentCreateMeta,
  ): Promise<GatewayAgentHandle> {
    const resolved = resolveRoute(route, this.defaultSelection());
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      // `{{cwd}}` reads `session.header.cwd`, and `dsh-workspace` groups the
      // session under the workspace whose path matches that cwd. The cwd is
      // decided by the CALLER (the bridge) and passed through `meta.cwd` —
      // `HarnessAgentGateway` only creates the session with the given cwd and
      // never falls back to `process.cwd()`. This must be set at creation —
      // `resume` has no `meta` and cannot add it later.
      meta: {
        ...(meta?.cwd ? { cwd: meta.cwd } : {}),
        ...(resolved.preset ? { agentPreset: resolved.preset } : {}),
      },
      agentOptions: optionsFor(resolved),
      setup,
    });
    return this.wrap(handle);
  }

  async resume(sessionId: string, route: AgentRouteSpec, setup?: AgentSetup): Promise<GatewayAgentHandle> {
    // Route parity (doc H0.5): resume uses the SAME optionsFor(resolveRoute(...))
    // as create. NEVER `model ?? agentId`.
    const resolved = resolveRoute(route, this.defaultSelection());
    const handle = await this.ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: optionsFor(resolved),
      setup,
    });
    return this.wrap(handle);
  }

  private wrap(handle: AgentHandle): GatewayAgentHandle {
    return {
      id: handle.agent.id,
      agent: handle.agent,
      followup: (message) => handle.agent.followup(message as UserMessage),
      whenIdle: () => handle.agent.whenIdle(),
      dispose: () => handle.dispose(),
    };
  }
}

export class AgentManager {
  private readonly inFlight = new Map<string, Promise<AgentRef>>();
  /** Handles this manager created/resumed — the ones it must dispose. */
  private readonly owned = new Map<string, GatewayAgentHandle>();
  /** Resolved refs, kept for drain (`whenIdle`) lookups. */
  private readonly refs = new Map<string, AgentRef>();
  /** Agents that already received the one-time channel-command setup. */
  private readonly configuredAgents = new WeakSet<Agent>();
  /** sessionId -> binding, the reverse lookup used by the ReplyRouter. */
  private readonly bindings = new Map<string, SessionBinding>();
  private readonly maxConcurrency: number;
  private active = 0;
  /** Waiters queued for a free concurrency slot. */
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  constructor(
    private readonly gateway: AgentGateway,
    private readonly logger: ChannelLogger,
    maxConcurrency = 4,
  ) {
    this.maxConcurrency = Math.max(1, maxConcurrency);
  }

  /** Whether a sessionPersistence service enables `resume`. */
  canResume(): boolean {
    return this.gateway.canResume();
  }

  /** Probe whether a persisted session exists. Backend failures propagate. */
  exists(sessionId: string): Promise<boolean> {
    return this.gateway.exists(sessionId);
  }

  /**
   * Atomic persistence probe: resolves the LIVE capability once and answers
   * `unavailable` / `present` / `missing` — the bridge's single decision
   * point for recreate-vs-resume-vs-fail, immune to a persistence HMR between
   * `canResume()` and `exists()`.
   */
  async probePersisted(sessionId: string): Promise<PersistedProbeResult> {
    if (this.gateway.probePersisted) return this.gateway.probePersisted(sessionId);
    // Fallback for minimal test gateways without the atomic probe: two live
    // lookups (deterministic in tests).
    if (!this.gateway.canResume()) return 'unavailable';
    return (await this.gateway.exists(sessionId)) ? 'present' : 'missing';
  }

  /**
   * Create a NEW agent for a session (no prior binding). Calls
   * `gateway.create` directly (under the concurrency slot), owns the handle,
   * and returns the ref. Never resumes — the caller already decided this is a
   * fresh conversation. Single-flight per session id.
   */
  create(
    sessionId: string,
    route: AgentRouteSpec,
    setup?: AgentSetup,
    meta?: AgentCreateMeta,
  ): Promise<AgentRef> {
    if (this.closed) {
      return Promise.reject(new Error(`AgentManager is closed; cannot create '${sessionId}'`));
    }
    const pending = this.inFlight.get(sessionId);
    if (pending) return pending;
    const run = this.doCreate(sessionId, route, setup, meta);
    this.inFlight.set(sessionId, run);
    void run.then(
      () => {
        this.inFlight.delete(sessionId);
      },
      () => {
        this.inFlight.delete(sessionId);
      },
    );
    return run;
  }

  /**
   * Resolve an agent for an EXISTING, persisted session: live `get` first; on
   * a miss, `gateway.resume(route)`. A resume failure propagates loudly
   * (throws) — never falls back to create and never sniffs error messages.
   * Single-flight per session id.
   */
  resolve(sessionId: string, route: AgentRouteSpec, setup?: AgentSetup): Promise<AgentRef> {
    if (this.closed) {
      return Promise.reject(new Error(`AgentManager is closed; cannot resolve '${sessionId}'`));
    }
    const pending = this.inFlight.get(sessionId);
    if (pending) return pending;
    const run = this.doResolve(sessionId, route, setup);
    this.inFlight.set(sessionId, run);
    void run.then(
      () => {
        this.inFlight.delete(sessionId);
      },
      () => {
        this.inFlight.delete(sessionId);
      },
    );
    return run;
  }

  /**
   * Borrow the LIVE agent for a session, when one is loaded in this process.
   * Returns `undefined` when there is no live agent — the caller (the Session
   * factory, for channel-session lifecycle decisions) decides what to do next
   * (resume, or a cwd/workspace-aware recreate). Never creates or resumes and
   * never takes ownership (the borrowed agent is never disposed here). Runs
   * the one-time setup against a borrowed agent, exactly once.
   */
  borrowIfLive(sessionId: string, route: AgentRouteSpec, setup?: AgentSetup): Promise<AgentRef | undefined> {
    if (this.closed) {
      return Promise.reject(new Error(`AgentManager is closed; cannot borrow '${sessionId}'`));
    }
    return this.doBorrowIfLive(sessionId, route, setup);
  }

  /** Register the binding associated with a session (reverse reply routing). */
  registerBinding(binding: SessionBinding): void {
    this.bindings.set(binding.sessionId, binding);
  }

  /** Reverse lookup for the ReplyRouter. */
  bindingFor(sessionId: string): SessionBinding | undefined {
    return this.bindings.get(sessionId);
  }

  /**
   * Live agent lookup for the /stop fast path (spec §8). Returns the raw
   * Agent when it is currently live in this process — NEVER creates or
   * resumes a session just to answer this probe.
   */
  getLiveAgent(sessionId: string): Agent | undefined {
    return this.gateway.get(sessionId)?.agent;
  }

  /** Resolved ref for drain purposes, if any. */
  refFor(sessionId: string): AgentRef | undefined {
    return this.refs.get(sessionId);
  }

  /** Session ids that currently have an active turn (for drain). */
  activeSessions(): string[] {
    return [...this.bindings.keys()];
  }

  /**
   * Dispose every owned handle exactly once and clear all tracking. Agents
   * obtained via `gateway.get()` (not owned) are never disposed.
   */
  async disposeAll(): Promise<void> {
    this.closed = true;
    const waiters = this.waiters.splice(0);
    for (const wake of waiters) wake();
    const handles = [...this.owned.values()];
    this.owned.clear();
    this.refs.clear();
    this.bindings.clear();
    const results = await Promise.allSettled(handles.map((handle) => handle.dispose()));
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(`failed to dispose an owned agent handle`, result.reason);
      }
    }
  }

  /**
   * Dispose a single owned handle (used to roll back a create whose binding
   * write failed afterward). No-op for handles the manager does not own.
   */
  async disposeSession(sessionId: string): Promise<void> {
    const handle = this.owned.get(sessionId);
    if (!handle) return;
    this.owned.delete(sessionId);
    this.refs.delete(sessionId);
    this.bindings.delete(sessionId);
    try {
      await handle.dispose();
    } catch (error) {
      this.logger.error(`failed to dispose owned agent handle for '${sessionId}'`, error);
    }
  }

  /**
   * Retire a session's reference and reverse binding and dispose it ONLY if the
   * manager owns the handle (plan §15). Borrowed / unknown agents are released
   * from local tracking but NEVER disposed. Retiring never touches persisted
   * history — the old session keeps its durable log.
   */
  async retireSession(sessionId: string): Promise<void> {
    this.refs.delete(sessionId);
    this.bindings.delete(sessionId);
    const handle = this.owned.get(sessionId);
    if (!handle) return;
    this.owned.delete(sessionId);
    try {
      await handle.dispose();
    } catch (error) {
      this.logger.error(`failed to dispose owned agent handle for '${sessionId}'`, error);
    }
  }

  /**
   * One-time channel-command setup for a BORROWED live agent (plan §7.1). A
   * borrowed agent never went through create/resume, so its setup could not
   * have run at publication; run it here exactly once against the agent's
   * scoped context. Setup failure propagates to the caller. The borrowed
   * agent is never disposed here.
   */
  private async ensureBorrowedSetup(agent: GatewayAgent, setup: AgentSetup | undefined): Promise<void> {
    if (!setup) return;
    if (this.configuredAgents.has(agent.agent)) return;
    const commit = await setup(agent.agent.ctx);
    commit?.commit();
    this.configuredAgents.add(agent.agent);
  }

  private async doCreate(
    sessionId: string,
    route: AgentRouteSpec,
    setup?: AgentSetup,
    meta?: AgentCreateMeta,
  ): Promise<AgentRef> {
    return this.withSlot(async () => {
      const handle = await this.gateway.create(sessionId, route, setup, meta);
      this.owned.set(sessionId, handle);
      if (setup) this.configuredAgents.add(handle.agent);
      return this.makeRef(sessionId, route, handle);
    });
  }

  private async doResolve(sessionId: string, route: AgentRouteSpec, setup?: AgentSetup): Promise<AgentRef> {
    const live = this.gateway.get(sessionId);
    if (live) {
      await this.ensureBorrowedSetup(live, setup);
      return this.makeRef(sessionId, route, live);
    }
    return this.withSlot(async () => {
      const handle = await this.gateway.resume(sessionId, route, setup);
      this.owned.set(sessionId, handle);
      if (setup) this.configuredAgents.add(handle.agent);
      return this.makeRef(sessionId, route, handle);
    });
  }

  private async doBorrowIfLive(
    sessionId: string,
    route: AgentRouteSpec,
    setup?: AgentSetup,
  ): Promise<AgentRef | undefined> {
    const live = this.gateway.get(sessionId);
    if (!live) return undefined;
    await this.ensureBorrowedSetup(live, setup);
    return this.makeRef(sessionId, route, live);
  }

  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    while (true) {
      if (this.closed) {
        throw new Error(`AgentManager is closed; cannot resolve a session`);
      }
      if (this.active < this.maxConcurrency) {
        this.active += 1;
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private releaseSlot(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }

  private makeRef(sessionId: string, route: AgentRouteSpec, agent: GatewayAgent): AgentRef {
    const ref: AgentRef = {
      sessionId,
      route,
      agent: agent.agent,
      followup: (message) => agent.followup(message),
      whenIdle: () => agent.whenIdle(),
      release: () => {
        // Simple ownership: release is a marker; actual disposal happens once
        // in disposeAll() for handles this manager owns.
      },
    };
    this.refs.set(sessionId, ref);
    return ref;
  }
}