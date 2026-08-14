/**
 * AgentManager — the single place that touches `ctx.agents`.
 *
 * Ownership model (red line 8 / architecture §16):
 * - `ctx.agents.get()` returns a live agent the bridge does NOT own — it is
 *   never disposed here.
 * - `ctx.agents.create()` / `ctx.agents.resume()` return an `AgentHandle`;
 *   the bridge MUST hold every handle it created/resumed and dispose it on
 *   plugin unload. Owned handles live in `owned` and are disposed exactly
 *   once by `disposeAll()`.
 *
 * Per-session single-flight: concurrent `create()`/`resolve()` for the same
 * session id share one in-flight promise, so create/resume never races with
 * itself.
 *
 * Create/resume is decided by the CALLER (the bridge), not by error-regex
 * fallback:
 * - `create(sessionId, agentId)` — a NEW conversation with no prior binding;
 *   calls `gateway.create` directly and owns the handle.
 * - `resolve(sessionId, agentId)` — an EXISTING conversation; live `get`
 *   first, then `gateway.resume`; a resume failure propagates loudly (throws)
 *   and is never silently downgraded to create.
 *
 * Global concurrency gate: at most `maxConcurrency` `create()`/`resume()`
 * calls are in flight at once across all sessions (`get()` is never
 * limited); a call that needs a slot queues until one frees.
 *
 * `AgentGateway` is the minimal port abstraction so tests can run the whole
 * pipeline against a fake instead of a real Harness agent loop.
 */
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import type { ChannelLogger } from '@dsh/channel-core';
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

/** Minimal port the bridge needs from the Harness agent runtime. */
export interface AgentGateway {
  get(sessionId: string): GatewayAgent | undefined;
  create(sessionId: string, agentId: string): Promise<GatewayAgentHandle>;
  resume(sessionId: string): Promise<GatewayAgentHandle>;
  supportsResume: boolean;
}

/** A resolved agent reference handed to the caller. */
export interface AgentRef {
  sessionId: string;
  agentId: string;
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
  /**
   * Marks the caller done with the ref. Simple v1 semantics: the ref never
   * disposes the underlying handle itself — the manager owns lifecycle and
   * disposes each handle exactly once during `disposeAll()`.
   */
  release(): void;
}

/**
 * Real gateway over `ctx.agents`. This is the only Harness import surface in
 * the bridge (besides the `session/event` feed consumed by ReplyRouter).
 */
export class HarnessAgentGateway implements AgentGateway {
  readonly supportsResume = true;

  constructor(
    private readonly ctx: Context,
    private readonly agentOptions?: { provider?: string; model?: string },
  ) {}

  get(sessionId: string): GatewayAgent | undefined {
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (!agent) return undefined;
    return {
      id: agent.id,
      followup: (message) => agent.followup(message as UserMessage),
      whenIdle: () => agent.whenIdle(),
    };
  }

  async create(sessionId: string, agentId: string): Promise<GatewayAgentHandle> {
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      agentOptions: this.agentOptionsFor(agentId),
    });
    return this.wrap(handle);
  }

  async resume(sessionId: string): Promise<GatewayAgentHandle> {
    const handle = await this.ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
    });
    return this.wrap(handle);
  }

  private agentOptionsFor(agentId: string): AgentOptions | undefined {
    if (!this.agentOptions) return undefined;
    const options: AgentOptions = {};
    if (this.agentOptions.provider) options.provider = this.agentOptions.provider;
    options.model = this.agentOptions.model ?? agentId;
    return options;
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
  /**
   * Global concurrency gate over the expensive gateway operations
   * (`create`/`resume`). At most `maxConcurrency` of them are in flight at
   * once; `get()` (live lookup) is never limited. `Config.maxConcurrency`
   * (default 4) feeds this value.
   */
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

  get supportsResume(): boolean {
    return this.gateway.supportsResume;
  }

  /**
   * Create a NEW agent for a session (no prior binding). Calls
   * `gateway.create` directly (under the concurrency slot), owns the handle,
   * and returns the ref. Never resumes — the caller already decided this is a
   * fresh conversation. Single-flight per session id.
   */
  create(sessionId: string, agentId: string): Promise<AgentRef> {
    if (this.closed) {
      return Promise.reject(new Error(`AgentManager is closed; cannot create '${sessionId}'`));
    }
    const pending = this.inFlight.get(sessionId);
    if (pending) return pending;
    const run = this.doCreate(sessionId, agentId);
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
   * Resolve an agent for an EXISTING session: live `get` first; on a miss,
   * `gateway.resume`. A resume failure propagates loudly (throws) — never
   * falls back to create and never sniffs error messages. Single-flight per
   * session id.
   */
  resolve(sessionId: string, agentId: string): Promise<AgentRef> {
    if (this.closed) {
      return Promise.reject(new Error(`AgentManager is closed; cannot resolve '${sessionId}'`));
    }
    const pending = this.inFlight.get(sessionId);
    if (pending) return pending;
    const run = this.doResolve(sessionId, agentId);
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
    // Wake every queued concurrency waiter; each one re-checks `closed`
    // and rejects its resolve with a clear "closed" error.
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
   * write failed afterward). No-op for handles the manager does not own (a
   * `get()`-obtained live agent is never disposed).
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

  private async doCreate(sessionId: string, agentId: string): Promise<AgentRef> {
    // `create` is an expensive gateway operation: gate it so at most
    // `maxConcurrency` are in flight at once across all sessions.
    return this.withSlot(async () => {
      const handle = await this.gateway.create(sessionId, agentId);
      this.owned.set(sessionId, handle);
      return this.makeRef(sessionId, agentId, handle);
    });
  }

  private async doResolve(sessionId: string, agentId: string): Promise<AgentRef> {
    const live = this.gateway.get(sessionId);
    if (live) {
      return this.makeRef(sessionId, agentId, live);
    }
    // `resume` is an expensive gateway operation: gate it so at most
    // `maxConcurrency` are in flight at once across all sessions.
    return this.withSlot(async () => {
      // Resume failure propagates loudly — no create fallback, no message
      // sniffing. An existing binding means the session existed before; a
      // failed resume must surface so a corrupt/lost session is never silently
      // replaced with a fresh one.
      const handle = await this.gateway.resume(sessionId);
      this.owned.set(sessionId, handle);
      return this.makeRef(sessionId, agentId, handle);
    });
  }

  /**
   * Counting semaphore: acquire one of the `maxConcurrency` gateway slots
   * before running `fn`, releasing it when `fn` settles. A `resolve()` that
   * finds all slots busy queues until one frees; `disposeAll()` wakes queued
   * waiters with a "closed" rejection.
   */
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

  private makeRef(sessionId: string, agentId: string, agent: GatewayAgent): AgentRef {
    const ref: AgentRef = {
      sessionId,
      agentId,
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
