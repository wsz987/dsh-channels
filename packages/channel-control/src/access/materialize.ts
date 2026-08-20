/**
 * Policy materialization helpers (execution plan §6, §24, §25).
 *
 * `ownerOnlyPolicy` builds the canonical owner-only materialization:
 *   dmPolicy=allowlist, allowFrom=[ownerId], groupPolicy=disabled, groups={}.
 *
 * `rebindOwner` handles an owner change (new local operator claims/rotates):
 * - owner-only: re-materialize allowFrom=[newOwner] (the old sole grant disappears).
 * - allowlist/custom: update ownerId only; leave allowFrom/groups untouched so a
 *   re-scan / re-claim never silently rewrites a *complex* user-defined policy.
 */
import type { ChannelAccessPolicy } from '@wsz987/channel-core';

/** Keep the persisted policy aligned with its user-facing preset. */
export function materializeAccessPolicy(policy: ChannelAccessPolicy): ChannelAccessPolicy {
  if (policy.preset === 'owner-only') {
    const { defaultGroupRule: _defaultGroupRule, ...rest } = policy;
    return { ...rest, dmPolicy: 'allowlist', allowFrom: policy.ownerId ? [policy.ownerId] : [], groupPolicy: 'disabled', groups: {} };
  }
  if (policy.preset === 'allowlist') {
    const { defaultGroupRule: _defaultGroupRule, ...rest } = policy;
    return { ...rest, dmPolicy: 'allowlist', groupPolicy: 'disabled', groups: {} };
  }
  return policy;
}

/** The canonical owner-only policy materialization (plan §6 / §24 / §25). */
export function ownerOnlyPolicy(ownerId: string): ChannelAccessPolicy {
  return {
    version: 1,
    preset: 'owner-only',
    ownerId,
    dmPolicy: 'allowlist',
    allowFrom: [ownerId],
    groupPolicy: 'disabled',
    groups: {},
  };
}

/**
 * Private messages are platform-restricted to the bot creator. Group access
 * remains disabled until the local operator explicitly configures it.
 */
export function platformPrivatePolicy(): ChannelAccessPolicy {
  return {
    version: 1,
    preset: 'custom',
    dmPolicy: 'open',
    allowFrom: [],
    groupPolicy: 'disabled',
    groups: {},
  };
}

/**
 * Rebind a policy to a new owner identity (plan §25). Returns a NEW policy
 * object; the input is never mutated. When `newOwner` is empty this is a no-op
 * returning the input unchanged (callers guard upstream).
 */
export function rebindOwner(
  policy: ChannelAccessPolicy,
  newOwner: string,
): ChannelAccessPolicy {
  if (!newOwner) return policy;

  if (policy.preset === 'owner-only') {
    // Owner-only: the owner was the sole grantee — re-materialize allowFrom.
    const { defaultGroupRule: _defaultGroupRule, ...base } = policy;
    return {
      ...base,
      ownerId: newOwner,
      allowFrom: [newOwner],
      groupPolicy: 'disabled',
      groups: {},
    };
  }

  // allowlist / custom: only the ownerId changes; allowFrom/groups are preserved.
  return { ...policy, ownerId: newOwner };
}
