/**
 * QQ upstream compatibility manifest (official WebSocket gateway driver).
 *
 * Records the upstream reference and tested version so `channels doctor` and
 * the upgrade pipeline can govern compatibility without re-verifying by hand.
 *
 * Strategy: 'source' — the official QQ 开放平台机器人 WebSocket gateway
 * protocol is implemented directly in this package (no third-party SDK):
 * token auth, gateway connect/identify/heartbeat/reconnect, C2C / group-@
 * dispatch, and v2 OpenAPI outbound sends. The legacy self-hosted HTTP
 * gateway driver remains behind `config.upstream.mode: 'gateway'`.
 *
 * Status 'tested' is justified by the Channel Contract + fixture tests plus
 * the SDK-mode offline tests (local mock WebSocket gateway + fake fetch)
 * passing — fully offline. Live verification against a real QQ app
 * (AppId/ClientSecret) is a manual step.
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

/** Current manifest: official WebSocket gateway protocol (isolated source). */
export const manifest: QQManifest = {
  id: 'qq',
  adapterVersion: '0.5.4',
  upstream: {
    reference:
      'QQ 开放平台机器人 WebSocket 网关 (https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html)',
    testedVersion: 'v2',
    versionRange: '*',
    strategy: 'source',
  },
  sdk: undefined,
  status: 'tested',
};
