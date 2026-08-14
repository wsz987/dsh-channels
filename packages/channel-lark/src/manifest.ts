/**
 * Lark upstream compatibility manifest (M3 + SDK driver).
 *
 * Records the upstream reference and tested version so `channels doctor` and
 * the upgrade pipeline can govern compatibility without re-verifying by hand.
 *
 * Strategy: 'sdk' — inbound rides the official `@larksuiteoapi/node-sdk`
 * (WebSocket long-connection, `im.message.receive_v1`). Outbound (message
 * send / media / editable card) is not part of the WS long-connection event
 * path; it uses the HTTP transport (self-hosted gateway endpoints in this
 * iteration).
 *
 * Status 'tested' is justified by the Channel Contract + fixture tests plus
 * the SDK-mode offline tests (fake WS client, real EventDispatcher) passing
 * — fully offline. Live verification against a real Lark app (AppId/AppSecret)
 * is a manual step.
 */

export interface LarkUpstreamManifest {
  reference: string;
  testedVersion: string;
  versionRange: string;
  strategy: 'sdk' | 'source';
}

/** Official SDK consumed by the upstream driver, when one is used. */
export interface LarkSdkManifest {
  /** npm package name of the official SDK. */
  package: string;
  /** Version the adapter was verified against. */
  testedVersion: string;
}

export interface LarkManifest {
  id: 'lark';
  adapterVersion: string;
  upstream: LarkUpstreamManifest;
  sdk: LarkSdkManifest | undefined;
  status: 'tested';
}

/** Current manifest: inbound via the official @larksuiteoapi/node-sdk. */
export const manifest: LarkManifest = {
  id: 'lark',
  adapterVersion: '0.6.3',
  upstream: {
    reference: 'larksuite/node-sdk (https://github.com/larksuite/node-sdk)',
    testedVersion: '1.73.0',
    versionRange: '*',
    strategy: 'sdk',
  },
  sdk: {
    package: '@larksuiteoapi/node-sdk',
    testedVersion: '1.73.0',
  },
  status: 'tested',
};