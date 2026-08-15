/**
 * Durable outbox target derivation (plan §61).
 *
 * `targetFromBinding` maps a durable `SessionBinding`'s stable identity onto
 * the `ChannelTarget` the adapter sends to. The binding is the durable
 * authority (plan §58), so the target comes from the STORE-resolved binding,
 * never from an in-memory agent cache and never from the incoming message.
 */
import type { ChannelTarget } from '@wsz987/channel-core';
import type { SessionBinding } from '../session-router.js';

/**
 * Derive the outbound `ChannelTarget` for a durable binding (plan §61).
 * Spreads `threadId` only when present; `conversationType` is always carried
 * because the binding requires it (v3, plan §55).
 */
export function targetFromBinding(binding: SessionBinding): ChannelTarget {
  return {
    channelId: binding.channelId as ChannelTarget['channelId'],
    accountId: binding.accountId as ChannelTarget['accountId'],
    conversationId: binding.conversationId as ChannelTarget['conversationId'],
    conversationType: binding.conversationType,
    ...(binding.threadId ? { threadId: binding.threadId as ChannelTarget['threadId'] } : {}),
  };
}
