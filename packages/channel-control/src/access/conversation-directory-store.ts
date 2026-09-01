/**
 * Conversation Identity Directory — durable store for the
 * discovered canonical conversation identities plus optional display metadata.
 *
 * This is identity METADATA only (plan §13). It must never contain message
 * content, attachments, raw events, secrets, or any authorization state: the
 * Access Gate keeps exact-matching `conversation.id`; the directory only lets
 * the Web choose previously observed group OpenIDs for policy authoring.
 *
 * Records are keyed per `channelId + accountId` (plan §24/§25), so identities
 * observed under account A can never leak into account B.
 */
import type { ChannelStorage } from '@wsz987/channel-core';
import { z } from 'zod';

/** One observed conversation identity (plan §6). */
export interface ConversationIdentityEntry {
  channelId: string;
  accountId: string;
  /**
   * Runtime canonical conversation id (QQ group: `group_openid`) — the only
   * authorization key.
   */
  canonicalId: string;
  type: 'group';
  /**
   * Optional human/platform-facing identifier. Display metadata only — never
   * an authorization key.
   */
  externalId?: string;
  /** Human-readable title observed by the adapter, when the platform provides one. */
  displayName?: string;
  /** Local, operator-facing alias. */
  alias?: string;
  /** Opaque non-secret provider/application scope; never part of the Web DTO. */
  scopeFingerprint?: string;
  /**
   * Set when the same canonicalId was later observed with a DIFFERENT
   * externalId (plan §23). The latest externalId is kept and the conflict is
   * surfaced for re-confirmation; authorization is never changed by it.
   */
  identityConflict?: boolean;
  firstSeenAt: number;
  lastSeenAt: number;
}

/** Stored record shape under one channel+account (versioned, plan §25). */
export interface ConversationDirectoryRecord {
  version: 1;
  conversations: Record<string, ConversationIdentityEntry>;
}

const entrySchema = z.object({
  channelId: z.string().min(1),
  accountId: z.string().min(1),
  canonicalId: z.string().min(1),
  type: z.literal('group'),
  externalId: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  alias: z.string().min(1).optional(),
  scopeFingerprint: z.string().min(1).optional(),
  identityConflict: z.boolean().optional(),
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
}).loose();

const recordSchema = z.object({
  version: z.literal(1),
  conversations: z.record(z.string().min(1), entrySchema),
}, {
  error: 'conversation directory record must be a v1 record',
});

function parseRecord(raw: string): ConversationDirectoryRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Durable conversation-directory store abstraction. */
export interface ConversationDirectoryStore {
  get(channelId: string, accountId: string): Promise<ConversationDirectoryRecord | undefined>;
  set(channelId: string, accountId: string, record: ConversationDirectoryRecord): Promise<void>;
}

/**
 * Storage key for one channel+account's directory record. Scoped to the
 * channel-control domain — consumers outside this package (web) go through the
 * control API, never this key format.
 */
export function conversationDirectoryStorageKey(channelId: string, accountId: string): string {
  return `conversation-directory:v1:${encodeURIComponent(channelId)}:${encodeURIComponent(accountId)}`;
}

/** Durable store backed by the shared channel-domain [ChannelStorage]. */
export class ChannelStorageConversationDirectoryStore implements ConversationDirectoryStore {
  private readonly getStorage: () => ChannelStorage;

  constructor(getStorage: () => ChannelStorage) {
    this.getStorage = getStorage;
  }

  async get(channelId: string, accountId: string): Promise<ConversationDirectoryRecord | undefined> {
    const raw = await this.getStorage().get(conversationDirectoryStorageKey(channelId, accountId));
    if (raw === undefined) return undefined;
    return parseRecord(raw);
  }

  async set(channelId: string, accountId: string, record: ConversationDirectoryRecord): Promise<void> {
    await this.getStorage().set(
      conversationDirectoryStorageKey(channelId, accountId),
      JSON.stringify(record),
    );
  }
}

/** In-memory store (tests / transient default); state is lost on restart. */
export class MemoryConversationDirectoryStore implements ConversationDirectoryStore {
  private readonly values = new Map<string, ConversationDirectoryRecord>();

  async get(channelId: string, accountId: string): Promise<ConversationDirectoryRecord | undefined> {
    return this.values.get(conversationDirectoryStorageKey(channelId, accountId));
  }

  async set(channelId: string, accountId: string, record: ConversationDirectoryRecord): Promise<void> {
    this.values.set(conversationDirectoryStorageKey(channelId, accountId), record);
  }
}
