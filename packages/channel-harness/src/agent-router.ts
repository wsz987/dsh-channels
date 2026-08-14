/**
 * Agent routing (doc H0.1/H0.2 / §30): turn a channel conversation into an
 * `AgentRouteSpec` — a routing snapshot, NOT an identity.
 *
 * Harness Agent identity is the `SessionId` (shared between the agent and its
 * session), so there is no runtime `agentId` parallel to it. A route only
 * describes how to drive the session's agent: an optional Harness preset
 * (`meta.agentPreset`) and/or provider/model/maxTokens (`agentOptions`).
 *
 * Resolution priority: routing override (conversation > account > channel) >
 * `config.agent.default`.
 */
import type { Config } from './config.js';

/** How a session's agent should be driven. Never an identity. */
export interface AgentRouteSpec {
  /** Harness Agent preset, composed into the session's world — NOT identity. */
  preset?: string;
  /** Optional provider route. */
  provider?: string;
  /** Optional model id interpreted by the provider adapter. */
  model?: string;
  /** Optional max output tokens per request. */
  maxTokens?: number;
}

export interface AgentRouteInput {
  channelId: string;
  accountId: string;
  conversationId: string;
}

/** Compare two routes structurally (used to detect binding route drift). */
export function routesEqual(a: AgentRouteSpec | undefined, b: AgentRouteSpec | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.preset === b.preset &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.maxTokens === b.maxTokens
  );
}

export class AgentRouter {
  constructor(private readonly config: Config) {}

  resolve(input: AgentRouteInput): AgentRouteSpec {
    const overrides = this.config.routing.overrides;
    if (overrides) {
      const conversationAgent = overrides.conversation?.[input.conversationId];
      if (conversationAgent) return conversationAgent;
      const accountAgent = overrides.account?.[input.accountId];
      if (accountAgent) return accountAgent;
      const channelAgent = overrides.channel?.[input.channelId];
      if (channelAgent) return channelAgent;
    }
    return this.config.agent.default;
  }
}
