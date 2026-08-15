/**
 * M5.1 — real Harness live-Session contract (plan §21 revision).
 *
 * The official Workspace `attachSession()` reads the target session's header
 * FIRST from the live store (`ctx.sessions.get(id)` → `header.cwd`), only
 * falling back to persistence (`readSessionHeader`). This test pins that
 * live-store contract against the REAL `SessionStore` from
 * `@deepseek-ai/dsh-session` (a dependency of this package), rather than a
 * fake: it proves a published session exposes its `header.cwd` exactly as the
 * caller supplied, and that a non-absolute cwd is rejected at publication —
 * the two invariants the channel Session factory and
 * the Workspace canonical-cwd membership check both depend on.
 *
 * The full `dsh-workspace.attachSession()` (realpath + directory + canonical
 * cwd equality) is NOT exercised here because `@deepseek-ai/dsh-workspace` is
 * not a dependency of this repo; that check runs against the Host's own
 * Workspace package at runtime (see AGENTS.md §2).
 */
import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';

describe('M5.1 real Harness live-Session contract', () => {
  it('a published session exposes header.cwd exactly as supplied (live readSessionHeader branch)', () => {
    const ctx = new Context();
    const sessions = new SessionStore(ctx);

    const cwd = 'C:\\Users\\test\\.dsh\\workspaces\\channels\\weixin\\1f8a20';
    const sessionId = SessionId('ch-live-contract');
    const session = sessions.create(sessionId, { meta: { cwd } });

    // Core assertion: the live store returns the published session with the
    // exact header.cwd the official Workspace membership check reads.
    const live = ctx.sessions.get(sessionId);
    expect(live).toBeDefined();
    expect(live!.header.cwd).toBe(cwd);
    expect(session.header.cwd).toBe(cwd);
  });

  it('SessionStore rejects a non-absolute cwd at publication (resolver must emit absolute paths)', () => {
    const ctx = new Context();
    const sessions = new SessionStore(ctx);

    // The channel resolver joins an absolute root, so a relative cwd here
    // would indicate a resolver bug — the real store fails loudly instead of
    // silently publishing a session the Workspace could never attach.
    expect(() =>
      sessions.create(SessionId('ch-relative'), { meta: { cwd: 'workspaces/channels/weixin/x' } }),
    ).toThrow(/absolute/);
  });

  it('a second create on the same id rejects (no silent overwrite of a live session)', () => {
    const ctx = new Context();
    const sessions = new SessionStore(ctx);
    const sessionId = SessionId('ch-dup');
    sessions.create(sessionId, { meta: { cwd: 'C:\\tmp' } });
    expect(() => sessions.create(sessionId, { meta: { cwd: 'C:\\tmp' } })).toThrow();
  });
});
