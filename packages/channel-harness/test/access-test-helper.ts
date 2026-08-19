import type { ChannelAccessPolicy } from '@wsz987/channel-core';
import type { ChannelAccessPolicyResolver } from '../src/access/resolver.js';

const allowAllPolicy: ChannelAccessPolicy = {
  version: 1,
  preset: 'custom',
  dmPolicy: 'open',
  allowFrom: [],
  groupPolicy: 'allowlist',
  groups: {
    oc_456: {
      enabled: true,
      senderPolicy: 'open',
      allowFrom: [],
      requireMention: false,
    },
  },
};

/** Explicit test-only admission policy for bridge tests unrelated to ACL. */
export const allowAllAccessResolver: ChannelAccessPolicyResolver = {
  async resolve() {
    return { state: 'present', policy: allowAllPolicy };
  },
};
