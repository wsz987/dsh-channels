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
 * fallback. Persistence is an OPTIONAL capability resolved at the use site:
 * `canResume()` tells the caller whether a sessionPersistence service is
 * available, and `exists()` probes membership via the persistence service —
 * corruption / unsupported-format / backend failures propagate loudly rather
 * than being misread as "no persistence".
 *
 * Global concurrency gate: at most `maxConcurrency` `create()`/`resume()` calls
 * are in flight at once across all sessions; `get()` (a live lookup) is never
 * limited.
 */
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { ChannelLogger } from '@wsz987/channel-core';
import type { AgentRouteSpec } from './agent-router.js';
import type { SessionBinding } from './session-router.js';

/** A live agent as seen through the gateway (id + drive surface). */
export interface GatewayAgent {
  id: string;
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

/** Minimal port the bridge needs from the Harness agent runtime. */
export interface AgentGateway {
  get(sessionId: string): GatewayAgent | undefined;
  create(sessionId: string, route: AgentRouteSpec): Promise<GatewayAgentHandle>;
  resume(sessionId: string, route: AgentRouteSpec): Promise<GatewayAgentHandle>;
  /** Whether a sessionPersistence service is available (enables resume). */
  canResume(): boolean;
  /** Probe whether a persisted session exists. */
  exists(sessionId: string): Promise<boolean>;
}

/** A resolved agent reference handed to the caller. */
export interface AgentRef {
  sessionId: string;
  route: AgentRouteSpec;
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
 * Probe a persisted session's existence through the persistence service's
 * `list()` membership. A session that is absent returns `false`; any backend
 * failure (corruption, unsupported format, connectivity) propagates loudly.
 */
export class PersistenceMembershipProbe implements PersistenceProbe {
  constructor(private readonly persistence: SessionPersistence | undefined) {}

  async exists(sessionId: string): Promise<boolean> {
    if (!this.persistence) return false;
    const headers = await this.persistence.list();
    const target = sessionId;
    return headers.some((header) => String(header.id) === target);
  }
}

/**
 * Real gateway over `ctx.agents`. This is the only Harness import surface in
 * the bridge (besides the `session/event` feed consumed by ReplyRouter).
 *
 * An optional persistence service (queried by the caller at the use site and
 * passed in) enables `canResume()` and the existence probe.
 */
export class HarnessAgentGateway implements AgentGateway {
  private readonly probe: PersistenceProbe;
  private readonly _hasPersistence: boolean;

  constructor(
    private readonly ctx: Context,
    persistence?: SessionPersistence | undefined,
  ) {
    this.probe = new PersistenceMembershipProbe(persistence);
    this._hasPersistence = persistence !== undefined;
  }

  get(sessionId: string): GatewayAgent | undefined {
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (!agent) return undefined;
    return {
      id: agent.id,
      followup: (message) => agent.followup(message as UserMessage),
      whenIdle: () => agent.whenIdle(),
    };
  }

  canResume(): boolean {
    // Only a mounted sessionPersistence service enables resume.
    return this._hasPersistence;
  }

  async exists(sessionId: string): Promise<boolean> {
    return this.probe.exists(sessionId);
  }

  async create(sessionId: string, route: AgentRouteSpec): Promise<GatewayAgentHandle> {
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: route.preset ? { agentPreset: route.preset } : undefined,
      agentOptions: optionsFor(route),
    });
    return this.wrap(handle);
  }

  async resume(sessionId: string, route: AgentRouteSpec): Promise<GatewayAgentHandle> {
    // Route parity (doc H0.5): resume uses the SAME optionsFor(route) as
    // create. NEVER `model ?? agentId`.
    const handle = await this.ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: optionsFor(route),
    });
    return this.wrap(handle);
  }

  private wrap(handle: AgentHandle): GatewayAgentHandle {
    return {
      id: handle.agent.id,
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
   * Create a NEW agent for a session (no prior binding). Calls
   * `gateway.create` directly (under the concurrency slot), owns the handle,
   * and returns the ref. Never resumes — the caller already decided this is a
   * fresh conversation. Single-flight per session id.
   */
  create(sessionId: string, route: AgentRouteSpec): Promise<AgentRef> {
    if (this.closed) {
      return Promise.reject(new Error(`AgentManager is closed; cannot create '${sessionId}'`));
    }
    const pending = this.inFlight.get(sessionId);
    if (pending) return pending;
    const run = this.doCreate(sessionId, route);
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
  resolve(sessionId: string, route: AgentRouteSpec): Promise<AgentRef> {
    if (this.closed) {
      return Promise.reject(new Error(`AgentManager is closed; cannot resolve '${sessionId}'`));
    }
    const pending = this.inFlight.get(sessionId);
    if (pending) return pending;
    const run = this.doResolve(sessionId, route);
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
   * Live `get` first; on a miss, `gateway.create(route)`. Used by the bridge
   * when resume is not possible (no persistence): borrow the live agent when
   * present, otherwise open a fresh agent on the recorded session id.
   */
  resolveOrCreate(sessionId: string, route: AgentRouteSpec): Promise<AgentRef> {
    if (this.closed) {
      return Promise.reject(new Error(`AgentManager is closed; cannot resolve '${sessionId}'`));
    }
    const pending = this.inFlight.get(sessionId);
    if (pending) return pending;
    const run = this.doResolveOrCreate(sessionId, route);
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

  /** Register the binding associated with a session (reverse reply routing). */
  registerBinding(binding: SessionBinding): void {
    this.bindings.set(binding.sessionId, binding);
  }

  /** Reverse lookup for the ReplyRouter. */
  bindingFor(sessionId: string): SessionBinding | undefined {
    return this.bindings.get(sessionId);
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

  private async doCreate(sessionId: string, route: AgentRouteSpec): Promise<AgentRef> {
    return this.withSlot(async () => {
      const handle = await this.gateway.create(sessionId, route);
      this.owned.set(sessionId, handle);
      return this.makeRef(sessionId, route, handle);
    });
  }

  private async doResolve(sessionId: string, route: AgentRouteSpec): Promise<AgentRef> {
    const live = this.gateway.get(sessionId);
    if (live) {
      return this.makeRef(sessionId, route, live);
    }
    return this.withSlot(async () => {
      const handle = await this.gateway.resume(sessionId, route);
      this.owned.set(sessionId, handle);
      return this.makeRef(sessionId, route, handle);
    });
  }

  private async doResolveOrCreate(sessionId: string, route: AgentRouteSpec): Promise<AgentRef> {
    const live = this.gateway.get(sessionId);
    if (live) {
      return this.makeRef(sessionId, route, live);
    }
    return this.withSlot(async () => {
      const handle = await this.gateway.create(sessionId, route);
      this.owned.set(sessionId, handle);
      return this.makeRef(sessionId, route, handle);
    });
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