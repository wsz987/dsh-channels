/**
 * Channel events flowing from an adapter up to the ChannelService.
 *
 * First release actually emits `message.received`, `auth.changed` and
 * `connection.changed`; the remaining variants are stabilized for the future
 * channel ecosystem.
 */
import type {
  ChannelId,
  AccountId,
  ConversationId,
  ThreadId,
  SenderId,
  MessageId,
} from './account.js';
import type { MessagePart } from './messages.js';
import type { MessageActivation } from './access.js';

export interface ConversationRef {
  id: ConversationId;
  type: 'dm' | 'group';
  threadId?: ThreadId;
}

export interface SenderRef {
  id: SenderId;
  name?: string;
}

export interface MessageRef {
  id: MessageId;
  content: MessagePart[];
  replyTo?: MessageId;
  createdAt?: number;
  /**
   * Activation facts computed by the adapter at the trust boundary (e.g.
   * `mentionedBot`). The Harness Access Gate reads these — never `raw`.
   */
  activation?: MessageActivation;
}

/** A user message received from a messaging platform. */
export interface MessageReceived {
  type: 'message.received';

  channel: ChannelId;
  accountId: AccountId;

  conversation: ConversationRef;
  sender: SenderRef;

  message: MessageRef;

  /** Debug/extension payload. Core and the bridge never depend on its shape. */
  raw?: unknown;
}

/** A reaction to a message. */
export interface ReactionReceived {
  type: 'reaction.received';

  channel: ChannelId;
  accountId: AccountId;

  conversation: ConversationRef;
  sender: SenderRef;
  messageId: MessageId;
  emoji: string;
  added: boolean;

  raw?: unknown;
}

/** An interactive callback (e.g. card button press). */
export interface InteractionReceived {
  type: 'interaction.received';

  channel: ChannelId;
  accountId: AccountId;

  conversation: ConversationRef;
  sender: SenderRef;
  interactionId: string;
  action: string;
  value?: unknown;

  raw?: unknown;
}

export interface MemberJoined {
  type: 'member.joined';

  channel: ChannelId;
  accountId: AccountId;

  conversation: ConversationRef;
  member: SenderRef;
  inviter?: SenderRef;

  raw?: unknown;
}

export interface MemberLeft {
  type: 'member.left';

  channel: ChannelId;
  accountId: AccountId;

  conversation: ConversationRef;
  member: SenderRef;

  raw?: unknown;
}

export interface ConversationUpdated {
  type: 'conversation.updated';

  channel: ChannelId;
  accountId: AccountId;

  conversation: ConversationRef;
  changes: string[];

  raw?: unknown;
}

export type AuthState = 'unknown' | 'pending' | 'authenticated' | 'expired' | 'failed';

/** Auth status changed (QR scanned, token refreshed, token expired, ...). */
export interface AuthChanged {
  type: 'auth.changed';

  channel: ChannelId;
  accountId: AccountId;

  state: AuthState;
  /** Human-readable detail for diagnostics; never a credential. */
  detail?: string;

  raw?: unknown;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

/** Connection status changed (WS opened, heartbeat lost, reconnect, ...). */
export interface ConnectionChanged {
  type: 'connection.changed';

  channel: ChannelId;
  accountId: AccountId;

  state: ConnectionState;
  /** Reconnect attempt number, when applicable. */
  attempt?: number;

  raw?: unknown;
}

/** Any channel event emitted by an adapter. */
export type ChannelEvent =
  | MessageReceived
  | ReactionReceived
  | InteractionReceived
  | MemberJoined
  | MemberLeft
  | ConversationUpdated
  | AuthChanged
  | ConnectionChanged;
