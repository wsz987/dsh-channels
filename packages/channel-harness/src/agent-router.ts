/**
 * Agent resolution: turn a channel conversation into an agent id.
 *
 * v1 priority (architecture §16 / execution plan Task 4.5):
 * `binding.agentId` > routing override (conversation > account > channel)
 * > `defaultAgentId`. `routing.mode` documents the default-resolution
 * granularity; the override map already encodes per-level values.
 */
import type { Config } from './config.js';

export interface AgentRouteInput {
  channelId: string;
  accountId: string;
  conversationId: string;
  /** Agent previously bound to this conversation, if any. */
  bindingAgentId?: string;
}

export class AgentRouter {
  constructor(private readonly config: Config) {}

  resolve(input: AgentRouteInput): string {
    if (input.bindingAgentId) return input.bindingAgentId;
    const overrides = this.config.routing.overrides;
    if (overrides) {
      const conversationAgent = overrides.conversation?.[input.conversationId];
      if (conversationAgent) return conversationAgent;
      const accountAgent = overrides.account?.[input.accountId];
      if (accountAgent) return accountAgent;
      const channelAgent = overrides.channel?.[input.channelId];
      if (channelAgent) return channelAgent;
    }
    return this.config.defaultAgentId;
  }
}
