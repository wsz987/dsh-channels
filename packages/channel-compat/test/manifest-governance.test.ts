/**
 * Manifest governance (M4 — `pnpm check:manifests`).
 *
 * Verifies that all four official channel adapters keep their upstream
 * compatibility manifest in sync: the manifest validates cleanly, is declared
 * `tested`, carries non-empty upstream fields, and `adapterVersion` matches
 * the package.json version (so a release bump cannot silently drift the
 * manifest). Also unit-tests `checkAdapterCompatibility` — the M4
 * governance-layer aggregation.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkAdapterCompatibility,
  validateManifest,
  type AdapterManifest,
} from '../src/index.ts';
import { manifest as weixinManifest } from '../../channel-weixin/src/manifest.ts';
import { manifest as dingtalkManifest } from '../../channel-dingtalk/src/manifest.ts';
import { manifest as qqManifest } from '../../channel-qq/src/manifest.ts';
import { manifest as larkManifest } from '../../channel-lark/src/manifest.ts';

const testDir = dirname(fileURLToPath(import.meta.url));

/** Read a sibling adapter package's version from its package.json. */
function packageVersion(packageName: string): string {
  const raw = readFileSync(join(testDir, '..', '..', packageName, 'package.json'), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

const channels = [
  { id: 'weixin', manifest: weixinManifest, package: 'channel-weixin', status: 'experimental' as const },
  { id: 'dingtalk', manifest: dingtalkManifest, package: 'channel-dingtalk', status: 'tested' as const },
  { id: 'qq', manifest: qqManifest, package: 'channel-qq', status: 'tested' as const },
  { id: 'lark', manifest: larkManifest, package: 'channel-lark', status: 'tested' as const },
] as const;

/** Wrap a manifest in a minimal adapter-shaped object for the compat check. */
function manifestAdapter(manifest: AdapterManifest): { id: string; manifest: AdapterManifest } {
  return { id: manifest.id, manifest };
}

describe('manifest governance (all four channels)', () => {
  for (const { id, manifest, package: pkg, status } of channels) {
    it(`${id}: manifest validates cleanly`, () => {
      expect(validateManifest(manifest)).toEqual([]);
    });

    it(`${id}: declared ${status} with non-empty upstream fields`, () => {
      expect(manifest.status).toBe(status);
      expect(manifest.upstream.reference.length).toBeGreaterThan(0);
      expect(manifest.upstream.testedVersion.length).toBeGreaterThan(0);
      expect(manifest.upstream.versionRange.length).toBeGreaterThan(0);
      expect(manifest.upstream.strategy.length).toBeGreaterThan(0);
    });

    it(`${id}: adapterVersion matches the package.json version`, () => {
      expect(manifest.adapterVersion).toBe(packageVersion(pkg));
    });
  }
});

describe('checkAdapterCompatibility (M4 aggregation)', () => {
  it('reports untested/warning for an adapter without a manifest', () => {
    const result = checkAdapterCompatibility({ id: 'plain', start() {}, stop() {}, send() {} });
    expect(result.manifest).toBeUndefined();
    expect(result.validationErrors).toEqual([]);
    expect(result.state).toBe('untested');
    expect(result.verdict).toBe('warning');
    expect(result.reason).toContain('does not expose a compatibility manifest');
  });

  it('reports experimental/warning for the weixin manifest', () => {
    const result = checkAdapterCompatibility(manifestAdapter(weixinManifest));
    expect(result.manifest?.id).toBe('weixin');
    expect(result.validationErrors).toEqual([]);
    expect(result.state).toBe('experimental');
    expect(result.verdict).toBe('warning');
    expect(result.reason).toContain('experimental');
  });

  it('reports unsupported/fail unless allowUnsupported is set', () => {
    const unsupported = manifestAdapter({ ...weixinManifest, status: 'unsupported' });
    const fail = checkAdapterCompatibility(unsupported);
    expect(fail.state).toBe('unsupported');
    expect(fail.verdict).toBe('fail');

    const warn = checkAdapterCompatibility(unsupported, { allowUnsupported: true });
    expect(warn.state).toBe('unsupported');
    expect(warn.verdict).toBe('warning');
  });

  it('downgrades to untested when the target version falls outside the declared range', () => {
    const ranged = manifestAdapter({
      ...weixinManifest,
      upstream: {
        ...weixinManifest.upstream,
        testedVersion: '0.8.20',
        versionRange: '>=0.8.20 <0.9.0',
      },
    });
    const result = checkAdapterCompatibility(ranged, { targetVersion: '0.9.1' });
    expect(result.state).toBe('untested');
    expect(result.verdict).toBe('warning');
    expect(result.reason).toContain('0.9.1');
  });
});
