/**
 * ChannelStorageAccessPolicyStore tests (plan §15): get / set / delete / getRaw
 * over an in-memory ChannelStorage, including the missing-vs-invalid distinction.
 */
import { describe, expect, it } from 'vitest';
import { MemoryStorage, type ChannelStorage } from '@wsz987/channel-core';
import type { ChannelAccessPolicy } from '@wsz987/channel-core';
import {
  ChannelStorageAccessPolicyStore,
  MemoryAccessPolicyStore,
} from '../../src/access/policy-store.js';

function makePolicy(overrides: Partial<ChannelAccessPolicy> = {}): ChannelAccessPolicy {
  return {
    version: 1,
    preset: 'allowlist',
    ownerId: 'owner-1',
    dmPolicy: 'allowlist',
    allowFrom: ['owner-1'],
    groupPolicy: 'disabled',
    groups: {},
    ...overrides,
  };
}

describe('ChannelStorageAccessPolicyStore', () => {
  it('get/set/delete round-trip a policy through the shared key namespace', async () => {
    const storage: ChannelStorage = new MemoryStorage();
    const store = new ChannelStorageAccessPolicyStore(() => storage);

    // Missing -> getRaw and get both undefined.
    expect(await store.get('telegram', 'main')).toBeUndefined();
    expect(await store.getRaw('telegram', 'main')).toBeUndefined();

    const policy = makePolicy({ preset: 'owner-only', allowFrom: ['weixin-id'] });
    await store.set('weixin', 'main', policy);

    expect(await store.get('weixin', 'main')).toEqual(policy);
    // Raw string is a JSON serialization under the versioned key.
    expect(await store.getRaw('weixin', 'main')).toBe(JSON.stringify(policy));

    await store.delete('weixin', 'main');
    expect(await store.get('weixin', 'main')).toBeUndefined();
    expect(await store.getRaw('weixin', 'main')).toBeUndefined();
  });

  it('keys are scoped per channel and account (no cross-talk)', async () => {
    const storage: ChannelStorage = new MemoryStorage();
    const store = new ChannelStorageAccessPolicyStore(() => storage);
    await store.set('qq', 'main', makePolicy());
    expect(await store.get('telegram', 'main')).toBeUndefined();
    expect(await store.get('qq', 'other')).toBeUndefined();
    expect(await store.get('qq', 'main')).toBeDefined();
  });

  it('invalid stored JSON is treated as absent by get but visible via getRaw', async () => {
    const storage: ChannelStorage = new MemoryStorage();
    const store = new ChannelStorageAccessPolicyStore(() => storage);
    // Unknown version / malformed content -> schema rejects.
    await storage.set('access:policy:v1:lark:main', JSON.stringify({ version: 99, preset: 'nope' }));

    expect(await store.get('lark', 'main')).toBeUndefined();
    // The raw still exists, so a resolver could classify it as "invalid".
    expect(await store.getRaw('lark', 'main')).toBe(
      JSON.stringify({ version: 99, preset: 'nope' }),
    );
  });

  it('malformed stored JSON is treated as invalid without throwing', async () => {
    const storage: ChannelStorage = new MemoryStorage();
    const store = new ChannelStorageAccessPolicyStore(() => storage);
    await storage.set('access:policy:v1:lark:main', '{not-json');

    await expect(store.get('lark', 'main')).resolves.toBeUndefined();
    await expect(store.getRaw('lark', 'main')).resolves.toBe('{not-json');
  });
});

describe('MemoryAccessPolicyStore', () => {
  it('behaves like an in-memory ChannelStorageAccessPolicyStore', async () => {
    const store = new MemoryAccessPolicyStore();
    const policy = makePolicy();
    expect(await store.get('telegram', 'main')).toBeUndefined();
    await store.set('telegram', 'main', policy);
    expect(await store.get('telegram', 'main')).toEqual(policy);
    expect(await store.getRaw('telegram', 'main')).toBe(JSON.stringify(policy));
    await store.delete('telegram', 'main');
    expect(await store.get('telegram', 'main')).toBeUndefined();
  });
});
