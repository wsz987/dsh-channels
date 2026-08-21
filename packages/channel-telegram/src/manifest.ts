/**
 * Telegram upstream compatibility manifest (M4 pattern).
 *
 * Records the upstream reference and tested version so `channels doctor` and
 * the upgrade pipeline can govern compatibility without re-verifying by hand.
 *
 * Strategy choice: 'source' — the adapter speaks the Telegram Bot API HTTP
 * protocol directly (`/bot<token>/...`), so no platform SDK is consumed.
 * Offline contract and fixture coverage is not a live-platform verification,
 * so the adapter remains experimental until the Telegram live gate passes.
 */
import pkg from '../package.json' with { type: 'json' };

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
  status: 'experimental';
}

/** M5 manifest: direct HTTP protocol, no SDK. */
export const manifest: TelegramManifest = {
  id: 'telegram',
  adapterVersion: pkg.version,
  upstream: {
    reference: 'Telegram Bot API (https://core.telegram.org/bots/api)',
    testedVersion: '10.2',
    versionRange: '>=10.2',
    strategy: 'source',
  },
  sdk: undefined,
  status: 'experimental',
};
