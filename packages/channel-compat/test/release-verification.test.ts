/**
 * Release-gate validation + doctor release-verification assertion (R6).
 *
 * Covers the two sides of the Weixin live-gate closure:
 *  - validateManifest: a 'tested' manifest MUST carry real testedVersion /
 *    testedCommit / pinned versionRange; 'experimental' may stay pending.
 *  - releaseVerification / formatDiagnostic: a live-gated channel renders the
 *    release-verification block (BLOCKED while pending, VERIFIED when real).
 */
import { describe, expect, it } from 'vitest';
import {
  formatDiagnostic,
  releaseVerification,
  validateManifest,
  type ChannelDiagnostic,
} from '../src/index.ts';

function manifest(status: string, upstream: Record<string, unknown>): unknown {
  return {
    id: 'weixin',
    adapterVersion: '0.8.1',
    upstream: {
      reference: 'Tencent/openclaw-weixin',
      testedVersion: '0.0.0',
      versionRange: '0.0.0',
      strategy: 'source-port',
      ...upstream,
    },
    status,
  };
}

function diag(overrides: Partial<ChannelDiagnostic> = {}): ChannelDiagnostic {
  return {
    id: 'weixin',
    adapterVersion: '0.8.1',
    upstreamReference: 'Tencent/openclaw-weixin',
    upstreamTestedVersion: '<pending-live-verification>',
    upstreamVersionRange: '*',
    upstreamStrategy: 'source-port',
    upstreamTestedCommit: '<pending-live-verification>',
    validationErrors: [],
    compatibility: 'experimental',
    compatibilityReason: 'weixin is declared experimental; awaiting live verification',
    health: { status: 'down' },
    started: false,
    ...overrides,
  };
}

describe('validateManifest release-gate rules (R6)', () => {
  it('allows experimental with pending placeholders', () => {
    expect(
      validateManifest(
        manifest('experimental', {
          testedVersion: '<pending-live-verification>',
          testedCommit: '<pending-live-verification>',
          versionRange: '*',
        }),
      ),
    ).toEqual([]);
  });

  it('rejects tested with a placeholder testedVersion', () => {
    const errors = validateManifest(
      manifest('tested', {
        testedVersion: '<pending-live-verification>',
        testedCommit: 'a'.repeat(40),
        versionRange: '0.0.0',
      }),
    );
    expect(errors.some((e) => e.includes('testedVersion'))).toBe(true);
  });

  it('rejects tested with a wildcard versionRange', () => {
    const errors = validateManifest(
      manifest('tested', {
        testedVersion: '0.0.0',
        testedCommit: 'a'.repeat(40),
        versionRange: '*',
      }),
    );
    expect(errors.some((e) => e.includes('versionRange'))).toBe(true);
  });

  it('rejects tested with an invalid testedCommit', () => {
    const errors = validateManifest(
      manifest('tested', {
        testedVersion: '0.0.0',
        testedCommit: '<pending-live-verification>',
        versionRange: '0.0.0',
      }),
    );
    expect(errors.some((e) => e.includes('testedCommit'))).toBe(true);
  });

  it('accepts a fully-real tested manifest', () => {
    expect(
      validateManifest(
        manifest('tested', {
          testedVersion: 'ilink-2026-08',
          testedCommit: 'a'.repeat(40),
          versionRange: 'ilink-2026-08',
        }),
      ),
    ).toEqual([]);
  });
});

describe('releaseVerification + formatDiagnostic (R6)', () => {
  it('weixin experimental -> live PENDING -> release BLOCKED', () => {
    const rv = releaseVerification(diag());
    expect(rv.liveGated).toBe(true);
    expect(rv.implementation).toBe('PASS');
    expect(rv.offlineContract).toBe('PASS');
    expect(rv.liveVerification).toBe('PENDING');
    expect(rv.testedCommit).toBe('PENDING');
    expect(rv.releaseStatus).toBe('BLOCKED');
  });

  it('verified weixin -> live PASS -> release VERIFIED', () => {
    const rv = releaseVerification(
      diag({
        compatibility: 'tested',
        upstreamTestedVersion: 'ilink-2026-08',
        upstreamVersionRange: 'ilink-2026-08',
        upstreamTestedCommit: 'a'.repeat(40),
      }),
    );
    expect(rv.liveVerification).toBe('PASS');
    expect(rv.testedCommit).toBe('a'.repeat(40));
    expect(rv.releaseStatus).toBe('VERIFIED');
  });

  it('formatDiagnostic renders the block for a live-gated channel', () => {
    const text = formatDiagnostic(diag());
    expect(text).toContain('Release verification:');
    expect(text).toContain('release status: BLOCKED');
  });

  it('formatDiagnostic omits the block for a non-live-gated (SDK) channel', () => {
    const text = formatDiagnostic(diag({ upstreamTestedCommit: undefined, compatibility: 'tested' }));
    expect(text).not.toContain('Release verification:');
  });
});
