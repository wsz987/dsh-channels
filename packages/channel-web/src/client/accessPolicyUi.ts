import type { ChannelAccessPolicy, GroupAccessRule, OwnerDiscoveryMode } from './api.js';

export type DirectMessageAccessMode = 'disabled' | 'owner-only' | 'allowlist' | 'open';
export type GroupSenderAccessMode = 'owner-only' | 'allowlist' | 'open';
export type GroupAccessMode = 'disabled' | 'allowlist' | 'open';

export function groupAccessMode(policy: ChannelAccessPolicy): GroupAccessMode {
  return policy.groupPolicy;
}

export function withGroupAccessMode(
  policy: ChannelAccessPolicy,
  mode: GroupAccessMode,
  ownerId: string | undefined,
  requireMention = false,
): ChannelAccessPolicy {
  if (mode === 'open') {
    return {
      ...policy,
      version: 1,
      preset: 'custom',
      groupPolicy: 'open',
      groups: {},
      defaultGroupRule: policy.defaultGroupRule ?? {
        enabled: true,
        senderPolicy: 'open',
        allowFrom: [],
        requireMention,
      },
    };
  }

  const { defaultGroupRule: _defaultGroupRule, ...rest } = policy;
  return {
    ...rest,
    preset: 'custom',
    groupPolicy: mode,
    groups: mode === 'disabled' ? {} : rest.groups,
  };
}

export function isDirectMessageAccessEditable(ownerDiscovery: OwnerDiscoveryMode): boolean {
  return ownerDiscovery !== 'account';
}

export function hasEditableAccessControls(
  ownerDiscovery: OwnerDiscoveryMode,
  groupsSupported: boolean,
): boolean {
  return isDirectMessageAccessEditable(ownerDiscovery) || groupsSupported;
}

function isOwnerOnly(values: string[], ownerId: string | undefined): boolean {
  return Boolean(ownerId) && values.length === 1 && values[0] === ownerId;
}

export function directMessageAccessMode(
  policy: ChannelAccessPolicy,
  ownerId: string | undefined,
): DirectMessageAccessMode {
  if (policy.dmPolicy === 'disabled') return 'disabled';
  if (policy.dmPolicy === 'open') return 'open';
  // The initial unsaved draft expresses the recommended owner-only intent
  // before an owner exists. No persisted owner-only policy can omit ownerId.
  if (!ownerId && policy.preset === 'owner-only' && policy.allowFrom.length === 0) return 'owner-only';
  return isOwnerOnly(policy.allowFrom, ownerId) ? 'owner-only' : 'allowlist';
}

export function withDirectMessageAccessMode(
  policy: ChannelAccessPolicy,
  mode: DirectMessageAccessMode,
  ownerId: string | undefined,
): ChannelAccessPolicy {
  switch (mode) {
    case 'disabled':
      return { ...policy, preset: 'custom', dmPolicy: 'disabled', allowFrom: [] };
    case 'owner-only':
      return { ...policy, preset: 'custom', dmPolicy: 'allowlist', allowFrom: ownerId ? [ownerId] : [] };
    case 'allowlist':
      return {
        ...policy,
        preset: 'custom',
        dmPolicy: 'allowlist',
        allowFrom: isOwnerOnly(policy.allowFrom, ownerId) ? [] : policy.allowFrom,
      };
    case 'open':
      return { ...policy, preset: 'custom', dmPolicy: 'open', allowFrom: [] };
  }
}

/**
 * Keep the persisted preset as a canonical summary for compatibility. The Web
 * editor is driven by the actual DM/group rules, never by this preset.
 */
export function prepareAccessPolicyForSave(
  policy: ChannelAccessPolicy,
  ownerId: string | undefined,
): ChannelAccessPolicy {
  const withOwner = ownerId && !policy.ownerId ? { ...policy, ownerId } : policy;
  const hasGroupConfiguration =
    withOwner.groupPolicy !== 'disabled' || Object.keys(withOwner.groups).length > 0;

  if (!hasGroupConfiguration && isOwnerOnly(withOwner.allowFrom, ownerId) && withOwner.dmPolicy === 'allowlist') {
    return { ...withOwner, preset: 'owner-only' };
  }
  if (!hasGroupConfiguration && withOwner.dmPolicy === 'allowlist') {
    return { ...withOwner, preset: 'allowlist' };
  }
  return { ...withOwner, preset: 'custom' };
}

export function groupSenderAccessMode(
  rule: GroupAccessRule,
  ownerId: string | undefined,
): GroupSenderAccessMode {
  if (rule.senderPolicy === 'open') return 'open';
  return isOwnerOnly(rule.allowFrom, ownerId) ? 'owner-only' : 'allowlist';
}

export function withGroupSenderAccessMode(
  rule: GroupAccessRule,
  mode: GroupSenderAccessMode,
  ownerId: string | undefined,
): GroupAccessRule {
  switch (mode) {
    case 'owner-only':
      return { ...rule, senderPolicy: 'allowlist', allowFrom: ownerId ? [ownerId] : [] };
    case 'allowlist':
      return {
        ...rule,
        senderPolicy: 'allowlist',
        allowFrom: isOwnerOnly(rule.allowFrom, ownerId) ? [] : rule.allowFrom,
      };
    case 'open':
      return { ...rule, senderPolicy: 'open', allowFrom: [] };
  }
}
