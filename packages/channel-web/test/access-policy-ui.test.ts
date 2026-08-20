import { describe, expect, it } from 'vitest';
import type { ChannelAccessPolicy, GroupAccessRule } from '../src/client/api.js';
import {
  directMessageAccessMode,
  groupSenderAccessMode,
  hasEditableAccessControls,
  isDirectMessageAccessEditable,
  prepareAccessPolicyForSave,
  withDirectMessageAccessMode,
  withGroupSenderAccessMode,
} from '../src/client/accessPolicyUi.js';

const ownerId = 'owner-1';

function policy(overrides: Partial<ChannelAccessPolicy> = {}): ChannelAccessPolicy {
  return {
    version: 1,
    preset: 'owner-only',
    ownerId,
    dmPolicy: 'allowlist',
    allowFrom: [ownerId],
    groupPolicy: 'disabled',
    groups: {},
    ...overrides,
  };
}

const groupRule: GroupAccessRule = {
  enabled: true,
  senderPolicy: 'allowlist',
  allowFrom: [ownerId],
  requireMention: false,
};

describe('direct-message access UI mapping', () => {
  it('keeps account-discovered channels fixed while claim/manual channels remain editable', () => {
    expect(isDirectMessageAccessEditable('account')).toBe(false);
    expect(isDirectMessageAccessEditable('claim')).toBe(true);
    expect(isDirectMessageAccessEditable('manual')).toBe(true);
  });

  it('hides editor-only actions when an account channel has no group controls', () => {
    expect(hasEditableAccessControls('account', false)).toBe(false);
    expect(hasEditableAccessControls('account', true)).toBe(true);
    expect(hasEditableAccessControls('claim', false)).toBe(true);
  });

  it('recognizes owner-only only when the allowlist exactly contains the owner', () => {
    expect(directMessageAccessMode(policy(), ownerId)).toBe('owner-only');
    expect(directMessageAccessMode(policy({ allowFrom: [] }), ownerId)).toBe('allowlist');
    expect(directMessageAccessMode(policy({ allowFrom: [ownerId, 'alice'] }), ownerId)).toBe('allowlist');
  });

  it('keeps the initial pre-claim draft on the recommended owner-only choice', () => {
    expect(directMessageAccessMode(policy({ ownerId: undefined, allowFrom: [] }), undefined)).toBe('owner-only');
  });

  it('changes DM access without discarding named-group rules', () => {
    const withGroup = policy({
      preset: 'custom',
      groupPolicy: 'allowlist',
      groups: { group1: groupRule },
    });
    const opened = withDirectMessageAccessMode(withGroup, 'open', ownerId);
    const saved = prepareAccessPolicyForSave(opened, ownerId);

    expect(saved).toMatchObject({
      preset: 'custom',
      dmPolicy: 'open',
      groupPolicy: 'allowlist',
      groups: { group1: groupRule },
    });
  });

  it('opens the specified-user editor when switching away from owner-only', () => {
    const specified = withDirectMessageAccessMode(policy(), 'allowlist', ownerId);
    expect(specified.allowFrom).toEqual([]);
    expect(directMessageAccessMode(specified, ownerId)).toBe('allowlist');
  });

  it('keeps simple policies in their compatible persisted presets', () => {
    expect(prepareAccessPolicyForSave(policy(), ownerId).preset).toBe('owner-only');
    expect(prepareAccessPolicyForSave(policy({ allowFrom: [ownerId, 'alice'] }), ownerId).preset).toBe('allowlist');
    expect(prepareAccessPolicyForSave(policy({ dmPolicy: 'disabled', allowFrom: [] }), ownerId).preset).toBe('custom');
  });
});

describe('named-group sender UI mapping', () => {
  it('does not mislabel an empty allowlist as owner-only', () => {
    expect(groupSenderAccessMode({ ...groupRule, allowFrom: [] }, ownerId)).toBe('allowlist');
  });

  it('materializes owner-only with the canonical owner id', () => {
    expect(withGroupSenderAccessMode({ ...groupRule, allowFrom: [] }, 'owner-only', ownerId)).toEqual({
      ...groupRule,
      allowFrom: [ownerId],
    });
  });

  it('opens the specified-member editor when switching away from owner-only', () => {
    const specified = withGroupSenderAccessMode(groupRule, 'allowlist', ownerId);
    expect(specified.allowFrom).toEqual([]);
    expect(groupSenderAccessMode(specified, ownerId)).toBe('allowlist');
  });

  it('represents all members as an explicit open rule', () => {
    expect(withGroupSenderAccessMode(groupRule, 'open', ownerId)).toEqual({
      ...groupRule,
      senderPolicy: 'open',
      allowFrom: [],
    });
  });
});
