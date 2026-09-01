/**
 * Pure mapping of QQ `interaction` events → canonical `interaction.received`.
 *
 * The QQ `InteractionEvent` is UNTRUSTED platform input, so it is validated
 * with a zod schema at the trust boundary (skill hard rule: zod `safeParse`
 * for all external input; never cast). Validation failure or an ambiguous
 * conversation is a logged drop — never a throw, never a guessed event.
 *
 * The adapter only emits the canonical event here; authorization (Access Gate)
 * belongs to `channel-harness`, never to this adapter (red line 13).
 */
import type {
  AccountId,
  ChannelId,
  ConversationId,
  InteractionReceived,
  SenderId,
} from '@wsz987/channel-core';
import { z } from 'zod';
import type { QQInboundMeta } from './mapper.js';

/**
 * Zod schema for the interaction payload slice the adapter consumes. Unknown
 * fields are stripped by default (never read by this mapper), so no
 * `passthrough`/`loose` is needed; the fields that matter for identity and
 * round-trip are strictly typed.
 */
const qqInteractionSchema = z.object({
  id: z.string().min(1),
  chat_type: z.number().optional(),
  user_openid: z.string().min(1).optional(),
  group_openid: z.string().min(1).optional(),
  group_member_openid: z.string().min(1).optional(),
  data: z
    .object({
      resolved: z
        .object({
          button_id: z.string().min(1).optional(),
          button_data: z.string().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
});

/** Fail-closed drop reason for a QQ interaction that cannot be mapped. */
export type QQInteractionDropReason =
  | 'invalid-payload'
  | 'ambiguous-conversation'
  | 'missing-action';

export type QQInteractionMapping =
  | { ok: true; event: InteractionReceived }
  | { ok: false; reason: QQInteractionDropReason };

/**
 * Map a QQ `InteractionEvent` (untrusted) to a canonical `InteractionReceived`,
 * or a fail-closed drop reason.
 *
 * Conversation derivation mirrors the message mapper conventions:
 * - C2C   → `user_openid` present (and no group ids) → conversation.id =
 *   `user_openid`, type `dm`, sender = `user_openid`;
 * - Group → `group_openid` + `group_member_openid` present →
 *   conversation.id = `group_openid`, type `group`, sender =
 *   `group_member_openid`.
 *
 * Anything else (no openids, or a mix that cannot be pinned to one
 * conversation) fails closed — never guess a conversation (security doc:
 * unidentified sender / invalid conversation → DENY).
 *
 * The action id is recovered from `data.resolved.button_data` (the verbatim
 * echo of the outbound button's `action.data`) with `button_id` as fallback;
 * a press that carries neither cannot be correlated and is dropped.
 */
export function mapInteraction(raw: unknown, meta: QQInboundMeta): QQInteractionMapping {
  const parsed = qqInteractionSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid-payload' };
  }
  const interaction = parsed.data;

  const userOpenid = interaction.user_openid;
  const groupOpenid = interaction.group_openid;
  const groupMemberOpenid = interaction.group_member_openid;

  let conversationId: string;
  let conversationType: 'dm' | 'group';
  let senderId: string;

  if (userOpenid !== undefined && groupOpenid === undefined && groupMemberOpenid === undefined) {
    conversationId = userOpenid;
    conversationType = 'dm';
    senderId = userOpenid;
  } else if (groupOpenid !== undefined && groupMemberOpenid !== undefined) {
    conversationId = groupOpenid;
    conversationType = 'group';
    senderId = groupMemberOpenid;
  } else {
    return { ok: false, reason: 'ambiguous-conversation' };
  }

  const resolved = interaction.data?.resolved;
  const action = resolved?.button_data ?? resolved?.button_id;
  if (action === undefined) {
    return { ok: false, reason: 'missing-action' };
  }

  return {
    ok: true,
    event: {
      type: 'interaction.received',
      channel: meta.channel as ChannelId,
      accountId: meta.accountId as AccountId,
      conversation: { id: conversationId as ConversationId, type: conversationType },
      sender: { id: senderId as SenderId },
      interactionId: interaction.id,
      // The recovered `uq_*` action id rides verbatim; the adapter never
      // parses it into Harness question semantics (red line 5).
      action,
      // Debug-only raw payload (core/bridge never depend on its shape).
      raw,
    },
  };
}
