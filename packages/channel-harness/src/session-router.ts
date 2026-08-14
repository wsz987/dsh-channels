/**
 * Session binding: the durable map from a channel conversation to one Harness
 * session (doc H0.3).
 *
 * The canonical key is `channel:account:conversation[:thread]` — one account
 * never collapses into one session. The bridge reuses `@dsh/channel-core`'s
 * `conversationKey` so both sides agree on the exact string; branded
 * channel-core identity types only appear on the channel side, so this package
 * works with plain strings.
 *
 * v2: the binding carries `sessionId` (the unique Agent/Session runtime
 * identity — Harness Agent identity IS `SessionId`) plus a `route` snapshot
 * used to keep create/resume parity, and `schemaVersion: 2`. The old v1
 * `agentId` field has been removed (migrated to `route.model` by
 * `binding-store`).
 */
import { conversationKey, type ChannelConversationKey } from '@dsh/channel-core';
import type { AgentRouteSpec } from './agent-router.js';

export const SESSION_BINDING_SCHEMA_VERSION = 2 as const;

export interface SessionBinding {
  channelId: string;
  accountId: string;
  conversationId: string;
  threadId?: string;
  /** Unique Agent/Session runtime identity (Harness Agent id === SessionId). */
  sessionId: string;
  /** Routing snapshot used for create/resume parity. */
  route: AgentRouteSpec;
  schemaVersion: typeof SESSION_BINDING_SCHEMA_VERSION;
  createdAt: number;
  updatedAt: number;
}

export interface SessionKeyInput {
  channelId: string;
  accountId: string;
  conversationId: string;
  threadId?: string;
}

/** Canonical binding key: `channel:account:conversation[:thread]`. */
export function sessionKey(conversation: SessionKeyInput): string {
  const key: ChannelConversationKey = {
    channelId: conversation.channelId as ChannelConversationKey['channelId'],
    accountId: conversation.accountId as ChannelConversationKey['accountId'],
    conversationId: conversation.conversationId as ChannelConversationKey['conversationId'],
  };
  if (conversation.threadId) {
    key.threadId = conversation.threadId as ChannelConversationKey['threadId'];
  }
  return conversationKey(key);
}

/** Key under which a binding is stored (derived from its own fields). */
export function bindingKey(binding: SessionBinding): string {
  return sessionKey(binding);
}
