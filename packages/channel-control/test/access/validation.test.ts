/**
 * validateAccessPolicy tests (plan §31): schema validity, owner-only-without-
 * owner, descriptor-relative gating (mentions / groups / DM), and normalization
 * (trim + exact dedupe of allowFrom).
 */
import { describe, expect, it } from 'vitest';
import type { ChannelAccessPolicy } from '@wsz987/channel-core';
import type { ChannelAccessDescriptor } from '../../src/types.js';
import { validateAccessPolicy } from '../../src/access/validation.js';

const fullDescriptor: ChannelAccessDescriptor = {
  directMessages: true,
  groups: true,
  mentions: true,
  ownerDiscovery: 'claim',
  identityLabels: { user: 'User', group: 'Group' },
};

function basePolicy(overrides: Partial<ChannelAccessPolicy> = {}): ChannelAccessPolicy {
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

describe('validateAccessPolicy — structural / zod', () => {
  it('accepts a valid owner-only policy', () => {
    const result = validateAccessPolicy(
      basePolicy({ preset: 'owner-only', dmPolicy: 'allowlist', allowFrom: ['owner-1'] }),
      fullDescriptor,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown schema version (unknown versions fail closed)', () => {
    const result = validateAccessPolicy(
      { version: 99, preset: 'allowlist', dmPolicy: 'allowlist', allowFrom: [], groupPolicy: 'disabled', groups: {} },
      fullDescriptor,
    );
    expect(result.ok).toBe(false);
  });

  it('owner-only preset without ownerId is rejected', () => {
    const result = validateAccessPolicy(
      basePolicy({ preset: 'owner-only', ownerId: undefined, allowFrom: ['x'] }),
      fullDescriptor,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ownerId');
  });
});

describe('validateAccessPolicy — descriptor gating', () => {
  it('requireMention=true is rejected when descriptor.mentions=false', () => {
    const descriptor: ChannelAccessDescriptor = { ...fullDescriptor, mentions: false };
    const result = validateAccessPolicy(
      basePolicy({
        groupPolicy: 'allowlist',
        groups: {
          g1: { enabled: true, senderPolicy: 'allowlist', allowFrom: ['owner-1'], requireMention: true },
        },
      }),
      descriptor,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/mention/i);
  });

  it('group configured while descriptor.groups=false is rejected', () => {
    const descriptor: ChannelAccessDescriptor = { ...fullDescriptor, groups: false };
    const result = validateAccessPolicy(
      basePolicy({
        groupPolicy: 'allowlist',
        groups: {
          g1: { enabled: true, senderPolicy: 'allowlist', allowFrom: ['owner-1'], requireMention: false },
        },
      }),
      descriptor,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/groups?/i);
  });

  it('dmPolicy != disabled while descriptor.directMessages=false is rejected', () => {
    const descriptor: ChannelAccessDescriptor = { ...fullDescriptor, directMessages: false };
    const dmResult = validateAccessPolicy(basePolicy({ dmPolicy: 'allowlist' }), descriptor);
    expect(dmResult.ok).toBe(false);
  });

  it('groupPolicy != disabled while descriptor.groups=false is rejected', () => {
    const descriptor: ChannelAccessDescriptor = { ...fullDescriptor, groups: false };
    const gResult = validateAccessPolicy(
      basePolicy({ groupPolicy: 'allowlist', groups: {} }),
      descriptor,
    );
    expect(gResult.ok).toBe(false);
  });
});

describe('validateAccessPolicy — normalization', () => {
  it('trims canonical ids and removes exact duplicates from allowFrom', () => {
    const result = validateAccessPolicy(
      basePolicy({
        dmPolicy: 'allowlist',
        allowFrom: [' owner-1 ', 'owner-1', 'other', 'other'],
      }),
      fullDescriptor,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Trimmed + exact-deduplicated, preserving first-seen order.
    expect(result.policy.allowFrom).toEqual(['owner-1', 'other']);
  });

  it('dedupes and trims group rule allowFrom but never lowercases or fuzzes', () => {
    const result = validateAccessPolicy(
      basePolicy({
        groupPolicy: 'allowlist',
        groups: {
          g1: {
            enabled: true,
            senderPolicy: 'allowlist',
            allowFrom: ['  ABC-123 ', 'abc-123', 'ABC-123'],
            requireMention: false,
          },
        },
      }),
      fullDescriptor,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only whitespace-trim + exact-string dedupe: 'ABC-123' and 'abc-123'
    // are distinct opaque ids and must both survive.
    expect(result.policy.groups.g1?.allowFrom).toEqual(['ABC-123', 'abc-123']);
  });

  it('allowFrom=[] is allowed (deny-all semantics handled by the runtime, not validation)', () => {
    const result = validateAccessPolicy(basePolicy({ allowFrom: [] }), fullDescriptor);
    expect(result.ok).toBe(true);
  });
});
