/**
 * Session binding: the durable map from a channel conversation to one Harness
 * session.
 *
 * The canonical key is `channel:account:conversation[:thread]` — one account
 * never collapses into one session (architecture §17 / red line 7). The
 * bridge reuses `@dsh/channel-core`'s `conversationKey` so both sides agree
 * on the exact string; branded channel-core identity types only appear on the
 * channel side, so this package works with plain strings.
 */
import { conversationKey, type ChannelConversationKey } from '@dsh/channel-core';

export interface SessionBinding {
  channelId: string;
  accountId: string;
  conversationId: string;
  threadId?: string;
  /** Resolved agent id; a stored value wins over routing overrides. */
  agentId?: string;
  /** The Harness session (agent/session share one id). */
  sessionId: string;
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
