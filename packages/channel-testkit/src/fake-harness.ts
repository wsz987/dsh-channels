/**
 * FakeHarness — an in-memory simulation of the minimal Harness bridge port.
 *
 * Per the execution plan (Task 3.5), this deliberately does NOT copy the
 * Harness runtime. It only implements the tiny port channel-harness will
 * consume, so the testkit never depends on Harness internals:
 *
 * - `resolveAgent(sessionId)`  → stable agent id per session + dispose
 * - `followup(agentId, input)`  → push agent input
 * - `streamEvents(sessionId, listener)` → session event stream (with disposer)
 */
export interface FakeAgentRef {
  /** Stable agent id assigned to a session. */
  id: string;
  /** Number of `followup()` calls routed to this agent. */
  followupCount: number;
  /** Last followup input received by the agent. */
  lastInput?: unknown;
  /** Whether the agent has been disposed. */
  disposed: boolean;
  /** The session this agent is bound to. */
  sessionId: string;
}

/** Resolved agent handle returned by `HarnessPort.resolveAgent()`. */
export interface ResolvedAgentRef {
  id: string;
  dispose(): Promise<void>;
}

/**
 * The minimal port channel-harness (and third-party channels) can depend on.
 * It is intentionally tiny and Harness-agnostic: the testkit (and anything
 * built on it) never imports Harness internals.
 */
export interface HarnessPort {
  resolveAgent(sessionId: string): Promise<ResolvedAgentRef>;
  followup(agentId: string, input: unknown): Promise<void>;
  streamEvents(sessionId: string, listener: (event: unknown) => void): () => void;
}

/** A session event delivered (or recorded) by the fake harness. */
export interface FakeStreamEvent {
  sessionId: string;
  event: unknown;
}

export interface FakeHarnessOptions {
  /** Agent id prefix; defaults to `'agent'`. */
  agentPrefix?: string;
}

/**
 * Fully in-memory `HarnessPort`. Sessions resolve to stable agents, followups
 * are recorded against the agent, and session events can be produced with
 * `emitSessionEvent()` and observed through `streamEvents()`.
 */
export class FakeHarness implements HarnessPort {
  readonly agentPrefix: string;

  /** Every agent ever created, in creation order. */
  readonly agents: FakeAgentRef[] = [];
  /** Every followup routed through the port. */
  readonly followups: { agentId: string; input: unknown }[] = [];
  /** Active session event subscriptions. */
  readonly streams: { sessionId: string; listener: (event: unknown) => void }[] = [];
  /** Every session event emitted (delivered or not). */
  readonly events: FakeStreamEvent[] = [];

  private readonly sessions = new Map<string, FakeAgentRef>();
  private counter = 0;

  constructor(options: FakeHarnessOptions = {}) {
    this.agentPrefix = options.agentPrefix ?? 'agent';
  }

  async resolveAgent(sessionId: string): Promise<ResolvedAgentRef> {
    let ref = this.sessions.get(sessionId);
    if (!ref) {
      ref = {
        id: `${this.agentPrefix}-${++this.counter}`,
        followupCount: 0,
        disposed: false,
        sessionId,
      };
      this.sessions.set(sessionId, ref);
      this.agents.push(ref);
    }
    return {
      id: ref.id,
      dispose: async () => {
        ref.disposed = true;
        this.sessions.delete(sessionId);
      },
    };
  }

  async followup(agentId: string, input: unknown): Promise<void> {
    const ref = this.agents.find((agent) => agent.id === agentId);
    if (!ref) {
      throw new Error(`FakeHarness: unknown agent '${agentId}'`);
    }
    ref.followupCount += 1;
    ref.lastInput = input;
    this.followups.push({ agentId, input });
  }

  streamEvents(sessionId: string, listener: (event: unknown) => void): () => void {
    const stream = { sessionId, listener };
    this.streams.push(stream);
    return () => {
      const index = this.streams.indexOf(stream);
      if (index >= 0) this.streams.splice(index, 1);
    };
  }

  /** Produce a session event and deliver it to matching active subscriptions. */
  emitSessionEvent(sessionId: string, event: unknown): void {
    this.events.push({ sessionId, event });
    for (const stream of this.streams) {
      if (stream.sessionId === sessionId) stream.listener(event);
    }
  }

  /** Look up the agent bound to a session, if any. */
  agent(sessionId: string): FakeAgentRef | undefined {
    return this.sessions.get(sessionId);
  }
}
