/**
 * Lark upstream compatibility manifest.
 *
 * Records the upstream reference and tested version so `channels doctor` and
 * the upgrade pipeline can govern compatibility without re-verifying by hand.
 *
 * Strategy: 'sdk' — inbound rides the official `@larksuiteoapi/node-sdk`
 * (WebSocket long-connection, `im.message.receive_v1` + `card.action.trigger`)
 * and outbound rides the same SDK's OpenAPI client (`im.v1.message.create` /
 * `patch`, media uploads, CardKit 2.0 card entities + native streaming).
 * There is no self-hosted gateway.
 *
 * Status 'tested' is justified by the Channel Contract + fixture tests plus
 * the official-SDK offline tests (fake WS client, real EventDispatcher) —
 * fully offline. Live verification against a real Lark app (AppId/AppSecret),
 * its published permissions and event subscriptions is a manual step and is
 * LIVE-REQUIRED before the adapter may be claimed live-tested.
 */
import pkg from '../package.json' with { type: 'json' };

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
  adapterVersion: pkg.version,
  upstream: {
    reference: 'larksuite/node-sdk (https://github.com/larksuite/node-sdk)',
    testedVersion: '1.73.1',
    versionRange: '1.73.1',
    strategy: 'sdk',
  },
  sdk: {
    package: '@larksuiteoapi/node-sdk',
    testedVersion: '1.73.1',
  },
  status: 'tested',
};
