/**
 * Upstream Manifest (M0 boundary-lock) tests (plan section 39).
 *
 * Asserts each of the four channels' `UPSTREAM_MANIFESTS` entry matches the
 * fixed baseline in docs/dsh-channels-final-execution-plan-2026-08-16-FINAL.md
 * section 4 EXACTLY: channel ids, package names, tested versions and the
 * integration strategy literal. Also exercises `getUpstreamManifest`.
 */
import { describe, expect, it } from 'vitest';
import { UPSTREAM_MANIFESTS, getUpstreamManifest } from '../src/index.ts';
import weixinPkg from '../../channel-weixin/package.json' with { type: 'json' };
import qqPkg from '../../channel-qq/package.json' with { type: 'json' };
import larkPkg from '../../channel-lark/package.json' with { type: 'json' };
import dingtalkPkg from '../../channel-dingtalk/package.json' with { type: 'json' };

/** The three strategy literals allowed by plan section 39. */
const STRATEGIES = ['official-sdk', 'official-host-neutral-subpath', 'minimal-official-api-port', 'source-port'] as const;

describe('UPSTREAM_MANIFESTS (plan §39 boundary lock)', () => {
  it('contains exactly the four official channels keyed by id', () => {
    expect(UPSTREAM_MANIFESTS.map((m) => m.channel).sort()).toEqual(['dingtalk', 'lark', 'qq', 'weixin']);
    expect(new Set(UPSTREAM_MANIFESTS.map((m) => m.channel)).size).toBe(4);
  });

  it('uses only the three allowed strategy literals', () => {
    for (const m of UPSTREAM_MANIFESTS) {
      expect((STRATEGIES as readonly string[])).toContain(m.strategy);
    }
  });

  it('all entries carry a packageName, testedVersion and sourceRepository', () => {
    for (const m of UPSTREAM_MANIFESTS) {
      expect(m.packageName.length).toBeGreaterThan(0);
      expect(m.testedVersion.length).toBeGreaterThan(0);
      expect(m.sourceRepository.length).toBeGreaterThan(0);
      expect(Array.isArray(m.contractFixtures)).toBe(true);
    }
  });

  it('weixin: Tencent plugin source reference / source-port', () => {
    const m = getUpstreamManifest('weixin');
    expect(m).toBeDefined();
    expect(m!.packageName).toBe('@tencent-weixin/openclaw-weixin');
    expect(m!.testedVersion).toBe('2.4.6');
    expect(m!.strategy).toBe('source-port');
    expect(m!.sourceRepository).toBe('Tencent/openclaw-weixin');
  });

  it('qq: @tencent-connect/qqbot-nodejs@1.0.4 / official-sdk', () => {
    const m = getUpstreamManifest('qq');
    expect(m).toBeDefined();
    expect(m!.packageName).toBe('@tencent-connect/qqbot-nodejs');
    expect(m!.testedVersion).toBe('1.0.4');
    expect(m!.strategy).toBe('official-sdk');
    expect(m!.sourceRepository).toBe('tencent-connect/openclaw-qqbot');
  });

  it('lark: @larksuiteoapi/node-sdk@1.73.0 / official-sdk', () => {
    const m = getUpstreamManifest('lark');
    expect(m).toBeDefined();
    expect(m!.packageName).toBe('@larksuiteoapi/node-sdk');
    expect(m!.testedVersion).toBe('1.73.0');
    expect(m!.strategy).toBe('official-sdk');
    expect(m!.sourceRepository).toBe('larksuite/openclaw-lark');
  });

  it('dingtalk: dingtalk-stream@2.1.5 / minimal-official-api-port', () => {
    const m = getUpstreamManifest('dingtalk');
    expect(m).toBeDefined();
    expect(m!.packageName).toBe('dingtalk-stream');
    expect(m!.testedVersion).toBe('2.1.5');
    expect(m!.strategy).toBe('minimal-official-api-port');
    expect(m!.sourceRepository).toBe('DingTalk-Real-AI/dingtalk-openclaw-connector');
    // The 0.8.24 oracle connector fixture anchor must be present.
    expect(m!.contractFixtures).toContain('fixtures/upstream/dingtalk/0.8.24/');
  });

  it('getUpstreamManifest(unknown) returns undefined', () => {
    expect(getUpstreamManifest('telegram')).toBeUndefined();
  });
});

describe('M8 exact-pin / package.json drift discipline (plan §17/§72)', () => {
  it('weixin does not install the OpenClaw-coupled Tencent plugin', () => {
    const range = weixinPkg.dependencies['@tencent-weixin/openclaw-weixin'];
    expect(range).toBeUndefined();
  });

  it('each channel package.json pins the upstream version from UPSTREAM_MANIFESTS', () => {
    const byChannel: Record<string, { deps: Record<string, string>; manifest: (typeof UPSTREAM_MANIFESTS)[number] }> = {
      qq: { deps: qqPkg.dependencies, manifest: getUpstreamManifest('qq')! },
      lark: { deps: larkPkg.dependencies, manifest: getUpstreamManifest('lark')! },
      dingtalk: { deps: dingtalkPkg.dependencies, manifest: getUpstreamManifest('dingtalk')! },
    };
    for (const [channel, { deps, manifest }] of Object.entries(byChannel)) {
      const pinned = deps[manifest.packageName];
      expect(pinned, `${channel} must declare ${manifest.packageName}`).toBeDefined();
      expect(pinned, `${channel} ${manifest.packageName} should match upstream testedVersion`).toBe(
        manifest.testedVersion,
      );
    }
  });
});
