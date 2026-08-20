/**
 * Pure Inbound Access Controller (execution plan §18, §19).
 *
 * NO I/O, NO imports of storage/adapters/model. This is a deterministic pure
 * function of a resolved policy + inbound identity facts. The bridge resolves
 * the policy, then feeds both into `authorize` and acts ONLY on the returned
 * decision (drop when !authorized or !activated).
 *
 * Algorithm (§19.1 DM / §19.2 Group):
 *  - DM: disabled -> DENY; open -> ALLOW; allowlist -> allowFrom includes
 *    senderId ? ALLOW : DENY (empty allowFrom == DENY ALL, never open).
 *  - Group: groupPolicy disabled -> DENY; allowlist -> groups[conversationId]
 *    must exist; open -> defaultGroupRule must exist. The selected rule
 *    must be enabled; then the
 *    sender gate (allowlist/open); finally the ACTIVATION gate: requireMention
 *    without mentionedBot === true is NOT activated (`undefined !== true`, no
 *    fail-open — plan §14).
 *
 * The plan separates the Security Gate (authorized) from the Activation Gate
 * (activated). `reason` is always the single most-specific cause.
 */
import type { ChannelAccessPolicy } from '@wsz987/channel-core';
import type { InboundAccessDecision } from './decision.js';

export interface InboundAccessInput {
  conversationType: 'dm' | 'group';
  senderId: string;
  conversationId: string;
  /** Adapter-supplied activation fact; `undefined`/`false` is never "mentioned". */
  mentionedBot?: boolean;
  policy: ChannelAccessPolicy;
}

export class InboundAccessController {
  authorize(input: InboundAccessInput): InboundAccessDecision {
    if (input.conversationType === 'dm') {
      return this.authorizeDm(input);
    }
    return this.authorizeGroup(input);
  }

  private authorizeDm(input: InboundAccessInput): InboundAccessDecision {
    const { policy, senderId } = input;

    if (policy.dmPolicy === 'disabled') {
      return { authorized: false, activated: false, reason: 'dm_disabled' };
    }
    if (policy.dmPolicy === 'open') {
      return { authorized: true, activated: true, reason: 'allowed' };
    }
    // policy.dmPolicy === 'allowlist' (incl. allowFrom = []).
    if (policy.allowFrom.includes(senderId)) {
      return { authorized: true, activated: true, reason: 'allowed' };
    }
    return { authorized: false, activated: false, reason: 'user_not_allowed' };
  }

  private authorizeGroup(input: InboundAccessInput): InboundAccessDecision {
    const { policy, senderId, conversationId, mentionedBot } = input;

    if (policy.groupPolicy === 'disabled') {
      return { authorized: false, activated: false, reason: 'group_disabled' };
    }

    const rule = policy.groupPolicy === 'open'
      ? policy.defaultGroupRule
      : policy.groups[conversationId];
    if (!rule) {
      return { authorized: false, activated: false, reason: 'group_not_allowed' };
    }
    if (rule.enabled !== true) {
      return { authorized: false, activated: false, reason: 'group_disabled' };
    }

    // Sender gate.
    if (rule.senderPolicy === 'allowlist') {
      if (!rule.allowFrom.includes(senderId)) {
        return { authorized: false, activated: false, reason: 'group_user_not_allowed' };
      }
    }
    // senderPolicy === 'open' -> any sender in this NAMED group is authorized.

    // Activation gate (§14): requireMention without a reliable mention is NOT
    // activated (undefined !== true, never fail-open).
    if (rule.requireMention && mentionedBot !== true) {
      return { authorized: true, activated: false, reason: 'mention_required' };
    }

    return { authorized: true, activated: true, reason: 'allowed' };
  }
}
