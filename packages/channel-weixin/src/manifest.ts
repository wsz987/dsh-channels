/**
 * Weixin upstream compatibility manifest (doc section 35 + plan §39).
 *
 * Structural shape matched to `AdapterManifest` so `channels doctor` and the
 * channel-compat governance read it without a package dependency. Tencent's
 * published plugin is OpenClaw-coupled, so this adapter is an explicit
 * source-port/upstream-gap until Tencent publishes a host-neutral package.
 */
import pkg from '../package.json' with { type: 'json' };

/**
 * Upstream strategy, per plan §39:
 *   'official-sdk'                  — consume the official SDK as-is.
 *   'official-host-neutral-subpath' — consume official host-neutral primitives
 *                                     via a single vendor-compat deep-import
 *                                     boundary; composed orchestration stays a
 *                                     thin shim (upstream-gap).
 *   'minimal-official-api-port'     — only the minimum official API ported.
 */
export type UpstreamStrategy =
  | 'official-sdk'
  | 'official-host-neutral-subpath'
  | 'minimal-official-api-port'
  | 'source-port';

export interface WeixinUpstreamManifest {
  reference: string;
  /**
   * Exact upstream version the adapter was verified against. The 'pending'
   * placeholder is filled ONLY after the live platform gate passes (real
   * Weixin iLink live verification); before then it must stay pending.
   */
  testedVersion: string;
  /**
   * Exact Tencent/openclaw-weixin commit SHA the adapter was verified against.
   * Filled ONLY after the live gate passes (same live-verification rule).
   */
  testedCommit?: string;
  /**
   * Range of upstream versions supported. Currently '*', which must NOT be kept
   * long-term: after live verification, pin the verified commit/range here.
   */
  versionRange: string;
  strategy: UpstreamStrategy;
  protocol: 'weixin-ilink';
  /** Official npm package that provides the protocol (plan §39). */
  packageName: string;
  /** npm package source repository (plan §39). */
  sourceRepository: string;
  /** Contract fixtures directory (plan §39). */
  contractFixtures: readonly string[];
}

export interface WeixinManifest {
  id: 'weixin';
  adapterVersion: string;
  upstream: WeixinUpstreamManifest;
  sdk: undefined;
  /**
   * Compatibility state of this adapter against the real Weixin iLink platform.
   *
   * - 'experimental': default BEFORE the live platform gate passes — real-Weixin
   *   live verification is still pending, so claiming 'tested' would be false.
   * - 'tested': only after the live gate passes and the real values are recorded
   *   in `upstream.testedVersion` / `upstream.testedCommit`.
   */
  status: 'experimental' | 'tested';
}

export const manifest: WeixinManifest = {
  id: 'weixin',
  adapterVersion: pkg.version,
  upstream: {
    reference: 'Tencent/openclaw-weixin (source reference; OpenClaw-coupled upstream-gap)',
    // Exact pinned upstream package version consumed via vendor-compat (plan §17/§39).
    testedVersion: '<pending-live-verification>',
    // Placeholder — filled ONLY after the live platform gate passes (see doc R6).
    testedCommit: '<pending-live-verification>',
    // NOTE: must be pinned to the verified commit/range after live verification —
    // do NOT keep versionRange: '*' long-term (doc R6 "不要保留 versionRange: '*' 长期").
    versionRange: '*',
    strategy: 'source-port',
    protocol: 'weixin-ilink',
    // (plan §39) official upstream contract.
    packageName: '@tencent-weixin/openclaw-weixin',
    sourceRepository: 'Tencent/openclaw-weixin',
    contractFixtures: ['fixtures/upstream/weixin/2.4.6/'],
  },
  sdk: undefined,
  status: 'experimental',
};
