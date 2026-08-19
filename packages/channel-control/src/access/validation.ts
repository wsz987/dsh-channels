/**
 * Access Policy validation — the entry constrains what a policy may express
 * against a channel's declared access descriptor (execution plan §31).
 *
 * Validation is two-layered:
 * 1. The shared `channelAccessPolicySchema` (version pinning, canonical id
 *    trimming, strict unknown-key rejection, type checks).
 * 2. Descriptor-relative rules (owner-only needs an ownerId, mentions/groups/
 *    DM capability gating).
 *
 * Normalization performed on a validated policy: trim canonical ids and remove
 * EXACT duplicates in every `allowFrom` list. Deliberately NO lowercase, no
 * username resolution, no fuzzy matching — ids are opaque.
 */
import {
  channelAccessPolicySchema,
  type ChannelAccessPolicy,
} from '@wsz987/channel-core';
import type { ChannelAccessDescriptor } from '../types.js';

export type AccessValidationResult =
  | { ok: true; policy: ChannelAccessPolicy }
  | { ok: false; error: string };

/** Remove exact duplicated strings while preserving first-seen order. */
function dedupeExact(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Validate a candidate policy against a channel descriptor and, when valid,
 * return a normalized copy (ids trimmed by the schema, `allowFrom` de-duplicated).
 */
export function validateAccessPolicy(
  input: ChannelAccessPolicy,
  descriptor: ChannelAccessDescriptor,
): AccessValidationResult {
  const parsed = channelAccessPolicySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: `invalid policy: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}` };
  }
  // From here on we work on the canonical, schema-validated policy.
  const policy = parsed.data;

  if (policy.preset === 'owner-only' && (!policy.ownerId || policy.ownerId === '')) {
    return { ok: false, error: 'owner-only preset requires an ownerId' };
  }

  // requireMention=true is only expressible when the channel can detect mentions.
  for (const [groupId, rule] of Object.entries(policy.groups)) {
    if (rule.requireMention && descriptor.mentions !== true) {
      return {
        ok: false,
        error: `group '${groupId}' requires mention but channel does not support mentions`,
      };
    }
  }

  // A channel without groups cannot carry any group configuration.
  const hasGroupConfig =
    policy.groupPolicy !== 'disabled' || Object.keys(policy.groups).length > 0;
  if (hasGroupConfig && descriptor.groups !== true) {
    return { ok: false, error: 'policy configures groups but channel does not support groups' };
  }

  // Channel with direct messages disabled must keep DM fully disabled.
  if (descriptor.directMessages !== true && policy.dmPolicy !== 'disabled') {
    return { ok: false, error: 'policy enables direct messages but channel does not support them' };
  }

  // Channel without groups must keep group policy disabled.
  if (descriptor.groups !== true && policy.groupPolicy !== 'disabled') {
    return { ok: false, error: 'policy enables groups but channel does not support them' };
  }

  // ---------------------------------------------------------------------------
  // Normalization (trim + exact dedupe). The schema already trims ids; here we
  // additionally de-duplicate allowFrom lists. No lowercase / fuzzy matching.
  // ---------------------------------------------------------------------------
  const groups: ChannelAccessPolicy['groups'] = {};
  for (const [groupId, rule] of Object.entries(policy.groups)) {
    groups[groupId] = { ...rule, allowFrom: dedupeExact(rule.allowFrom) };
  }

  const normalized: ChannelAccessPolicy = {
    ...policy,
    allowFrom: dedupeExact(policy.allowFrom),
    groups,
  };

  return { ok: true, policy: normalized };
}
