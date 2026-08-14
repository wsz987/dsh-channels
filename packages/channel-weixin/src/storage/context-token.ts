/**
 * ContextTokenStore — keyed by `accountId + peerId` -> `context_token`.
 *
 * Set on receive (from the inbound message's `from_user_id` + `context_token`),
 * read on send so the reply carries the correct context. `channel-harness`
 * never sees the context token — it is entirely internal to this adapter.
 */
import type { ChannelStorage } from '@dsh/channel-core';

export interface ContextTokenStoreOptions {
  storage: ChannelStorage;
  /** Local DSH account alias. */
  accountId?: string;
}

export class ContextTokenStore {
  private readonly storage: ChannelStorage;
  private readonly accountId: string;

  constructor(options: ContextTokenStoreOptions) {
    this.storage = options.storage;
    this.accountId = options.accountId ?? 'main';
  }

  private key(peerId: string): string {
    return `weixin:context-token:${this.accountId}:${peerId}`;
  }

  /** Record the context token for a peer. */
  async set(peerId: string, contextToken: string): Promise<void> {
    if (!contextToken) return;
    await this.storage.set(this.key(peerId), contextToken);
  }

  /** Look up the context token for a peer (undefined when none). */
  async get(peerId: string): Promise<string | undefined> {
    return this.storage.get(this.key(peerId));
  }

  /** Clear token(s) for a peer. */
  async clear(peerId: string): Promise<void> {
    await this.storage.delete(this.key(peerId));
  }
}
