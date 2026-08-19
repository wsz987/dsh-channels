/**
 * Activation (mention) Contract test (execution plan §46).
 *
 * `runActivationContract(input)` registers a vitest suite verifying that a
 * channel supporting mention produces CONCRETE, reliable boolean activation
 * facts on its mapped inbound events.
 *
 * A channel may only flip `descriptor.mentions = true` after both the
 * with-mention and without-mention fixtures AND this contract pass (plan §13).
 * It must NOT pass on `undefined` — an empty activation fact would otherwise
 * let a rule requiring a mention silently fail-open.
 *
 * Assertions:
 *  - `withMention.message.activation?.mentionedBot === true`
 *  - `withoutMention.message.activation?.mentionedBot === false`
 *
 * Pure and reusable: any adapter passes the two mapped events its own mapper
 * produces. Failures surface as normal vitest failures.
 */
import { describe, expect, it } from 'vitest';
import type { MessageReceived } from '@wsz987/channel-core';

/** Input to `runActivationContract`. */
export interface ActivationContractInput {
  /** Cases, each a mapped event. */
  withMention: MessageReceived; // must have event.message.activation?.mentionedBot === true
  withoutMention: MessageReceived; // must have event.message.activation?.mentionedBot === false
}

/**
 * Register a vitest suite validating that a channel's mapped activation facts
 * are concrete booleans (never `undefined`). `=== true`/`=== false` guarantees
 * undefined does not pass. Call inside a vitest test file at top level.
 */
export function runActivationContract(input: ActivationContractInput): void {
  const { withMention, withoutMention } = input;

  describe('activation contract (mention)', () => {
    it('with-mention message produces activation.mentionedBot === true', () => {
      expect(withMention.message.activation?.mentionedBot).toBe(true);
    });

    it('without-mention message produces activation.mentionedBot === false', () => {
      expect(withoutMention.message.activation?.mentionedBot).toBe(false);
    });
  });
}
