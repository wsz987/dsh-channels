/**
 * DingTalk upstream compatibility manifest (M2).
 *
 * Records the upstream reference and tested version so `channels doctor` and
 * the upgrade pipeline can govern compatibility without re-verifying by hand.
 */

export interface DingTalkUpstreamManifest {
  reference: string;
  testedVersion: string;
  versionRange: string;
  strategy: 'source';
}

export interface DingTalkManifest {
  id: 'dingtalk';
  adapterVersion: string;
  upstream: DingTalkUpstreamManifest;
  sdk: undefined;
  status: 'tested';
}

/** M2 manifest: self-hosted HTTP gateway, protocol-level strategy. */
export const manifest: DingTalkManifest = {
  id: 'dingtalk',
  adapterVersion: '0.7.0',
  upstream: {
    reference: 'dingtalk http gateway (self-hosted, protocol-level)',
    testedVersion: 'm2-http',
    versionRange: '*',
    strategy: 'source',
  },
  sdk: undefined,
  status: 'tested',
};
