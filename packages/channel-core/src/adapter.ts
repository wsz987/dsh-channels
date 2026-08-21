/**
 * `ChannelAdapter` contract: the stable boundary between a messaging
 * platform and the Channel Core.
 *
 * An adapter maps platform semantics to the Channel Contract and delegates
 * all SDK/package/protocol interaction to an upstream driver. Adapters never
 * call Harness Agent APIs.
 *
 * Streaming may be target-aware: an adapter's *streaming capability* can be
 * static (`capabilities.streaming`) or depend on the concrete reply target via
 * the optional `resolveStreamingMode(target)` hook (e.g. QQ streams natively
 * for C2C with a triggering message id, buffering for groups — but the fields
 * are generic and reused by Telegram reply, Slack thread reply, Lark reply and
 * DingTalk reference).
 */
import type { ChannelAdapterContext } from './context.js';
import type { ChannelCapabilities, StreamingMode } from './capabilities.js';
import { channelAdapterShapeSchema } from './schema.js';
import type { AuthState, ChannelEvent } from './events.js';
import type { ChannelConversationKey, MessageId } from './account.js';
import type { OutboundMessage, SendResult } from './messages.js';
import type { ChannelHealth } from './health.js';

export interface ChannelTarget extends ChannelConversationKey {
  /**
   * Conversation kind of the reply target. Generic capability field — reused
   * by replies whose semantics differ between DMs and groups (e.g. QQ: C2C
   * native streaming vs. group buffered). Not QQ-specific.
   */
  conversationType?: 'dm' | 'group';
  /**
   * Id of the inbound message this reply answers. Lets adapters correlate a
   * reply to the triggering message (Telegram reply, Slack thread reply, Lark
   * reply, DingTalk reference, QQ C2C native streaming all reuse it). Not
   * QQ-specific.
   */
  replyToMessageId?: MessageId;
  /** Raw target data the adapter needs but core does not model. */
  raw?: unknown;
  /**
   * Turn-scoped correlation id shared by every send within one Harness turn.
   * Generic: adapters that correlate outbound sends to a single turn (e.g.
   * Weixin run_id) read it; others ignore it.
   */
  runId?: string;
}

export interface CreateReplyOptions {
  /** Send an initial "working on it" message immediately. */
  placeholder?: string;
  /** Whether reply content may contain markdown. */
  markdown?: boolean;
}

export interface ReplyHandle {
  /** Append a delta to the streaming reply. */
  append(delta: string): Promise<void>;

  /** Replace the whole reply content. */
  replace(message: OutboundMessage): Promise<void>;

  /** Finalize the reply, optionally with a final message. */
  finish(message?: OutboundMessage): Promise<void>;

  /** Mark the reply as failed. */
  fail(error: unknown): Promise<void>;
}

export interface AuthChallenge {
  /** Stable id of this challenge. */
  id: string;
  /** Human-readable instruction for the operator. */
  instruction: string;
  /** Optional QR/login URL for terminal or card rendering. */
  qrUrl?: string;
  /** Optional expiry timestamp. */
  expiresAt?: number;
  /** Adapter-specific payload; never a credential. */
  payload?: unknown;
}

export interface AuthStatePoll {
  state: Exclude<AuthState, 'unknown'>;
  detail?: string;
}

export interface AuthInput {
  kind: 'verification-code';
  value: string;
}

export interface ChannelAdapter {
  readonly id: string;

  readonly capabilities: ChannelCapabilities;

  /**
   * Resolve the streaming mode for one reply target. Adapters whose
   * streaming capability depends on the target (e.g. QQ: C2C + msgId →
   * native, group → buffered) override the static `capabilities.streaming`.
   * Defaults to `capabilities.streaming` when absent.
   */
  resolveStreamingMode?(target: ChannelTarget): StreamingMode;

  start(ctx: ChannelAdapterContext): Promise<void>;

  stop(): Promise<void>;

  send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult>;

  /**
   * Optional in-place edit of an already-sent message (e.g. Telegram
   * `editMessageText` / `editMessageReplyMarkup`, Lark/DingTalk card update).
   * Enables interactive flows that rewrite a single sent message (multi-select
   * toggling, removing stale buttons). Adapters without an edit primitive leave
   * it undefined; the harness must degrade those flows to a non-edit strategy.
   */
  edit?(
    target: ChannelTarget,
    messageId: string,
    message: OutboundMessage,
  ): Promise<SendResult>;

  /**
   * Best-effort typing indicator. Optional: adapters with a typing API (e.g.
   * Weixin sendtyping) implement these; the harness fires them around turn
   * start/end and NEVER lets a failure break reply delivery.
   */
  startTyping?(conversationId: string): Promise<void>;
  stopTyping?(conversationId: string): Promise<void>;
  startTypingForTarget?(target: ChannelTarget): Promise<void>;
  stopTypingForTarget?(target: ChannelTarget): Promise<void>;

  createReply?(target: ChannelTarget, options?: CreateReplyOptions): Promise<ReplyHandle>;

  beginAuth?(): Promise<AuthChallenge>;

  pollAuth?(challenge: AuthChallenge): Promise<AuthStatePoll>;

  submitAuthInput?(challenge: AuthChallenge, input: AuthInput): Promise<void> | void;

  getHealth?(): Promise<ChannelHealth>;
}

/** Emit a message event through the adapter context helper. */
export function isChannelAdapter(value: unknown): value is ChannelAdapter {
  return channelAdapterShapeSchema.safeParse(value).success;
}
