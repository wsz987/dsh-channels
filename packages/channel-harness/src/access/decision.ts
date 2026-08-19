/**
 * Access decision types (execution plan §18, §53).
 *
 * `AccessDecisionReason` enumerates every fail-closed outcome the Harness
 * Access Gate can produce. `InboundAccessDecision` is the pure controller's
 * output: `authorized` = the security gate passed; `activated` = the activation
 * gate passed; `reason` is the singular, most specific cause (see §19).
 *
 * These types are intentionally free of I/O concerns — the controller that
 * produces them never touches storage, adapters or the model.
 */
export type AccessDecisionReason =
  | 'allowed'
  | 'missing_policy'
  | 'invalid_policy'
  | 'unidentified_sender'
  | 'invalid_conversation'
  | 'dm_disabled'
  | 'user_not_allowed'
  | 'group_disabled'
  | 'group_not_allowed'
  | 'group_user_not_allowed'
  | 'mention_required';

export interface InboundAccessDecision {
  authorized: boolean;
  activated: boolean;
  reason: AccessDecisionReason;
}
