/**
 * <ChannelName> adapter configuration (Schemastery).
 *
 * Every deployment-tunable parameter is configurable here — no hardcoded
 * deployment constants. Platform credentials live inside the self-hosted HTTP
 * gateway / SDK, never in this config and never in logs.
 *
 * Replace the placeholder type/field names when renaming the channel:
 * `ChannelConfig` → `<ChannelName>Config` (e.g. `TelegramConfig`).
 */
import Schema from '@deepseek-ai/schemastery';

export interface ChannelReconnectConfig {
  enabled: boolean;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
}

export interface ChannelDedupConfig {
  enabled: boolean;
  windowMs: number;
}

export interface ChannelConfig {
  enabled: boolean;
  /** Account id within the channel (defaults to 'main'). */
  accountId: string;
  /** Base URL of the self-hosted HTTP gateway (upstream driver). */
  baseUrl: string;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Long-poll hang time for one receive cycle. */
  longPollTimeoutMs: number;
  reconnect: ChannelReconnectConfig;
  dedup: ChannelDedupConfig;
}

export const Config: Schema<ChannelConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  accountId: Schema.string().default('main'),
  baseUrl: Schema.string().default('http://127.0.0.1:9200'),
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
