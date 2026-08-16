/**
 * Upstream Compatibility Manifest.
 *
 * A fixed, declarative record of the official platform upstream each channel
 * adapter is verified against — the "Upstream Boundary Lock" from ADR 0001
 * (docs/architecture/adr/0001-upstream-first-channel-platform-boundary.md).
 * It pins package names, tested versions, integration strategy, source
 * repository and the contract-fixture directories for the four official
 * channels.
 *
 * This module is self-contained and has NO dependency on doctor.ts. It only
 * describes upstream facts; it never changes doctor behavior.
 */

/** The three integration strategies allowed by plan section 39. */
export type UpstreamStrategy =
  | 'official-sdk'
  | 'official-host-neutral-subpath'
  | 'minimal-official-api-port'
  | 'source-port';

/**
 * Fixed upstream compatibility baseline for one channel (plan section 4 / 39).
 *
 * - channel      : channel id 'weixin' | 'qq' | 'lark' | 'dingtalk'.
 * - packageName  : npm package of the upstream being verified against.
 * - testedVersion: exact version the adapter is verified against.
 * - strategy     : one of the three integration strategies from plan section 39.
 * - sourceRepository: official upstream repo (owner/repo).
 * - contractFixtures: fixture directories (plan section 73) holding this channel's
 *                  raw inbound / media / target / error / send-shape contracts.
 */
export interface UpstreamManifest {
  channel: string;
  packageName: string;
  testedVersion: string;
  strategy: UpstreamStrategy;
  sourceRepository: string;
  contractFixtures: readonly string[];
}

/**
 * The four channels' fixed upstream baseline (plan section 4 / 39 / 106).
 *
 * - weixin   : official-host-neutral-subpath. Exact pin
 *               @tencent-weixin/openclaw-weixin@2.4.6, single vendor-compat
 *               boundary (plan section 14 / 39).
 * - qq       : official-sdk — @tencent-connect/qqbot-nodejs@1.0.4 (section 2/21).
 * - lark     : official-sdk — @larksuiteoapi/node-sdk@1.73.0 (section 2/25).
 * - dingtalk : minimal-official-api-port — dingtalk-stream@2.1.5 + oracle
 *               connector @dingtalk-real-ai/dingtalk-connector@0.8.24 (plan
 *               section 2/30/39; oracle recorded below AND as a fixing anchor
 *               inside contractFixtures).
 */
export const UPSTREAM_MANIFESTS: readonly UpstreamManifest[] = [
  {
    channel: 'weixin',
    packageName: '@tencent-weixin/openclaw-weixin',
    testedVersion: '2.4.6',
    strategy: 'source-port',
    sourceRepository: 'Tencent/openclaw-weixin',
    contractFixtures: ['fixtures/upstream/weixin/2.4.6/'],
  },
  {
    channel: 'qq',
    packageName: '@tencent-connect/qqbot-nodejs',
    testedVersion: '1.0.4',
    strategy: 'official-sdk',
    sourceRepository: 'tencent-connect/openclaw-qqbot',
    contractFixtures: ['fixtures/upstream/qq/2.0.1/'],
  },
  {
    channel: 'lark',
    packageName: '@larksuiteoapi/node-sdk',
    testedVersion: '1.73.0',
    strategy: 'official-sdk',
    sourceRepository: 'larksuite/openclaw-lark',
    contractFixtures: ['fixtures/upstream/lark/2026.7.9/'],
  },
  {
    // dingtalk upstream = dingtalk-stream@2.1.5 (inbound) + minimal OAPI port.
    // Oracle whose OAPI payloads we mirror (plan section 2/30/39):
    //   @dingtalk-real-ai/dingtalk-connector@0.8.24, repo DingTalk-Real-AI/
    //   dingtalk-openclaw-connector. NOT a runtime dependency — the behavior oracle only.
    channel: 'dingtalk',
    packageName: 'dingtalk-stream',
    testedVersion: '2.1.5',
    strategy: 'minimal-official-api-port',
    sourceRepository: 'DingTalk-Real-AI/dingtalk-openclaw-connector',
    contractFixtures: [
      // 2.1.5 = inbound stream SDK version; 0.8.24 = OAPI payload oracle pinned
      // to connector@0.8.24 (plan section 39).
      'fixtures/upstream/dingtalk/2.1.5/',
      'fixtures/upstream/dingtalk/0.8.24/',
    ],
  },
];

/** Look up one channel's fixed upstream manifest (plan section 39). */
export function getUpstreamManifest(channel: string): UpstreamManifest | undefined {
  return UPSTREAM_MANIFESTS.find((m) => m.channel === channel);
}
