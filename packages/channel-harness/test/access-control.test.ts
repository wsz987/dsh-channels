/*
 * Access Control unit tests (execution plan §53).
 *
 * Covers InboundAccessController against the full DM/Group authorization +
 * activation matrix, and StoredChannelAccessPolicyResolver against the
 * fail-closed resolution rules (missing / malformed / unknown-version /
 * present) via an in-memory ChannelStorage.
 *
 * Missing/invalid POLICIES are resolved at the resolver level; the controller
 * itself only ever receives a fully-present, schema-valid policy.
 */
import { describe, expect, it } from 'vitest';
import type {
  ChannelAccessPolicy,
  DirectMessagePolicy,
  GroupAccessRule,
} from '@wsz987/channel-core';
import { accessPolicyStorageKey, MemoryStorage } from '@wsz987/channel-core';
import { InboundAccessController } from '../src/access/controller.ts';
import { StoredChannelAccessPolicyResolver } from '../src/access/resolver.ts';

const controller = new InboundAccessController();

/** Minimal valid DM policy builder. */
function dmPolicy(overrides: Partial<ChannelAccessPolicy> = {}): ChannelAccessPolicy {
  return {
    version: 1,
    preset: 'custom',
    dmPolicy: 'open',
    allowFrom: [],
    groupPolicy: 'disabled',
    groups: {},
    ...overrides,
  };
}

function groupRule(overrides: Partial<GroupAccessRule> = {}): GroupAccessRule {
  return {
    enabled: true,
    senderPolicy: 'open',
    allowFrom: [],
    requireMention: false,
    ...overrides,
  };
}

function authorizeDm(senderId: string, policy: ChannelAccessPolicy) {
  return controller.authorize({
    conversationType: 'dm',
    senderId,
    conversationId: 'user_123',
    policy,
  });
}

function authorizeGroup(
  senderId: string,
  conversationId: string,
  policy: ChannelAccessPolicy,
  mentionedBot?: boolean,
) {
  return controller.authorize({
    conversationType: 'group',
    senderId,
    conversationId,
    mentionedBot,
    policy,
  });
}

describe('InboundAccessController — DM (plan §19.1, §53)', () => {
  it('DM disabled -> denied dm_disabled', () => {
    const d = authorizeDm('user_1', dmPolicy({ dmPolicy: 'disabled' }));
    expect(d).toEqual({ authorized: false, activated: false, reason: 'dm_disabled' });
  });

  it('DM allowlist [] -> DENY ALL (never open)', () => {
    const d = authorizeDm('anyone', dmPolicy({ dmPolicy: 'allowlist', allowFrom: [] }));
    expect(d).toEqual({ authorized: false, activated: false, reason: 'user_not_allowed' });
  });

  it('DM allowlist allowed sender -> ALLOW', () => {
    const d = authorizeDm('user_ok', dmPolicy({ dmPolicy: 'allowlist', allowFrom: ['user_ok'] }));
    expect(d).toEqual({ authorized: true, activated: true, reason: 'allowed' });
  });

  it('DM allowlist unknown sender -> DENY user_not_allowed', () => {
    const d = authorizeDm('intruder', dmPolicy({ dmPolicy: 'allowlist', allowFrom: ['user_ok'] }));
    expect(d).toEqual({ authorized: false, activated: false, reason: 'user_not_allowed' });
  });

  it('DM open -> ALLOW', () => {
    const d = authorizeDm('anyone', dmPolicy({ dmPolicy: 'open' }));
    expect(d).toEqual({ authorized: true, activated: true, reason: 'allowed' });
  });
});

describe('InboundAccessController — Group (plan §19.2, §53)', () => {
  it('groupPolicy disabled -> DENY group_disabled', () => {
    const d = authorizeGroup('u1', 'g1', dmPolicy({ groupPolicy: 'disabled' }));
    expect(d).toEqual({ authorized: false, activated: false, reason: 'group_disabled' });
  });

  it('group allowlist but unknown group -> DENY group_not_allowed', () => {
    const d = authorizeGroup(
      'u1',
      'unknown-group',
      dmPolicy({
        groupPolicy: 'allowlist',
        groups: { g1: groupRule() },
      }),
    );
    expect(d).toEqual({ authorized: false, activated: false, reason: 'group_not_allowed' });
  });

  it('named group disabled -> DENY group_disabled', () => {
    const d = authorizeGroup(
      'u1',
      'g1',
      dmPolicy({
        groupPolicy: 'allowlist',
        groups: { g1: groupRule({ enabled: false }) },
      }),
    );
    expect(d).toEqual({ authorized: false, activated: false, reason: 'group_disabled' });
  });

  it('named group + sender allowlist + allowed sender -> ALLOW', () => {
    const d = authorizeGroup(
      'u_allowed',
      'g1',
      dmPolicy({
        groupPolicy: 'allowlist',
        groups: { g1: groupRule({ senderPolicy: 'allowlist', allowFrom: ['u_allowed'] }) },
      }),
    );
    expect(d).toEqual({ authorized: true, activated: true, reason: 'allowed' });
  });

  it('named group + sender allowlist + denied sender -> DENY group_user_not_allowed', () => {
    const d = authorizeGroup(
      'u_intruder',
      'g1',
      dmPolicy({
        groupPolicy: 'allowlist',
        groups: { g1: groupRule({ senderPolicy: 'allowlist', allowFrom: ['u_allowed'] }) },
      }),
    );
    expect(d).toEqual({ authorized: false, activated: false, reason: 'group_user_not_allowed' });
  });

  it('named group + senderPolicy open -> ALLOW authorization (no activation gate)', () => {
    const d = authorizeGroup(
      'anyone',
      'g1',
      dmPolicy({
        groupPolicy: 'allowlist',
        groups: { g1: groupRule({ senderPolicy: 'open' }) },
      }),
    );
    expect(d).toEqual({ authorized: true, activated: true, reason: 'allowed' });
  });

  it('global groups use the explicit default sender rule', () => {
    const policy: ChannelAccessPolicy = {
      version: 1,
      preset: 'custom',
      dmPolicy: 'allowlist',
      allowFrom: ['owner'],
      groupPolicy: 'open',
      groups: {},
      defaultGroupRule: groupRule({ senderPolicy: 'allowlist', allowFrom: ['owner'] }),
    };
    expect(authorizeGroup('owner', 'previously-unknown', policy).reason).toBe('allowed');
    expect(authorizeGroup('intruder', 'previously-unknown', policy).reason).toBe('group_user_not_allowed');
  });
});

describe('InboundAccessController — Activation / requireMention (plan §14, §53)', () => {
  const groupOpen = (rule: GroupAccessRule): ChannelAccessPolicy =>
    dmPolicy({
      groupPolicy: 'allowlist',
      groups: { g1: rule },
    });

  it('requireMention + mentioned=true -> AUTHORIZED + ACTIVATED', () => {
    const d = authorizeGroup(
      'u1',
      'g1',
      groupOpen(groupRule({ requireMention: true })),
      true,
    );
    expect(d).toEqual({ authorized: true, activated: true, reason: 'allowed' });
  });

  it('requireMention + mentioned=false -> NOT ACTIVATED mention_required', () => {
    const d = authorizeGroup(
      'u1',
      'g1',
      groupOpen(groupRule({ requireMention: true })),
      false,
    );
    expect(d).toEqual({ authorized: true, activated: false, reason: 'mention_required' });
  });

  it('requireMention + mentioned=undefined -> NOT ACTIVATED (undefined !== true)', () => {
    const d = authorizeGroup(
      'u1',
      'g1',
      groupOpen(groupRule({ requireMention: true })),
      undefined,
    );
    expect(d).toEqual({ authorized: true, activated: false, reason: 'mention_required' });
  });

  it('requireMention=false -> always ACTIVATED regardless of mention', () => {
    const d = authorizeGroup(
      'u1',
      'g1',
      groupOpen(groupRule({ requireMention: false })),
      false,
    );
    expect(d).toEqual({ authorized: true, activated: true, reason: 'allowed' });
  });
});

describe('StoredChannelAccessPolicyResolver (plan §15, §17)', () => {
  function resolverWith(entries: Record<string, string>) {
    const storage = new MemoryStorage();
    for (const [k, v] of Object.entries(entries)) {
      void storage.set(k, v);
    }
    const resolver = new StoredChannelAccessPolicyResolver(() => storage);
    return { resolver, storage };
  }

  it('missing JSON -> missing policy', async () => {
    const { resolver } = resolverWith({});
    const r = await resolver.resolve('telegram', 'main');
    expect(r).toEqual({ state: 'missing' });
  });

  it('malformed JSON -> invalid policy', async () => {
    const key = accessPolicyStorageKey('telegram', 'main');
    const { resolver } = resolverWith({ [key]: 'not-json{' });
    const r = await resolver.resolve('telegram', 'main');
    expect(r.state).toBe('invalid');
  });

  it('unknown version -> invalid policy (fail closed)', async () => {
    const key = accessPolicyStorageKey('telegram', 'main');
    const policy = dmPolicy({ version: 99 as never });
    const { resolver } = resolverWith({ [key]: JSON.stringify(policy) });
    const r = await resolver.resolve('telegram', 'main');
    expect(r.state).toBe('invalid');
  });

  it('schema failure (bad dmPolicy) -> invalid policy', async () => {
    const key = accessPolicyStorageKey('telegram', 'main');
    const bad = { ...dmPolicy(), dmPolicy: 'banana' };
    const { resolver } = resolverWith({ [key]: JSON.stringify(bad) });
    const r = await resolver.resolve('telegram', 'main');
    expect(r.state).toBe('invalid');
  });

  it('present valid policy -> { state: present, policy }', async () => {
    const key = accessPolicyStorageKey('telegram', 'main');
    const policy = dmPolicy({ dmPolicy: 'allowlist', allowFrom: ['owner-1'] });
    const { resolver } = resolverWith({ [key]: JSON.stringify(policy) });
    const r = await resolver.resolve('telegram', 'main');
    expect(r.state).toBe('present');
    if (r.state === 'present') {
      expect(r.policy).toEqual(policy);
    }
  });

  it('uses the shared storage key codec', async () => {
    const storage = new MemoryStorage();
    const key = accessPolicyStorageKey('weixin', 'acct');
    expect(key).toBe('access:policy:v1:weixin:acct');
    const resolver = new StoredChannelAccessPolicyResolver(() => storage);
    await storage.set(key, JSON.stringify(dmPolicy({ dmPolicy: 'open' })));
    const r = await resolver.resolve('weixin', 'acct');
    expect(r.state).toBe('present');
  });
});
