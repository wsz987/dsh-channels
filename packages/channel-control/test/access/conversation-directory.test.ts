/**
 * ConversationDirectory tests: observation dedup, lastSeenAt refresh,
 * account/channel isolation, externalId drift marking, resolveByExternalId,
 * and the durability of the ChannelStorage-backed store.
 */
import { describe, expect, it } from 'vitest';
import { MemoryStorage, type ChannelStorage, type ChannelEvent } from '@wsz987/channel-core';
import {
  ChannelStorageConversationDirectoryStore,
  conversationDirectoryStorageKey,
  MemoryConversationDirectoryStore,
} from '../../src/access/conversation-directory-store.js';
import { ConversationDirectory } from '../../src/access/conversation-directory.js';

function groupMessage(overrides: {
  channel?: string;
  account?: string;
  canonicalId?: string;
  externalId?: string;
  name?: string;
}): ChannelEvent {
  return {
    type: 'message.received',
    channel: overrides.channel ?? 'qq',
    accountId: overrides.account ?? 'main',
    conversation: {
      id: (overrides.canonicalId ?? 'OPEN_A') as never,
      type: 'group',
      ...(overrides.externalId ? { externalId: overrides.externalId } : {}),
      ...(overrides.name ? { name: overrides.name } : {}),
    },
    sender: { id: 'member_1' },
    message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] },
  } as ChannelEvent;
}

function flush(): Promise<void> {
  // observe() chains promises; one macrotask lets the queue drain.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ConversationDirectory', () => {
  it('records a group externalId mapping and dedups repeated observations', async () => {
    const directory = new ConversationDirectory({ store: memoryStore(), now: () => 1000 });
    directory.observe(groupMessage({ externalId: '123456789' }));
    await flush();
    directory.observe(groupMessage({ externalId: '123456789' }));
    await flush();

    const entries = await directory.list('qq', 'main');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      channelId: 'qq',
      accountId: 'main',
      canonicalId: 'OPEN_A',
      externalId: '123456789',
      firstSeenAt: 1000,
      lastSeenAt: 1000,
    });
  });

  it('updates lastSeenAt on re-observation without duplicating rows', async () => {
    let clock = 1000;
    const directory = new ConversationDirectory({ store: memoryStore(), now: () => clock });
    directory.observe(groupMessage({ externalId: '123456789' }));
    await flush();
    clock = 5000;
    directory.observe(groupMessage({ externalId: '123456789' }));
    await flush();

    const entries = await directory.list('qq', 'main');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.firstSeenAt).toBe(1000);
    expect(entries[0]!.lastSeenAt).toBe(5000);
  });

  it('ignores dm messages but records groups by canonical id without an externalId', async () => {
    const directory = new ConversationDirectory({ store: memoryStore(), now: () => 1000 });
    const dm = {
      ...groupMessage({}),
      conversation: { id: 'user_1' as never, type: 'dm' as never },
    } as ChannelEvent;
    directory.observe(dm);
    directory.observe(groupMessage({ canonicalId: 'OPEN_GROUP' }));
    await flush();

    expect(await directory.list('qq', 'main')).toMatchObject([
      { canonicalId: 'OPEN_GROUP', type: 'group' },
    ]);
  });

  it('records each observed group OpenID as a distinct recent conversation', async () => {
    const directory = new ConversationDirectory({ store: memoryStore(), now: () => 1000 });
    directory.observe(groupMessage({ canonicalId: 'OPEN_GROUP_A' }));
    directory.observe(groupMessage({ canonicalId: 'OPEN_GROUP_B' }));
    await flush();

    expect((await directory.list('qq', 'main')).map((entry) => entry.canonicalId).sort()).toEqual([
      'OPEN_GROUP_A',
      'OPEN_GROUP_B',
    ]);
  });

  it('isolates records per channel and account', async () => {
    const directory = new ConversationDirectory({ store: memoryStore(), now: () => 1000 });
    directory.observe(groupMessage({ channel: 'qq', account: 'main', canonicalId: 'OPEN_A', externalId: '1' }));
    directory.observe(groupMessage({ channel: 'qq', account: 'bot2', canonicalId: 'OPEN_B', externalId: '1' }));
    directory.observe(groupMessage({ channel: 'telegram', account: 'main', canonicalId: 'OPEN_C', externalId: '1' }));
    await flush();

    const main = await directory.list('qq', 'main');
    expect(main).toHaveLength(1);
    expect(main[0]!.canonicalId).toBe('OPEN_A');

    const bot2 = await directory.list('qq', 'bot2');
    expect(bot2).toHaveLength(1);
    expect(bot2[0]!.canonicalId).toBe('OPEN_B');

    const telegram = await directory.list('telegram', 'main');
    expect(telegram).toHaveLength(1);
    expect(telegram[0]!.canonicalId).toBe('OPEN_C');
  });

  it('filters mappings by the active provider scope, fail-closed for legacy unscoped entries', async () => {
    const directory = new ConversationDirectory({ store: memoryStore(), now: () => 1000 });
    directory.observe(groupMessage({ canonicalId: 'OPEN_OLD', externalId: '123456789' }));
    directory.observe(groupMessage({ canonicalId: 'OPEN_A', externalId: '123456789' }), 'bot-a');
    directory.observe(groupMessage({ canonicalId: 'OPEN_B', externalId: '123456789' }), 'bot-b');
    await flush();

    expect((await directory.list('qq', 'main', 'bot-a', true)).map((entry) => entry.canonicalId)).toEqual(['OPEN_A']);
    expect((await directory.list('qq', 'main', 'bot-b', true)).map((entry) => entry.canonicalId)).toEqual(['OPEN_B']);
    expect(await directory.resolveByExternalId('qq', '123456789', 'main', 'bot-a', true))
      .toMatchObject({ canonicalId: 'OPEN_A' });
    expect(await directory.resolveByExternalId('qq', '123456789', 'main', 'unknown-bot', true)).toBeUndefined();
  });

  it('fails closed when a scope-aware channel has no active fingerprint', async () => {
    const directory = new ConversationDirectory({ store: memoryStore(), now: () => 1000 });
    directory.observe(groupMessage({ canonicalId: 'OPEN_A', externalId: '123456789' }), 'bot-a', true);
    await flush();

    expect(await directory.list('qq', 'main', undefined, true)).toEqual([]);
    expect(
      await directory.resolveByExternalId('qq', '123456789', 'main', undefined, true),
    ).toBeUndefined();

    directory.observe(groupMessage({ canonicalId: 'OPEN_B', externalId: '987654321' }), undefined, true);
    await flush();
    expect(await directory.list('qq', 'main', 'bot-a', true)).toHaveLength(1);
  });

  it('resolves by externalId within the right account scope', async () => {
    const directory = new ConversationDirectory({ store: memoryStore(), now: () => 1000 });
    directory.observe(groupMessage({ account: 'main', canonicalId: 'OPEN_A', externalId: '123456789' }));
    directory.observe(groupMessage({ account: 'bot2', canonicalId: 'OPEN_B', externalId: '123456789' }));
    await flush();

    const resolved = await directory.resolveByExternalId('qq', '123456789', 'main');
    expect(resolved?.canonicalId).toBe('OPEN_A');

    const other = await directory.resolveByExternalId('qq', '123456789', 'bot2');
    expect(other?.canonicalId).toBe('OPEN_B');

    expect(await directory.resolveByExternalId('qq', '999999999', 'main')).toBeUndefined();
  });

  it('marks identityConflict when the same canonicalId later reports a different externalId', async () => {
    const directory = new ConversationDirectory({ store: memoryStore(), now: () => 1000 });
    directory.observe(groupMessage({ canonicalId: 'OPEN_A', externalId: '123456789' }));
    await flush();
    directory.observe(groupMessage({ canonicalId: 'OPEN_A', externalId: '987654321' }));
    await flush();

    const entries = await directory.list('qq', 'main');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.externalId).toBe('987654321');
    expect(entries[0]!.identityConflict).toBe(true);
  });

  it('keeps displayName when the adapter provides one', async () => {
    const directory = new ConversationDirectory({ store: memoryStore(), now: () => 1000 });
    directory.observe(groupMessage({ canonicalId: 'OPEN_A', externalId: '123456789', name: '研发群' }));
    await flush();

    const entries = await directory.list('qq', 'main');
    expect(entries[0]!.displayName).toBe('研发群');
  });
});

describe('ChannelStorageConversationDirectoryStore', () => {
  it('round-trips records under the versioned channel-scoped key', async () => {
    const storage: ChannelStorage = new MemoryStorage();
    const store = new ChannelStorageConversationDirectoryStore(() => storage);
    await store.set('qq', 'main', {
      version: 1,
      conversations: {
        OPEN_A: {
          channelId: 'qq',
          accountId: 'main',
          canonicalId: 'OPEN_A',
          type: 'group',
          externalId: '123456789',
          firstSeenAt: 1,
          lastSeenAt: 2,
        },
      },
    });

    const record = await store.get('qq', 'main');
    expect(record?.conversations.OPEN_A?.externalId).toBe('123456789');
    // Persisted under the shared versioned key (durable across restarts).
    expect(await storage.get(conversationDirectoryStorageKey('qq', 'main'))).toBeDefined();
  });

  it('isolates keys per channel+account and treats invalid JSON as absent', async () => {
    const storage: ChannelStorage = new MemoryStorage();
    const store = new ChannelStorageConversationDirectoryStore(() => storage);
    await store.set('qq', 'main', { version: 1, conversations: {} });
    expect(await store.get('qq', 'bot2')).toBeUndefined();
    expect(await store.get('telegram', 'main')).toBeUndefined();

    await storage.set(conversationDirectoryStorageKey('telegram', 'main'), 'not json');
    expect(await store.get('telegram', 'main')).toBeUndefined();
  });

  it('directory survives a restart via the durable store', async () => {
    const storage: ChannelStorage = new MemoryStorage();
    const first = new ConversationDirectory({
      store: new ChannelStorageConversationDirectoryStore(() => storage),
      now: () => 1000,
    });
    first.observe(groupMessage({ externalId: '123456789' }));
    await flush();

    const second = new ConversationDirectory({
      store: new ChannelStorageConversationDirectoryStore(() => storage),
      now: () => 9000,
    });
    const entries = await second.list('qq', 'main');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.externalId).toBe('123456789');
  });
});

function memoryStore() {
  return new MemoryConversationDirectoryStore();
}
