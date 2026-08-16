/**
 * DingTalk upstream compatibility manifest (M2 + SDK driver).
 *
 * Records the upstream reference and tested version so `channels doctor` and
 * the upgrade pipeline can govern compatibility without re-verifying by hand.
 *
 * Strategy: 'sdk' — inbound rides the official `dingtalk-stream` SDK
 * (WebSocket stream mode). Outbound (message send / AI Card) is not part of
 * the stream SDK; it uses the message-scoped `sessionWebhook` and DingTalk's
 * official AI Card OpenAPI through the shared HTTP transport.
 *
 * Status 'tested' is justified by the Channel Contract + fixture tests plus
 * the SDK-mode offline tests (fake stream client) passing — fully offline.
 * Live verification against a real DingTalk app (AppKey/AppSecret) is a
 * manual step.
 */
import pkg from '../package.json' with { type: 'json' };

export interface DingTalkUpstreamManifest {
  reference: string;
  testedVersion: string;
  versionRange: string;
  strategy: 'sdk' | 'source';
}

/** Official SDK consumed by the upstream driver, when one is used. */
export interface DingTalkSdkManifest {
  /** npm package name of the official SDK. */
  package: string;
  /** Version the adapter was verified against. */
  testedVersion: string;
}

export interface DingTalkManifest {
  id: 'dingtalk';
  adapterVersion: string;
  upstream: DingTalkUpstreamManifest;
  sdk: DingTalkSdkManifest | undefined;
  status: 'tested';
}

/** Current manifest: inbound via the official dingtalk-stream SDK. */
export const manifest: DingTalkManifest = {
  id: 'dingtalk',
  adapterVersion: pkg.version,
  upstream: {
    reference: 'open-dingtalk/dingtalk-stream-sdk-nodejs (https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)',
    testedVersion: '2.1.5',
    versionRange: '2.1.5',
    strategy: 'sdk',
  },
  sdk: {
    package: 'dingtalk-stream',
    testedVersion: '2.1.5',
  },
  status: 'tested',
};
