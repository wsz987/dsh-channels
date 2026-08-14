/**
 * Telegram adapter configuration (Schemastery).
 *
 * Every deployment-tunable parameter is configurable here — no hardcoded
 * deployment constants. The Bot API token is the only credential: it is
 * optional (tests and fixtures carry none), is never logged, and is never
 * written into fixture files (§23 security baseline).
 */
import Schema from '@deepseek-ai/schemastery';

export interface TelegramReconnectConfig {
  enabled: boolean;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
}

export interface TelegramDedupConfig {
  enabled: boolean;
  windowMs: number;
}

export interface TelegramConfig {
  enabled: boolean;
  /** Account id within the telegram channel (defaults to 'main'). */
  accountId: string;
  /** Base URL of the Telegram Bot API. */
  baseUrl: string;
  /**
   * Bot API token (`123456:ABC-...`). Optional so tests and fixtures carry
   * none; without a token the adapter reports health 'down' and skips the
   * receive loop entirely. The token is never logged and only ever appears
   * in the Bot API request path built by the upstream driver.
   */
  token?: string;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Long-poll hang time for one getUpdates cycle. */
  longPollTimeoutMs: number;
  reconnect: TelegramReconnectConfig;
  dedup: TelegramDedupConfig;
}

export const Config: Schema<TelegramConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  accountId: Schema.string().default('main'),
  baseUrl: Schema.string().default('https://api.telegram.org'),
  token: Schema.string(),
  timeoutMs: Schema.natural().default(30000),
  longPollTimeoutMs: Schema.natural().default(25000),
  reconnect: Schema.object({
    enabled: Schema.boolean().default(true),
    baseDelayMs: Schema.natural().default(1000),
    maxDelayMs: Schema.natural().default(30000),
    maxRetries: Schema.natural().default(10),
  }),
  dedup: Schema.object({
    enabled: Schema.boolean().default(true),
    windowMs: Schema.natural().default(5000),
  }),
});
