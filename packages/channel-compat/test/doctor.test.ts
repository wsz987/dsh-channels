/**
 * Tests for the channels doctor / compatibility layer (Tasks 13.1–13.3).
 *
 * Covers the structural manifest reader, the version-state policy, the
 * per-adapter diagnostics produced by `diagnose`, the Task 13.2 text layout,
 * and the integration contract: the real Weixin/DingTalk adapters expose a
 * structurally readable manifest without being started.
 */
import { describe, expect, it } from 'vitest';
import { FakeChannelAdapter } from '@dsh/channel-testkit';
import type { ChannelHealth } from '@dsh/channel-core';
import {
  diagnose,
  formatDoctor,
  formatDiagnostic,
  getAdapterManifest,
  manifestVerdict,
  satisfiesVersion,
  validateManifest,
  versionState,
  type AdapterManifest,
  type ChannelDiagnostic,
  type ManifestStatus,
} from '../src/index.ts';
import { WeixinAdapter } from '../../channel-weixin/src/adapter.ts';
import { Config as WeixinConfig } from '../../channel-weixin/src/config.ts';
import { DingTalkAdapter } from '../../channel-dingtalk/src/adapter.ts';
import { Config as DingTalkConfig } from '../../channel-dingtalk/src/config.ts';

/** Build a manifest fixture, structurally compatible with `AdapterManifest`. */
function makeManifest(overrides: Partial<AdapterManifest> = {}): AdapterManifest {
  return {
    id: 'test',
    adapterVersion: '1.0.0',
    upstream: {
      reference: 'upstream gateway',
      testedVersion: '1.0.0',
      versionRange: '*',
      strategy: 'source',
    },
    status: 'tested',
    ...overrides,
  };
}

/** Minimal adapter that carries a manifest and a fixed health surface. */
class ManifestAdapter {
  readonly id: string;
  readonly manifest: AdapterManifest;
  private readonly health: ChannelHealth;

  constructor(id: string, manifest: AdapterManifest, health: ChannelHealth = { status: 'ok' }) {
    this.id = id;
    this.manifest = manifest;
    this.health = health;
  }

  async getHealth(): Promise<ChannelHealth> {
    return this.health;
  }
}

describe('getAdapterManifest (Task 13.1 structural guard)', () => {
  it('reads a manifest from weixin-shaped and dingtalk-shaped objects', () => {
    const weixin = {
      manifest: {
        id: 'weixin',
        adapterVersion: '0.8.1',
        upstream: {
          reference: 'weixin http gateway',
          testedVersion: 'm1-http',
          versionRange: '*',
          strategy: 'source',
        },
        sdk: undefined,
        status: 'tested' as const,
      },
    };
    const dingtalk = {
      manifest: {
        id: 'dingtalk',
        adapterVersion: '0.7.0',
        upstream: {
          reference: 'dingtalk http gateway',
          testedVersion: 'm2-http',
          versionRange: '*',
          strategy: 'source',
        },
        sdk: { package: 'dingtalk-stream', testedVersion: '2.1.4' },
        status: 'tested' as const,
      },
    };

    expect(getAdapterManifest(weixin)?.id).toBe('weixin');
    expect(getAdapterManifest(weixin)?.status).toBe('tested');
    expect(getAdapterManifest(dingtalk)?.id).toBe('dingtalk');
    expect(getAdapterManifest(dingtalk)?.sdk).toEqual({ package: 'dingtalk-stream', testedVersion: '2.1.4' });
  });

  it('returns undefined for plain adapters and non-objects', () => {
    expect(getAdapterManifest(new FakeChannelAdapter())).toBeUndefined();
    expect(getAdapterManifest({ id: 'plain', start() {}, stop() {}, send() {} })).toBeUndefined();
    expect(getAdapterManifest(null)).toBeUndefined();
    expect(getAdapterManifest(undefined)).toBeUndefined();
    expect(getAdapterManifest(42)).toBeUndefined();
    expect(getAdapterManifest({ manifest: 'not-an-object' })).toBeUndefined();
  });

  it('rejects structurally invalid manifests', () => {
    expect(
      getAdapterManifest({ manifest: { id: 'x', adapterVersion: '1.0.0', upstream: {}, status: 'tested' } }),
    ).toBeUndefined();
    expect(
      getAdapterManifest({ manifest: { id: 'x', adapterVersion: '1.0.0', upstream: { reference: '', testedVersion: '', versionRange: '', strategy: '' }, status: 'bogus' } }),
    ).toBeUndefined();
  });
});

describe('validateManifest', () => {
  it('returns no errors for a valid manifest', () => {
    expect(validateManifest(makeManifest())).toEqual([]);
  });

  it('reports missing or malformed fields', () => {
    expect(validateManifest({})).not.toEqual([]);
    expect(validateManifest({ ...makeManifest(), adapterVersion: '' })).toContain(
      'manifest.adapterVersion must be a non-empty string',
    );
    expect(validateManifest({ ...makeManifest(), upstream: { reference: 'r' } })).toContain(
      'manifest.upstream.testedVersion must be a non-empty string',
    );
    expect(validateManifest(null)).toContain('manifest is not an object');
  });
});

describe('versionState + manifestVerdict (Task 13.3)', () => {
  it('resolves tested / compatible / untested / unsupported states', () => {
    expect(versionState(makeManifest({ status: 'tested' })).state).toBe('tested');
    expect(versionState(makeManifest({ status: 'compatible' })).state).toBe('compatible');
    expect(versionState(makeManifest({ status: 'untested' })).state).toBe('untested');
    expect(versionState(makeManifest({ status: 'unsupported' })).state).toBe('unsupported');
  });

  it('applies the default policy: tested/compatible ok, untested warning, unsupported fail unless overridden', () => {
    expect(manifestVerdict('tested')).toBe('ok');
    expect(manifestVerdict('compatible')).toBe('ok');
    expect(manifestVerdict('untested')).toBe('warning');
    expect(manifestVerdict('unsupported')).toBe('fail');
    expect(manifestVerdict('unsupported', { allowUnsupported: true })).toBe('warning');
  });

  it('downgrades to untested when the target version falls outside the declared range', () => {
    const manifest = makeManifest({
      status: 'tested',
      upstream: { reference: 'r', testedVersion: '0.8.20', versionRange: '>=0.8.20 <0.9.0', strategy: 'source' },
    });
    const ok = versionState(manifest, { targetVersion: '0.8.25' });
    expect(ok.state).toBe('tested');

    const out = versionState(manifest, { targetVersion: '0.9.1' });
    expect(out.state).toBe('untested');
    expect(out.reason).toContain('0.9.1');
  });

  it('treats unsupported as authoritative even when the target is in range', () => {
    const result = versionState(makeManifest({ status: 'unsupported' }), { targetVersion: '0.8.25' });
    expect(result.state).toBe('unsupported');
    expect(result.reason).toContain('allowUnsupported');
  });

  it('satisfiesVersion checks ranges best-effort', () => {
    expect(satisfiesVersion('0.8.25', '>=0.8.20 <0.9.0')).toBe(true);
    expect(satisfiesVersion('0.9.1', '>=0.8.20 <0.9.0')).toBe(false);
    expect(satisfiesVersion('0.8.20', '>=0.8.20')).toBe(true);
    expect(satisfiesVersion('0.8.19', '>=0.8.20')).toBe(false);
    expect(satisfiesVersion('0.8.25', '*')).toBe(true);
    expect(satisfiesVersion('0.8.25', '')).toBe(true);
  });
});

describe('diagnose (Task 13.2)', () => {
  it('reports an untested plain adapter without a manifest', async () => {
    const [d] = await diagnose([new FakeChannelAdapter()]);
    expect(d).toBeDefined();
    expect(d!.id).toBe('fake');
    expect(d!.compatibility).toBe('untested');
    expect(d!.compatibilityReason).toContain('does not expose a compatibility manifest');
    expect(d!.health.status).toBe('ok');
    expect(d!.connection).toBe('disconnected');
    expect(d!.auth).toBeUndefined();
    expect(d!.started).toBe(false);
  });

  it('reads manifest fields and health for an adapter with a manifest', async () => {
    const adapter = new ManifestAdapter(
      'fake-manifest',
      makeManifest({
        id: 'fake-manifest',
        adapterVersion: '2.0.0',
        upstream: { reference: 'upstream gateway', testedVersion: '1.0.0', versionRange: '*', strategy: 'source' },
      }),
      { status: 'ok', connection: 'connected', authenticated: true },
    );
    const [d] = await diagnose([adapter]);
    expect(d!.id).toBe('fake-manifest');
    expect(d!.adapterVersion).toBe('2.0.0');
    expect(d!.upstreamReference).toBe('upstream gateway');
    expect(d!.upstreamTestedVersion).toBe('1.0.0');
    expect(d!.compatibility).toBe('tested');
    expect(d!.health.status).toBe('ok');
    expect(d!.connection).toBe('connected');
    expect(d!.auth).toBe('authenticated');
  });

  it('reports an adapter whose getHealth returns down', async () => {
    const adapter = new ManifestAdapter(
      'down',
      makeManifest({ id: 'down', status: 'tested' }),
      { status: 'down', detail: 'upstream unreachable', connection: 'disconnected', authenticated: false },
    );
    const [d] = await diagnose([adapter]);
    expect(d!.health.status).toBe('down');
    expect(d!.health.detail).toBe('upstream unreachable');
    expect(d!.connection).toBe('disconnected');
    expect(d!.auth).toBeUndefined();
  });

  it('applies a target version to the compatibility policy', async () => {
    const adapter = new ManifestAdapter(
      'range-check',
      makeManifest({
        id: 'range-check',
        status: 'tested',
        upstream: { reference: 'r', testedVersion: '0.8.20', versionRange: '>=0.8.20 <0.9.0', strategy: 'source' },
      }),
    );
    const [d] = await diagnose([adapter], { targetVersion: '0.9.1' });
    expect(d!.compatibility).toBe('untested');
  });

  it('survives an adapter whose getHealth throws', async () => {
    const adapter = {
      id: 'broken',
      async getHealth(): Promise<ChannelHealth> {
        throw new Error('boom');
      },
    };
    const [d] = await diagnose([adapter]);
    expect(d!.id).toBe('broken');
    expect(d!.health.status).toBe('down');
    expect(d!.compatibility).toBe('untested');
  });
});

describe('formatDoctor (Task 13.2 layout)', () => {
  it('renders the expected text lines for a dingtalk-shaped diagnostic', () => {
    const diagnostic: ChannelDiagnostic = {
      id: 'dingtalk',
      adapterVersion: '0.7.0',
      upstreamReference: 'dingtalk http gateway (self-hosted, protocol-level)',
      upstreamTestedVersion: 'm2-http',
      upstreamVersionRange: '*',
      upstreamStrategy: 'source',
      compatibility: 'tested',
      compatibilityReason: 'dingtalk 0.7.0 tested against upstream m2-http',
      connection: 'connected',
      auth: 'authenticated',
      health: { status: 'ok' },
      started: false,
    };
    const text = formatDiagnostic(diagnostic);
    const lines = text.split('\n');
    expect(lines[0]).toBe('dingtalk');
    expect(lines).toContain('Adapter: 0.7.0');
    expect(lines).toContain('SDK: undefined');
    expect(lines).toContain('Compatibility: tested');
    expect(lines).toContain('Connection: connected');
    expect(lines).toContain('Health: ok');
  });

  it('renders the SDK line when a manifest declares one', () => {
    const diagnostic: ChannelDiagnostic = {
      id: 'dingtalk',
      adapterVersion: '0.7.0',
      upstreamReference: 'r',
      upstreamTestedVersion: '1.0.0',
      upstreamVersionRange: '*',
      upstreamStrategy: 'source',
      sdk: { package: 'dingtalk-stream', testedVersion: '2.1.4' },
      compatibility: 'tested',
      compatibilityReason: 'ok',
      connection: 'connected',
      health: { status: 'ok' },
      started: false,
    };
    const text = formatDiagnostic(diagnostic);
    expect(text).toContain('SDK: dingtalk-stream 2.1.4');
  });

  it('renders multiple diagnostics separated by a blank line', () => {
    const a: ChannelDiagnostic = {
      id: 'weixin',
      adapterVersion: '0.8.1',
      upstreamReference: 'r',
      upstreamTestedVersion: '1.0.0',
      upstreamVersionRange: '*',
      upstreamStrategy: 'source',
      compatibility: 'tested',
      compatibilityReason: 'ok',
      connection: 'connected',
      health: { status: 'ok' },
      started: false,
    };
    const b: ChannelDiagnostic = {
      id: 'dingtalk',
      adapterVersion: '0.7.0',
      upstreamReference: 'r',
      upstreamTestedVersion: '1.0.0',
      upstreamVersionRange: '*',
      upstreamStrategy: 'source',
      compatibility: 'untested',
      compatibilityReason: 'no evidence',
      connection: 'disconnected',
      health: { status: 'degraded' },
      started: false,
    };
    const text = formatDoctor([a, b]);
    expect(text).toContain('weixin\nAdapter: 0.8.1');
    expect(text).toContain('\n\ndingtalk\n');
    expect(text).toContain('Note: no evidence');
  });
});

describe('integration: real adapters expose a readable manifest', () => {
  it('WeixinAdapter carries a structurally readable tested manifest', () => {
    const adapter = new WeixinAdapter(
      WeixinConfig({
        enabled: true,
        accountId: 'main',
        baseUrl: 'http://fake',
        timeoutMs: 1000,
        longPollTimeoutMs: 1000,
        auth: { statePath: undefined, qrPollIntervalMs: 100, qrExpireMs: 10000 },
        reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
        dedup: { enabled: true, windowMs: 5000 },
      }),
    );
    expect(adapter.manifest).toBeDefined();
    const manifest = getAdapterManifest(adapter);
    expect(manifest?.id).toBe('weixin');
    expect(manifest?.status).toBe('tested');
    expect(manifest?.adapterVersion).toBe('0.8.1');
    expect(adapter.id).toBe('weixin');
  });

  it('DingTalkAdapter carries a structurally readable tested manifest', () => {
    const adapter = new DingTalkAdapter(
      DingTalkConfig({
        enabled: true,
        accountId: 'main',
        baseUrl: 'http://fake',
        timeoutMs: 1000,
        longPollTimeoutMs: 1000,
        reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
        dedup: { enabled: true, windowMs: 5000 },
        card: { createOnFirstDelta: true },
      }),
    );
    expect(adapter.manifest).toBeDefined();
    const manifest = getAdapterManifest(adapter);
    expect(manifest?.id).toBe('dingtalk');
    expect(manifest?.status).toBe('tested');
    expect(manifest?.adapterVersion).toBe('0.7.0');
    expect(adapter.id).toBe('dingtalk');
  });
});
