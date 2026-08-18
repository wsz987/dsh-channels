/**
 * Session binding: the durable map from a channel conversation to one Harness
 * session (doc H0.3).
 *
 * The canonical key is `channel:account:conversation[:thread]` — one account
 * never collapses into one session. The bridge reuses `@wsz987/channel-core`'s
 * `conversationKey` so both sides agree on the exact string; branded
 * channel-core identity types only appear on the channel side, so this package
 * works with plain strings.
 *
 * v3 (plan \u00a755): the binding carries the FULL stable conversation identity the
 * durable outbox needs — `conversationType: 'dm' | 'group'` (required) and the
 * optional `senderId` of the peer behind a DM. It also keeps `sessionId` (the
 * unique Agent/Session runtime identity — Harness Agent identity IS
 * `SessionId`) plus a `route` snapshot used to keep create/resume parity, an
 * optional stable `durability` policy, and `schemaVersion: 3`.
 *
 * v3 persists ONLY stable identity (plan \u00a756): channel / account /
 * conversation / type / thread / sender / session / durability / route. Transient platform
 * state is NEVER stored here — `sessionWebhook`, `replyToMessageId`,
 * `runId`, `contextToken`, a media URL and an AES key all travel only with the
 * triggering turn (see `reply-context-store`), never in a binding.
 *
 * The old v1 `agentId` field has been removed (migrated to `route.model` by
 * `binding-store`, then v2 -> v3 adds the legacy-default `conversationType`).
 */
import { conversationKey, type ChannelConversationKey } from '@wsz987/channel-core';
import type { AgentRouteSpec } from './agent-router.js';

export const SESSION_BINDING_SCHEMA_VERSION = 3 as const;

/** Stable policy recorded with a binding; it is independent of live service availability. */
export type SessionDurability = 'ephemeral' | 'durable';

export interface SessionBinding {
  channelId: string;
  accountId: string;
  conversationId: string;
  /** `dm` = a one-to-one conversation, `group` = a group/chat (plan \u00a755). Required since v3. */
  conversationType: 'dm' | 'group';
  threadId?: string;
  /** Optional stable peer id behind a DM; group conversations usually omit it. */
  senderId?: string;
  /** Unique Agent/Session runtime identity (Harness Agent id === SessionId). */
  sessionId: string;
  /**
   * Whether this binding is expected to survive process restarts. Optional for
   * pre-durability bindings; consumers treat an omitted value as durable so a
   * temporarily unavailable persistence service cannot trigger recreation.
   */
  durability?: SessionDurability;
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
  conversationType?: 'dm' | 'group';
  senderId?: string;
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
