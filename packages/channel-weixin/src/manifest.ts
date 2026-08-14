/**
 * Weixin upstream compatibility manifest (doc section 35).
 *
 * Structural shape matched to `AdapterManifest` so `channels doctor` and the
 * channel-compat governance read it without a package dependency. The iLink
 * protocol derives from Tencent/openclaw-weixin (source-port strategy).
 */
import pkg from '../package.json' with { type: 'json' };

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
  strategy: 'source-port';
  protocol: 'weixin-ilink';
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
    reference: 'Tencent/openclaw-weixin (direct Weixin iLink client, source-port)',
    // Placeholders — filled ONLY after the live gate passes (see doc R6).
    testedVersion: '<pending-live-verification>',
    testedCommit: '<pending-live-verification>',
    // NOTE: must be pinned to the verified commit/range after live verification —
    // do NOT keep versionRange: '*' long-term (doc R6 "不要保留 versionRange: '*' 长期").
    versionRange: '*',
    strategy: 'source-port',
    protocol: 'weixin-ilink',
  },
  sdk: undefined,
  status: 'experimental',
};
