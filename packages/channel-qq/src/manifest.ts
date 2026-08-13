/**
 * QQ upstream compatibility manifest (M3).
 *
 * Records the upstream reference and tested version so `channels doctor` and
 * the upgrade pipeline can govern compatibility without re-verifying by hand.
 */

export interface QQUpstreamManifest {
  reference: string;
  testedVersion: string;
  versionRange: string;
  strategy: 'source';
}

export interface QQManifest {
  id: 'qq';
  adapterVersion: string;
  upstream: QQUpstreamManifest;
  sdk: undefined;
  status: 'tested';
}

/** M3 manifest: self-hosted HTTP gateway, protocol-level strategy. */
export const manifest: QQManifest = {
  id: 'qq',
  adapterVersion: '0.5.4',
  upstream: {
    reference: 'qq http gateway (self-hosted, protocol-level)',
    testedVersion: 'm3-http',
    versionRange: '*',
    strategy: 'source',
  },
  sdk: undefined,
  status: 'tested',
};
