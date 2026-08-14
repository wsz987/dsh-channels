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
  testedVersion: string;
  testedCommit?: string;
  versionRange: string;
  strategy: 'source-port';
  protocol: 'weixin-ilink';
}

export interface WeixinManifest {
  id: 'weixin';
  adapterVersion: string;
  upstream: WeixinUpstreamManifest;
  sdk: undefined;
  status: 'tested';
}

export const manifest: WeixinManifest = {
  id: 'weixin',
  adapterVersion: pkg.version,
  upstream: {
    reference: 'Tencent/openclaw-weixin (direct Weixin iLink client, source-port)',
    testedVersion: '<pending-live-verification>',
    testedCommit: '<pending-live-verification>',
    versionRange: '*',
    strategy: 'source-port',
    protocol: 'weixin-ilink',
  },
  sdk: undefined,
  status: 'tested',
};
