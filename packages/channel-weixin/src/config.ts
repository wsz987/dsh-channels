/**
 * Weixin adapter configuration (Schemastery).
 *
 * Per doc section 29 — the channels-weixin config exposes iLink base URLs,
 * network timeouts and reconnect policy. Credentials are NEVER configured in
 * YAML; they live in the read/write credential store resolved at start.
 */
import Schema from '@deepseek-ai/schemastery';
import { DEFAULT_BASE_URL, DEFAULT_CDN_BASE_URL } from './ilink/constants.js';

export interface WeixinIlinkConfig {
  /** API base URL; may be redirected per-account after QR login. */
  baseUrl: string;
  /** CDN base URL for media. */
  cdnBaseUrl: string;
  /** bot_agent value sent in base_info. */
  botAgent?: string;
}

export interface WeixinNetworkConfig {
  /** Per-request timeout in ms. */
  timeoutMs: number;
  /** Initial getUpdates long-poll timeout in ms. */
  longPollTimeoutMs: number;
}

export interface WeixinReconnectConfig {
  enabled: boolean;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface WeixinConfig {
  enabled: boolean;
  /** Local DSH account alias; default 'main'. */
  accountId: string;
  ilink: WeixinIlinkConfig;
  network: WeixinNetworkConfig;
  reconnect: WeixinReconnectConfig;
}

export const Config: Schema<WeixinConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  accountId: Schema.string().default('main'),
  ilink: Schema.object({
    baseUrl: Schema.string().default(DEFAULT_BASE_URL).description('Weixin iLink API base URL'),
    cdnBaseUrl: Schema.string().default(DEFAULT_CDN_BASE_URL).description('Weixin CDN base URL'),
    botAgent: Schema.string().description('bot_agent value for base_info'),
  }),
  network: Schema.object({
    timeoutMs: Schema.natural().default(15000),
    longPollTimeoutMs: Schema.natural().default(35000),
  }),
  reconnect: Schema.object({
    enabled: Schema.boolean().default(true),
    baseDelayMs: Schema.natural().default(2000),
    maxDelayMs: Schema.natural().default(30000),
  }),
});
