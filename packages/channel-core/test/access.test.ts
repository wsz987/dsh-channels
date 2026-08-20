/**
 * @wsz987/channel-core — access-policy contract tests (execution plan §4.1, §5).
 */
import { describe, expect, it } from 'vitest';
import {
  accessPolicyStorageKey,
  channelAccessPolicySchema,
  isReservedClaimCommand,
  parseOwnerClaimCommand,
  OWNER_CLAIM_COMMAND,
  type ChannelAccessPolicy,
} from '../src/access.js';

const validPolicy: ChannelAccessPolicy = {
  version: 1,
  preset: 'owner-only',
  ownerId: '123',
  dmPolicy: 'allowlist',
  allowFrom: ['123'],
  groupPolicy: 'disabled',
  groups: {},
};

describe('channelAccessPolicySchema', () => {
  it('accepts a minimal owner-only policy', () => {
    const parsed = channelAccessPolicySchema.safeParse(validPolicy);
    expect(parsed.success).toBe(true);
  });

  it('accepts a custom policy with a named group', () => {
    const policy: ChannelAccessPolicy = {
      version: 1,
      preset: 'custom',
      ownerId: '123',
      dmPolicy: 'allowlist',
      allowFrom: ['123'],
      groupPolicy: 'allowlist',
      groups: {
        '-100123456': {
          enabled: true,
          senderPolicy: 'open',
          allowFrom: [],
          requireMention: true,
        },
      },
    };
    expect(channelAccessPolicySchema.safeParse(policy).success).toBe(true);
  });

  it('accepts global groups only with an explicit enabled default rule', () => {
    const policy = {
      ...validPolicy,
      version: 1,
      preset: 'custom',
      groupPolicy: 'open',
      groups: {},
      defaultGroupRule: {
        enabled: true,
        senderPolicy: 'allowlist',
        allowFrom: ['123'],
        requireMention: false,
      },
    };
    expect(channelAccessPolicySchema.safeParse(policy).success).toBe(true);
    expect(channelAccessPolicySchema.safeParse({ ...policy, defaultGroupRule: undefined }).success).toBe(false);
    expect(channelAccessPolicySchema.safeParse({ ...policy, groups: { g1: policy.defaultGroupRule } }).success).toBe(false);
  });

  it('rejects an unknown schema version', () => {
    expect(
      channelAccessPolicySchema.safeParse({ ...validPolicy, version: 2 }).success,
    ).toBe(false);
  });

  it('rejects an invalid dmPolicy', () => {
    expect(
      channelAccessPolicySchema.safeParse({ ...validPolicy, dmPolicy: 'global-open' }).success,
    ).toBe(false);
  });

  it('rejects unknown top-level keys (fail closed, not silent-tolerated)', () => {
    expect(
      channelAccessPolicySchema.safeParse({ ...validPolicy, surprise: true }).success,
    ).toBe(false);
  });

  it('rejects a non-boolean requireMention', () => {
    const policy = {
      ...validPolicy,
      groupPolicy: 'allowlist',
      groups: { g: { enabled: true, senderPolicy: 'allowlist', allowFrom: [], requireMention: 'yes' } },
    };
    expect(channelAccessPolicySchema.safeParse(policy).success).toBe(false);
  });
});

describe('accessPolicyStorageKey', () => {
  it('builds the versioned namespace', () => {
    expect(accessPolicyStorageKey('telegram', 'main')).toBe('access:policy:v1:telegram:main');
    expect(accessPolicyStorageKey('lark', 'main')).toBe('access:policy:v1:lark:main');
  });

  it('encodes channel and account components independently', () => {
    const first = accessPolicyStorageKey('a:b', 'c');
    const second = accessPolicyStorageKey('a', 'b:c');

    expect(first).toBe('access:policy:v1:a%3Ab:c');
    expect(second).toBe('access:policy:v1:a:b%3Ac');
    expect(first).not.toBe(second);
  });

});

describe('owner claim command', () => {
  it('exposes the reserved command', () => {
    expect(OWNER_CLAIM_COMMAND).toBe('/dsh-claim');
  });

  it('recognizes the command only at byte zero', () => {
    expect(isReservedClaimCommand('/dsh-claim abc')).toBe(true);
    expect(isReservedClaimCommand('/dsh-claim')).toBe(true);
    expect(isReservedClaimCommand('  /dsh-claim abc')).toBe(false);
    expect(isReservedClaimCommand('/dsh-claimx')).toBe(false);
  });

  it('parses the challenge code', () => {
    expect(parseOwnerClaimCommand('/dsh-claim xyz123')).toEqual({
      command: '/dsh-claim',
      code: 'xyz123',
    });
    expect(parseOwnerClaimCommand('/dsh-claim')).toEqual({ command: '/dsh-claim', code: undefined });
    expect(parseOwnerClaimCommand('hello')).toBeUndefined();
  });
});
