/**
 * Weixin upstream compatibility manifest (execution plan Task 13.1).
 *
 * Records the upstream reference and tested version so `channels doctor` and
 * the upgrade pipeline can govern compatibility without re-verifying by hand.
 */

export interface WeixinUpstreamManifest {
  reference: string;
  testedVersion: string;
  versionRange: string;
  strategy: 'source';
}

export interface WeixinManifest {
  id: 'weixin';
  adapterVersion: string;
  upstream: WeixinUpstreamManifest;
  sdk: undefined;
  status: 'tested';
}

/** M1 manifest: self-hosted HTTP gateway, protocol-level strategy. */
export const manifest: WeixinManifest = {
  id: 'weixin',
  adapterVersion: '0.8.1',
  upstream: {
    reference: 'weixin http gateway (self-hosted, protocol-level)',
    testedVersion: 'm1-http',
    versionRange: '*',
    strategy: 'source',
  },
  sdk: undefined,
  status: 'tested',
};
