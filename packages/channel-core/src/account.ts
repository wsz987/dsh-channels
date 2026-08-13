/**
 * Identity types shared by every channel.
 *
 * All identities are branded strings so that a `ConversationId` cannot be
 * silently passed where a `MessageId` is expected. Adapters are responsible
 * for mapping platform-native ids into these types.
 */

/** Channel id, e.g. `'weixin'`, `'qq'`, `'dingtalk'`, `'lark'`. */
export type ChannelId = string & { readonly __brand: 'ChannelId' };

/** Account id within a channel, e.g. `'main'`, `'bot01'`, `'corpA'`. */
export type AccountId = string & { readonly __brand: 'AccountId' };

/** Conversation id within a channel account. */
export type ConversationId = string & { readonly __brand: 'ConversationId' };

/** Optional thread id within a conversation. */
export type ThreadId = string & { readonly __brand: 'ThreadId' };

/** Platform message id, used for dedup and reply correlation. */
export type MessageId = string & { readonly __brand: 'MessageId' };

/** Platform sender id. */
export type SenderId = string & { readonly __brand: 'SenderId' };

/** Key identifying one conversation binding target. */
export interface ChannelConversationKey {
  channelId: ChannelId;
  accountId: AccountId;
  conversationId: ConversationId;
  threadId?: ThreadId;
}

/**
 * Canonical string form of a conversation key:
 * `channel:account:conversation[:thread]`.
 *
 * Never allowed to collapse a whole account into one session — each
 * conversation (and optionally thread) is a distinct key.
 */
export function conversationKey(key: ChannelConversationKey): string {
  return key.threadId
    ? `${key.channelId}:${key.accountId}:${key.conversationId}:${key.threadId}`
    : `${key.channelId}:${key.accountId}:${key.conversationId}`;
}
