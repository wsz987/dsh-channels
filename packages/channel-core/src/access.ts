/**
 * Channel Access Policy — the shared, versioned, cross-package contract for
 * inbound access control (execution plan §4.1, §5, §7, §12, §20).
 *
 * This module defines ONLY stable cross-package semantics:
 *
 * - the `ChannelAccessPolicy` type + zod schema
 * - the versioned storage-key codec (`accessPolicyStorageKey`)
 * - `MessageActivation` (the `activation` fact on a received message)
 * - the reserved owner-claim command constant + parser (`/dsh-claim`)
 *
 * It does NOT implement policy persistence orchestration, the authorization
 * decision, Owner Claim session lifecycle, platform identity parsing, or any
 * Web concerns. Those live in channel-control / channel-harness / channel-web,
 * all of which share ONLY this contract.
 *
 * Policy model:
 *   - Groups support disabled, named allowlist, or global access through an
 *     explicit `defaultGroupRule`.
 *   - `allowFrom: []` means DENY ALL, never "open".
 *   - `requireMention` is an ACTIVATION fact, not authorization, and only
 *     applies in group conversations.
 */
import { z } from 'zod';
import type { MessageId } from './account.js';
import type { MessagePart } from './messages.js';

// ---------------------------------------------------------------------------
// Access policy value types
// ---------------------------------------------------------------------------

/** User-facing preset label. Runtime enforcement never branches on it. */
export type AccessPreset = 'owner-only' | 'allowlist' | 'custom';

export type DirectMessagePolicy = 'disabled' | 'allowlist' | 'open';

export type GroupPolicy = 'disabled' | 'allowlist' | 'open';

/**
 * Within an already explicitly-allowed group:
 *  - `allowlist`: `sender.id` must be present in `rule.allowFrom`
 *  - `open`:      any sender in this NAMED group is authorized
 */
export type GroupSenderPolicy = 'allowlist' | 'open';

export interface GroupAccessRule {
  enabled: boolean;
  senderPolicy: GroupSenderPolicy;
  /** canonical sender.id exact-match allowlist. */
  allowFrom: string[];
  /**
   * Only configurable to `true` when `descriptor.mentions === true`.
   * `undefined !== true`, so a channel without reliable activation facts
   * can never be required to mention (no fail-open).
   */
  requireMention: boolean;
}

export interface ChannelAccessPolicy {
  /**
   * Persistent schema version. Future semantic changes bump this version
   * instead of silently re-interpreting old JSON. Unknown versions are
   * treated as invalid (fail closed).
   */
  version: 1;
  /**
   * Web UX / materialization source only. Runtime enforcement must NOT branch
   * on preset.
   */
  preset: AccessPreset;
  /** The local operator's canonical sender.id (optional until claimed). */
  ownerId?: string;
  /** Private-chat rule. */
  dmPolicy: DirectMessagePolicy;
  /** DM canonical sender.id allowlist (V1 only exists for dmPolicy=allowlist). */
  allowFrom: string[];
  /** Whether groups are disabled, explicitly named, or governed by a default rule. */
  groupPolicy: GroupPolicy;
  /** canonical conversation.id -> rule. */
  groups: Record<string, GroupAccessRule>;
  /** Required only when groupPolicy=open; applies to every inbound group. */
  defaultGroupRule?: GroupAccessRule;
}

// ---------------------------------------------------------------------------
// Zod schema (shared trust boundary — validation.ts / harness resolver reuse it)
// ---------------------------------------------------------------------------

const idSchema = z
  .string()
  .min(1)
  // Trim leading/trailing whitespace is the ONLY allowed normalization. No
  // lowercase, no fuzzy matching, no username resolution. IDs are opaque.
  .trim();

export const accessPresetSchema = z.enum(['owner-only', 'allowlist', 'custom']);
export const directMessagePolicySchema = z.enum(['disabled', 'allowlist', 'open']);
export const groupPolicySchema = z.enum(['disabled', 'allowlist', 'open']);
export const groupSenderPolicySchema = z.enum(['allowlist', 'open']);

export const groupAccessRuleSchema = z.object({
  enabled: z.boolean(),
  senderPolicy: groupSenderPolicySchema,
  allowFrom: z.array(idSchema),
  requireMention: z.boolean(),
});

/**
 * Strict access-policy schema. Matches the persisted `access:policy:v1:*` JSON.
 * Every field is enforced; unknown keys are rejected (a policy JSON must be
 * exactly what we understand). `ownerId` is optional (pre-claim).
 */
export const channelAccessPolicySchema = z
  .object({
    version: z.literal(1),
    preset: accessPresetSchema,
    ownerId: idSchema.optional(),
    dmPolicy: directMessagePolicySchema,
    allowFrom: z.array(idSchema),
    groupPolicy: groupPolicySchema,
    groups: z.record(z.string().trim(), groupAccessRuleSchema),
    defaultGroupRule: groupAccessRuleSchema.optional(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.groupPolicy === 'open') {
      if (!policy.defaultGroupRule) {
        ctx.addIssue({ code: 'custom', path: ['defaultGroupRule'], message: 'required when groupPolicy is open' });
      }
      if (Object.keys(policy.groups).length > 0) {
        ctx.addIssue({ code: 'custom', path: ['groups'], message: 'must be empty when groupPolicy is open' });
      }
      if (policy.defaultGroupRule?.enabled !== true) {
        ctx.addIssue({ code: 'custom', path: ['defaultGroupRule', 'enabled'], message: 'must be enabled when groupPolicy is open' });
      }
    } else if (policy.defaultGroupRule) {
      ctx.addIssue({ code: 'custom', path: ['defaultGroupRule'], message: 'only allowed when groupPolicy is open' });
    }
  });

// ---------------------------------------------------------------------------
// Storage key codec
// ---------------------------------------------------------------------------

/**
 * Shared channel-domain KV namespace for an access policy. Reused by both the
 * channel-control writer and the channel-harness reader so neither hard-codes
 * the other's key format. E.g. `access:policy:v1:telegram:main`.
 */
export function accessPolicyStorageKey(channelId: string, accountId: string): string {
  return `access:policy:v1:${encodeURIComponent(channelId)}:${encodeURIComponent(accountId)}`;
}

// ---------------------------------------------------------------------------
// Reserved owner-claim command
// ---------------------------------------------------------------------------

/**
 * The single reserved control-plane command. It is the ONLY inbound message
 * that may be observed by the Control Plane before any access policy exists,
 * and it MUST never reach the model / command dispatcher / Session / Binding.
 *
 * Format: `/dsh-claim <challengeCode>`
 */
export const OWNER_CLAIM_COMMAND = '/dsh-claim';

export interface ParsedOwnerClaimCommand {
  command: '/dsh-claim';
  /** 8+ character one-time challenge code sent to the bot in a DM. */
  code?: string;
}

/**
 * True when `text` looks like the reserved claim command (exact slash at byte
 * zero — shared with the official parseCommand convention). Both the Harness
 * reserved-claim gate and the Control owner-claim observer use this same rule.
 */
export function isReservedClaimCommand(text: string): boolean {
  if (!text.startsWith(OWNER_CLAIM_COMMAND)) return false;
  const rest = text.slice(OWNER_CLAIM_COMMAND.length);
  return rest.length === 0 || /^\s/.test(rest);
}

/**
 * Parse a `/dsh-claim ...` line into its challenge code, or `undefined` when
 * the text is not a claim command. Only the first whitespace-delimited token
 * after the command is treated as the code; the rest is ignored.
 */
export function parseOwnerClaimCommand(text: string): ParsedOwnerClaimCommand | undefined {
  if (!isReservedClaimCommand(text)) return undefined;
  const rest = text.slice(OWNER_CLAIM_COMMAND.length).trim();
  const code = rest.split(/\s+/)[0];
  return { command: '/dsh-claim', code: code || undefined };
}

// ---------------------------------------------------------------------------
// Message activation fact
// ---------------------------------------------------------------------------

export interface MessageActivation {
  /**
   * Whether this message reliably, explicitly mentions the current Bot.
   * `undefined`/`false` means we have no reliable fact — a rule requiring
   * mention must NOT be treated as activated.
   */
  mentionedBot?: boolean;
  /** Reserved for a future activation policy; V1 does not use it. */
  repliedToBot?: boolean;
}

export interface AccessMessageRef {
  id: MessageId;
  content: MessagePart[];
  replyTo?: MessageId;
  createdAt?: number;
  activation?: MessageActivation;
}

export type { MessageId };
