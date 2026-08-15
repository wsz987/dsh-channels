/**
 * SessionBinding v3 (plan \u00a755/\u00a756/\u00a759).
 *
 * Covers the v2 -> v3 migration (legacy dm default), the v1 -> v2 -> v3 chain,
 * the durable `findBySessionId` lookup, and the fail-closed
 * `AmbiguousBindingError` (code OUTBOX_AMBIGUOUS_BINDING) when one session id
 * maps to more than one current binding.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AmbiguousBindingError,
  FileBindingStore,
  MemoryBindingStore,
  migrateBinding,
} from '../src/binding-store.ts';
import {
  SESSION_BINDING_SCHEMA_VERSION,
  type SessionBinding,
} from '../src/session-router.ts';

function makeBinding(overrides: Partial<SessionBinding> = {}): SessionBinding {
  return {
    channelId: 'weixin',
    accountId: 'main',
    conversationId: 'u1',
    conversationType: 'dm',
    sessionId: 's1',
    route: { model: 'm' },
    schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('binding v2 -> v3 migration', () => {
  it('promotes a v2 entry (route, schemaVersion 2, no conversationType) to dm + v3', () => {
    const v2 = {
      channelId: 'weixin',
      accountId: 'main',
      conversationId: 'u1',
      sessionId: 's2',
      route: { model: 'v2-model' },
      schemaVersion: 2,
      createdAt: 5,
      updatedAt: 6,
    };
    const migrated = migrateBinding(v2);
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.conversationType).toBe('dm');
    expect(migrated.senderId).toBeUndefined();
    expect(migrated.route).toEqual({ model: 'v2-model' });
    expect(migrated.sessionId).toBe('s2');
    expect('conversationType' in migrated).toBe(true);
  });

  it('MemoryBindingStore migrates a v2 entry on get', async () => {
    const store = new MemoryBindingStore();
    (store as unknown as { store: Map<string, unknown> }).store.set('weixin:main:u1', {
      channelId: 'weixin',
      accountId: 'main',
      conversationId: 'u1',
      sessionId: 's2',
      route: { model: 'v2-model' },
      schemaVersion: 2,
      createdAt: 5,
      updatedAt: 6,
    });
    const b = await store.get('weixin:main:u1');
    expect(b?.schemaVersion).toBe(3);
    expect(b?.conversationType).toBe('dm');
  });

  it('v1 -> v2 -> v3 chain yields a dm v3 binding', () => {
    const migrated = migrateBinding({
      channelId: 'weixin',
      accountId: 'main',
      conversationId: 'u1',
      agentId: 'legacy-model',
      sessionId: 'ch-old',
      createdAt: 1,
      updatedAt: 1,
    });
    expect(migrated.schemaVersion).toBe(3);
    expect(migrated.conversationType).toBe('dm');
    expect(migrated.route).toEqual({ model: 'legacy-model' });
    expect('agentId' in migrated).toBe(false);
  });

  it('leaves an already-v3 binding unchanged (same reference)', () => {
    const v3 = makeBinding();
    expect(migrateBinding(v3)).toBe(v3);
  });
});

describe('findBySessionId (durable session -> binding)', () => {
  it('returns the binding for a MemoryBindingStore', async () => {
    const store = new MemoryBindingStore();
    await store.put(makeBinding({ sessionId: 's1' }));
    const found = await store.findBySessionId('s1');
    expect(found?.sessionId).toBe('s1');
    expect(found?.conversationId).toBe('u1');
  });

  it('returns the binding for a FileBindingStore across reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-bv3-'));
    try {
      const file = join(dir, 'bindings.json');
      const store = new FileBindingStore(file);
      await store.put(makeBinding({ conversationId: 'g1', sessionId: 'sg1', conversationType: 'group' }));
      const reopened = new FileBindingStore(file);
      const found = await reopened.findBySessionId('sg1');
      expect(found?.sessionId).toBe('sg1');
      expect(found?.conversationType).toBe('group');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when no binding maps to the session', async () => {
    const store = new MemoryBindingStore();
    expect(await store.findBySessionId('nope')).toBeUndefined();
  });

  it('finds a migrated v1 legacy binding by its session id (memory)', async () => {
    const store = new MemoryBindingStore();
    (store as unknown as { store: Map<string, unknown> }).store.set('weixin:main:u1', {
      channelId: 'weixin',
      accountId: 'main',
      conversationId: 'u1',
      agentId: 'legacy',
      sessionId: 'legacy-s',
      createdAt: 1,
      updatedAt: 1,
    });
    const found = await store.findBySessionId('legacy-s');
    expect(found?.schemaVersion).toBe(3);
    expect(found?.conversationType).toBe('dm');
  });
});

describe('ambiguous binding fails closed (OUTBOX_AMBIGUOUS_BINDING)', () => {
  it('MemoryBindingStore throws when one sessionId maps to >1 current binding', async () => {
    const store = new MemoryBindingStore();
    await store.put(makeBinding({ sessionId: 'dup', conversationId: 'a' }));
    await store.put(makeBinding({ sessionId: 'dup', conversationId: 'b' }));
    let thrown: unknown;
    try {
      await store.findBySessionId('dup');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AmbiguousBindingError);
    expect((thrown as AmbiguousBindingError).code).toBe('OUTBOX_AMBIGUOUS_BINDING');
    expect((thrown as AmbiguousBindingError).sessionId).toBe('dup');
    expect((thrown as AmbiguousBindingError).bindingCount).toBeGreaterThan(1);
  });

  it('FileBindingStore throws when one sessionId maps to >1 current binding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-ambig-'));
    try {
      const file = join(dir, 'bindings.json');
      await writeFile(
        file,
        JSON.stringify({
          'weixin:main:a': makeBinding({ sessionId: 'dup', conversationId: 'a' }),
          'weixin:main:b': makeBinding({ sessionId: 'dup', conversationId: 'b' }),
        }),
        'utf8',
      );
      const store = new FileBindingStore(file);
      let thrown: unknown;
      try {
        await store.findBySessionId('dup');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AmbiguousBindingError);
      expect((thrown as AmbiguousBindingError).code).toBe('OUTBOX_AMBIGUOUS_BINDING');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('delete removes the session from the index, so the ambiguity clears', async () => {
    const store = new MemoryBindingStore();
    await store.put(makeBinding({ sessionId: 'dup', conversationId: 'a' }));
    await store.put(makeBinding({ sessionId: 'dup', conversationId: 'b' }));
    await expect(store.findBySessionId('dup')).rejects.toBeInstanceOf(AmbiguousBindingError);
    await store.delete('weixin:main:b');
    const found = await store.findBySessionId('dup');
    expect(found?.conversationId).toBe('a');
  });
});
