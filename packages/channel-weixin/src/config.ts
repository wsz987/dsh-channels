/**
 * Weixin adapter configuration (Schemastery).
 *
 * Every deployment-tunable parameter is configurable here — no hardcoded
 * deployment constants. Credentials never belong here or in logs.
 */
import Schema from '@deepseek-ai/schemastery';

export interface WeixinAuthConfig {
  /** Optional JSON file path for persisting auth state across restarts. */
  statePath?: string;
  /** How often QR auth state is polled. */
  qrPollIntervalMs: number;
  /** QR code expiry budget in milliseconds. */
  qrExpireMs: number;
}

export interface WeixinReconnectConfig {
  enabled: boolean;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
}

export interface WeixinDedupConfig {
  enabled: boolean;
  windowMs: number;
}

export interface WeixinConfig {
  enabled: boolean;
  /** Account id within the weixin channel (defaults to 'main'). */
  accountId: string;
  /** Base URL of the weixin HTTP gateway (only used by the upstream driver). */
  baseUrl: string;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Long-poll hang time for one receive cycle. */
  longPollTimeoutMs: number;
  auth: WeixinAuthConfig;
  reconnect: WeixinReconnectConfig;
  dedup: WeixinDedupConfig;
}

export const Config: Schema<WeixinConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  accountId: Schema.string().default('main'),
  baseUrl: Schema.string().default('http://127.0.0.1:9000'),
  timeoutMs: Schema.natural().default(30000),
  longPollTimeoutMs: Schema.natural().default(25000),
  auth: Schema.object({
    statePath: Schema.string(),
    qrPollIntervalMs: Schema.natural().default(3000),
    qrExpireMs: Schema.natural().default(120000),
  }),
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
