/**
 * Harness compat checks — regression suite for the minimal `HarnessPort`.
 *
 * These verify that the core bridge flow an adapter pipeline depends on is
 * usable on the given port: resolveAgent → followup → session event stream →
 * dispose. They only exercise the `HarnessPort` surface (never Harness
 * internals), so the same checks can later be wired into channel-harness
 * regression testing as-is.
 */
import { describe, expect, it } from 'vitest';
import type { HarnessPort } from './fake-harness.js';

export interface HarnessCompatOptions {
  /**
   * Out-of-band way to make the port produce a session event. FakeHarness
   * implementations can wire this to `emitSessionEvent()`.
   */
  emitEvent?: (sessionId: string, event: unknown) => void;
}

/**
 * Register the compat checks for a minimal Harness port. Safe to call inside
 * any vitest suite; all checks pass against `FakeHarness`.
 */
export function runHarnessCompatChecks(port: HarnessPort, options: HarnessCompatOptions = {}): void {
  describe('harness compat: minimal port', () => {
    it('resolveAgent returns a stable agent id per session', async () => {
      const first = await port.resolveAgent('session-a');
      const second = await port.resolveAgent('session-a');
      expect(first.id).toBeTypeOf('string');
      expect(second.id).toBe(first.id);
    });

    it('resolveAgent returns distinct agents across sessions', async () => {
      const a = await port.resolveAgent('session-x');
      const b = await port.resolveAgent('session-y');
      expect(a.id).not.toBe(b.id);
    });

    it('followup accepts input for a resolved agent', async () => {
      const { id } = await port.resolveAgent('session-f');
      await expect(port.followup(id, { turn: 1 })).resolves.toBeUndefined();
      await expect(port.followup(id, { turn: 2 })).resolves.toBeUndefined();
    });

    it('streamEvents delivers session events until unsubscribed', async () => {
      const seen: unknown[] = [];
      const unsubscribe = port.streamEvents('session-s', (event) => seen.push(event));
      if (options.emitEvent) {
        options.emitEvent('session-s', { type: 'agent.reply', text: 'ok' });
        expect(seen).toHaveLength(1);
        unsubscribe();
        options.emitEvent('session-s', { type: 'agent.reply', text: 'late' });
        expect(seen).toHaveLength(1);
      } else {
        // Without an emit hook, verify subscribe/unsubscribe round-trips.
        unsubscribe();
      }
    });

    it('resolveAgent dispose resolves', async () => {
      const { id, dispose } = await port.resolveAgent('session-d');
      expect(id).toBeTypeOf('string');
      await expect(dispose()).resolves.toBeUndefined();
    });
  });
}
