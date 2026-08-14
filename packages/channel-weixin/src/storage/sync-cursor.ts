/**
 * SyncCursorStore — persists the `get_updates_buf` sync cursor.
 *
 * Per doc section 18: the cursor is persisted ONLY AFTER the messages of the
 * round have entered the Channel inbound pipeline. If we crash before the
 * commit, the same messages may be re-fetched — that is accepted and handled
 * by the dedup layer.
 */
import type { ChannelStorage } from '@wsz987/channel-core';

export interface SyncCursorStoreOptions {
  storage: ChannelStorage;
  /** Local DSH account alias. */
  accountId?: string;
}

export class SyncCursorStore {
  private readonly storage: ChannelStorage;
  private readonly accountId: string;

  constructor(options: SyncCursorStoreOptions) {
    this.storage = options.storage;
    this.accountId = options.accountId ?? 'main';
  }

  private key(): string {
    return `weixin:sync-cursor:${this.accountId}`;
  }

  /** Load the persisted cursor (empty string when none). */
  async load(): Promise<string> {
    const raw = await this.storage.get(this.key());
    return raw ?? '';
  }

  /** Atomically persist a new cursor. */
  async set(cursor: string): Promise<void> {
    await this.storage.set(this.key(), cursor ?? '');
  }

  /** Clear the cursor (e.g. on re-auth). */
  async clear(): Promise<void> {
    await this.storage.delete(this.key());
  }
}
