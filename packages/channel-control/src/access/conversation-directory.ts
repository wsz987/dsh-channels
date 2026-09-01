/**
 * ConversationDirectory — observes canonical channel events and maintains the
 * human identifier ↔ canonical conversation id mapping (plan §12).
 *
 * The observer consumes ONLY the canonical event surface
 * (`conversation.id` / `conversation.type` / `conversation.externalId` /
 * `conversation.name`) — it never sees or parses a platform raw payload. The
 * adapter is responsible for having validated `externalId` at its trust
 * boundary.
 *
 * Authorization is untouched by everything in this file: the directory stores
 * identity metadata, and the Access Gate keeps exact-matching the canonical
 * `conversation.id`.
 */
import type { ChannelEvent, ChannelLogger } from '@wsz987/channel-core';
import type { PublicConversationIdentity } from '../types.js';
import type {
  ConversationDirectoryStore,
  ConversationIdentityEntry,
} from './conversation-directory-store.js';

/** Project a stored entry onto the sanitized Web DTO (drops scope bookkeeping). */
export function toPublicConversationIdentity(
  entry: ConversationIdentityEntry,
): PublicConversationIdentity {
  return {
    type: entry.type,
    canonicalId: entry.canonicalId,
    ...(entry.externalId ? { externalId: entry.externalId } : {}),
    ...(entry.displayName ? { displayName: entry.displayName } : {}),
    ...(entry.alias ? { alias: entry.alias } : {}),
    ...(entry.identityConflict ? { identityConflict: true } : {}),
    firstSeenAt: entry.firstSeenAt,
    lastSeenAt: entry.lastSeenAt,
  };
}

export interface ConversationDirectoryOptions {
  store: ConversationDirectoryStore;
  /** Injectable clock (ms since epoch). Defaults to Date.now. */
  now?: () => number;
  logger?: Pick<ChannelLogger, 'warn'>;
}

export class ConversationDirectory {
  private readonly store: ConversationDirectoryStore;
  private readonly now: () => number;
  private readonly logger: Pick<ChannelLogger, 'warn'>;
  /** Serializes read-modify-write cycles per channel+account. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(options: ConversationDirectoryOptions) {
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? { warn: () => {} };
  }

  /**
 * Observe one canonical event. Every group message creates or refreshes its
 * canonical identity; `externalId`, when a platform actually provides one,
 * is optional display metadata only.
   * Never throws — a directory failure must not break the inbound loop.
   */
  observe(
    event: ChannelEvent,
    scopeFingerprint?: string,
    scopeRequired = false,
  ): void {
    if (event.type !== 'message.received') return;
    if (event.conversation.type !== 'group') return;
    // A scope-aware channel without an active provider/application scope must
    // not create an unscoped entry. Unscoped entries remain valid only for
    // channels that do not declare provider scoping at all.
    if (scopeRequired && scopeFingerprint === undefined) return;
    const { channel: channelId, accountId, conversation } = event;
    const key = `${channelId}\u0000${accountId}`;
    const chain = (this.chains.get(key) ?? Promise.resolve())
      .then(() => this.record(
        channelId,
        accountId,
        conversation.id,
        conversation.externalId,
        conversation.name,
        scopeFingerprint,
      ))
      .catch((error) => {
        this.logger.warn(
          `[channel-control] conversation directory observe failed for '${channelId}:${accountId}'`,
          error,
        );
      })
      .finally(() => {
        // Drop the chain once it is the tail so the map does not grow forever.
        if (this.chains.get(key) === chain) this.chains.delete(key);
      });
    this.chains.set(key, chain);
  }

  /** All observed conversation identities for one channel+account. */
  async list(
    channelId: string,
    accountId = 'main',
    scopeFingerprint?: string,
    scopeRequired = false,
  ): Promise<ConversationIdentityEntry[]> {
    const record = await this.store.get(channelId, accountId);
    return Object.values(record?.conversations ?? {})
      // A channel declaring an active provider scope must never resolve an
      // unscoped or differently scoped historical entry. This deliberately
      // makes pre-scope records re-discoverable rather than risking a cross-Bot
      // group_openid reuse after an AppID change.
      .filter((entry) => {
        if (!scopeRequired) return true;
        if (scopeFingerprint === undefined) return false;
        return entry.scopeFingerprint === scopeFingerprint;
      })
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /**
   * Resolve an optional platform-facing identifier to an observed canonical
   * entry. QQ does not use this path: its Web UI selects discovered canonical
   * group OpenIDs directly.
   */
  async resolveByExternalId(
    channelId: string,
    externalId: string | undefined,
    accountId = 'main',
    scopeFingerprint?: string,
    scopeRequired = false,
  ): Promise<ConversationIdentityEntry | undefined> {
    const entries = await this.list(
      channelId,
      accountId,
      scopeFingerprint,
      scopeRequired,
    );
    return entries.find((entry) => entry.externalId === externalId);
  }

  /** Read-modify-write one mapping under the channel+account scope. */
  private async record(
    channelId: string,
    accountId: string,
    canonicalId: string,
    externalId: string | undefined,
    displayName?: string,
    scopeFingerprint?: string,
  ): Promise<void> {
    const record = (await this.store.get(channelId, accountId)) ?? {
      version: 1 as const,
      conversations: {},
    };
    const now = this.now();
    const existing = record.conversations[canonicalId];

    if (!existing) {
      record.conversations[canonicalId] = {
        channelId,
        accountId,
        canonicalId,
        type: 'group',
        ...(externalId ? { externalId } : {}),
        ...(displayName ? { displayName } : {}),
        ...(scopeFingerprint ? { scopeFingerprint } : {}),
        firstSeenAt: now,
        lastSeenAt: now,
      };
    } else {
      const conflict =
        externalId !== undefined &&
        existing.externalId !== undefined &&
        existing.externalId !== externalId;
      record.conversations[canonicalId] = {
        ...existing,
        ...(externalId ? { externalId } : {}),
        ...(displayName ? { displayName } : {}),
        ...(scopeFingerprint ? { scopeFingerprint } : {}),
        ...(conflict ? { identityConflict: true } : {}),
        lastSeenAt: now,
      };
    }

    await this.store.set(channelId, accountId, record);
  }

}
