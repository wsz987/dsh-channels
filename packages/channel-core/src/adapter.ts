/**
 * `ChannelAdapter` contract: the stable boundary between a messaging
 * platform and the Channel Core.
 *
 * An adapter maps platform semantics to the Channel Contract and delegates
 * all SDK/package/protocol interaction to an upstream driver. Adapters never
 * call Harness Agent APIs.
 */
import type { ChannelAdapterContext } from './context.js';
import type { ChannelCapabilities } from './capabilities.js';
import type { AuthState, ChannelEvent } from './events.js';
import type { ChannelConversationKey } from './account.js';
import type { OutboundMessage, SendResult } from './messages.js';
import type { ChannelHealth } from './health.js';

export interface ChannelTarget extends ChannelConversationKey {
  /** Raw target data the adapter needs but core does not model. */
  raw?: unknown;
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

export interface ChannelAdapter {
  readonly id: string;

  readonly capabilities: ChannelCapabilities;

  start(ctx: ChannelAdapterContext): Promise<void>;

  stop(): Promise<void>;

  send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult>;

  createReply?(target: ChannelTarget, options?: CreateReplyOptions): Promise<ReplyHandle>;

  beginAuth?(): Promise<AuthChallenge>;

  pollAuth?(challenge: AuthChallenge): Promise<AuthStatePoll>;

  getHealth?(): Promise<ChannelHealth>;
}

/** Convenience factory for third-party adapters. */
export function defineChannelAdapter(adapter: ChannelAdapter): ChannelAdapter {
  return adapter;
}

/** Emit a message event through the adapter context helper. */
export function isChannelAdapter(value: unknown): value is ChannelAdapter {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ChannelAdapter).id === 'string' &&
    typeof (value as ChannelAdapter).start === 'function' &&
    typeof (value as ChannelAdapter).stop === 'function' &&
    typeof (value as ChannelAdapter).send === 'function'
  );
}
