/**
 * Lark upstream compatibility manifest (M3).
 *
 * Records the upstream reference and tested version so `channels doctor` and
 * the upgrade pipeline can govern compatibility without re-verifying by hand.
 */

export interface LarkUpstreamManifest {
  reference: string;
  testedVersion: string;
  versionRange: string;
  strategy: 'source';
}

export interface LarkManifest {
  id: 'lark';
  adapterVersion: string;
  upstream: LarkUpstreamManifest;
  sdk: undefined;
  status: 'tested';
}

/** M3 manifest: self-hosted HTTP gateway, protocol-level strategy. */
export const manifest: LarkManifest = {
  id: 'lark',
  adapterVersion: '0.6.3',
  upstream: {
    reference: 'lark http gateway (self-hosted, protocol-level)',
    testedVersion: 'm3-http',
    versionRange: '*',
    strategy: 'source',
  },
  sdk: undefined,
  status: 'tested',
};
