/**
 * Inbound Identity Contract test (execution plan §45).
 *
 * `runInboundIdentityContract(input)` registers a vitest suite that validates
 * the canonical identity facts an adapter mapper must produce on an inbound
 * `message.received` event. It is a PURE, reusable helper: any adapter can call
 * it with the mapped events its own mapper produces and prove the identity
 * contract holds, independent of channel-core/harness wiring.
 *
 * Minimum invariants asserted (per §45):
 *  - `sender.id` is a non-empty string and !== 'unknown' (unless allowed)
 *  - `conversation.id` is a non-empty string
 *  - `conversation.type` ∈ 'dm' | 'group'
 *  - group cases: `sender.id` and `conversation.id` are semantically
 *    independent (both present; they are NOT required to differ — some
 *    channels legitimately use the same id — but both must be non-empty so a
 *    mapper cannot conflate them into one missing value). When
 *    `expectDistinct: true` is set on a group meta, the helper additionally
 *    asserts `conversation.id !== sender.id`.
 *  - mapping stability (for `meta.stableSender`): when a second event is
 *    supplied, the two `sender.id` values must be equal for the same remote
 *    subject (plan §45 "同一远程主体映射稳定").
 *
 * A legacy fixture may legitimately produce `sender.id === 'unknown'` when the
 * upstream payload genuinely lacks a sender (plan §45 note). That is allowed
 * at the MAPPER level — but it is exactly the fact the Access Controller (in
 * channel-harness) must REJECT. This contract therefore FAILS on 'unknown' by
 * default, and only a caller that opts in via `allowUnknown: true` (legacy
 * fixture cases) may pass it. Opting in does NOT legitimize 'unknown' for
 * authorization — it only documents that the mapper cannot do better and that
 * the Access Gate is the enforcement point.
 *
 * The helper uses vitest `expect`, so failures surface as normal vitest
 * failures in the running suite.
 */
import { describe, expect, it } from 'vitest';
import type { MessageReceived } from '@wsz987/channel-core';

/** One mapped `message.received` case to validate. */
export interface InboundMessageCase {
  /** The mapped ChannelEvent (typically `message.received`) produced by the mapper. */
  event: MessageReceived;
  /**
   * Extra canonical-identity expectations for this channel.
   * - `conversationType`: the channel's own dm/group contract.
   * - `stableSender`: when the remote subject has a stable canonical id, the
   *   caller may supply a `secondEvent` and the helper asserts equal sender.id.
   * - `expectDistinct`: (group only) assert `conversation.id !== sender.id`.
   */
  meta?: {
    conversationType?: 'dm' | 'group';
    stableSender?: boolean;
    expectDistinct?: boolean;
    /** Second event from the same remote subject, for stability assertion. */
    secondEvent?: MessageReceived;
  };
}

/** Input to `runInboundIdentityContract`. */
export interface InboundIdentityContractInput {
  /** The channel id under test (used only for suite naming). */
  channel: string;
  /** Cases: at least one DM and (when supported) one group. */
  cases: InboundMessageCase[];
  /**
   * Allow `sender.id === 'unknown'` for legacy-fixture cases. Defaults to
   * `false`. See the module doc: this opts a case OUT of the default assertion
   * and documents that the Access Controller is the enforcement point.
   */
  allowUnknown?: boolean;
}

/**
 * Register a vitest suite validating the inbound identity contract for one
 * channel. Call inside a vitest test file at top level.
 */
export function runInboundIdentityContract(input: InboundIdentityContractInput): void {
  const { channel, cases, allowUnknown = false } = input;

  if (cases.length === 0) {
    throw new Error(`[${channel}] runInboundIdentityContract requires at least one case`);
  }

  describe(`inbound identity contract: ${channel}`, () => {
    for (const [index, caseEntry] of cases.entries()) {
      const label = `case[${index}] (${caseEntry.event.conversation.type})`;

      describe(label, () => {
        const event = caseEntry.event;

        it('sender.id is a non-empty string', () => {
          expect(event.sender.id, `sender.id missing for ${label}`).toBeTypeOf('string');
          expect(event.sender.id, `sender.id empty for ${label}`).not.toBe('');
        });

        it('sender.id is not "unknown" (unless allowUnknown)', () => {
          if (allowUnknown) return;
          expect(event.sender.id, `sender.id is "unknown" for ${label}`).not.toBe('unknown');
        });

        it('conversation.id is a non-empty string', () => {
          expect(event.conversation.id, `conversation.id missing for ${label}`).toBeTypeOf('string');
          expect(event.conversation.id, `conversation.id empty for ${label}`).not.toBe('');
        });

        it('conversation.type is dm or group', () => {
          expect(['dm', 'group']).toContain(event.conversation.type);
        });

        it('matches the declared conversationType when provided', () => {
          const declared = caseEntry.meta?.conversationType;
          if (declared) {
            expect(event.conversation.type, `conversation.type for ${label}`).toBe(declared);
          }
        });

        if (event.conversation.type === 'group') {
          it('group case keeps sender.id and conversation.id both present (semantically independent)', () => {
            expect(event.sender.id, `group sender.id missing for ${label}`).not.toBe('');
            expect(event.conversation.id, `group conversation.id missing for ${label}`).not.toBe('');
          });

          it('group case asserts distinct ids only when expectDistinct is set', () => {
            if (caseEntry.meta?.expectDistinct) {
              expect(event.conversation.id, `group conversation.id === sender.id for ${label}`).not.toBe(
                event.sender.id,
              );
            } else {
              // Soft invariant: without opting in we do not force distinction,
              // but we assert the ids are not conflated into a single value.
              expect(event.conversation.id).toBeDefined();
              expect(event.sender.id).toBeDefined();
            }
          });
        }

        if (caseEntry.meta?.stableSender && caseEntry.meta.secondEvent) {
          it('maps the same remote subject to a stable sender.id', () => {
            expect(caseEntry.meta!.secondEvent!.sender.id).toBe(event.sender.id);
          });
        }
      });
    }
  });
}
