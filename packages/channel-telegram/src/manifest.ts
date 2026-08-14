/**
 * Telegram upstream compatibility manifest (M4 pattern).
 *
 * Records the upstream reference and tested version so `channels doctor` and
 * the upgrade pipeline can govern compatibility without re-verifying by hand.
 *
 * Strategy choice: 'source' — the adapter speaks the Telegram Bot API HTTP
 * protocol directly (`/bot<token>/...`), so no platform SDK is consumed.
 * Status 'tested' is justified by the Channel Contract + fixture tests
 * passing against the fake transport (fully offline, Bot API 7.10 shapes).
 */
export interface TelegramUpstreamManifest {
  reference: string;
  testedVersion: string;
  versionRange: string;
  strategy: 'source';
}

export interface TelegramManifest {
  id: 'telegram';
  adapterVersion: string;
  upstream: TelegramUpstreamManifest;
  sdk: undefined;
  status: 'tested';
}

/** M5 manifest: direct HTTP protocol, no SDK. */
export const manifest: TelegramManifest = {
  id: 'telegram',
  adapterVersion: '0.1.0',
  upstream: {
    reference: 'Telegram Bot API (https://core.telegram.org/bots/api)',
    testedVersion: '7.10',
    versionRange: '*',
    strategy: 'source',
  },
  sdk: undefined,
  status: 'tested',
};
