/**
 * DingTalk adapter configuration (Schemastery).
 *
 * Every deployment-tunable parameter is configurable here — no hardcoded
 * deployment constants. Platform credentials live inside the self-hosted HTTP
 * gateway, never in this config and never in logs.
 */
import Schema from '@deepseek-ai/schemastery';

export interface DingTalkReconnectConfig {
  enabled: boolean;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
}

export interface DingTalkDedupConfig {
  enabled: boolean;
  windowMs: number;
}

export interface DingTalkCardConfig {
  /**
   * Create the AI Card on the first streamed delta (eager preview). When
   * `false`, deltas buffer locally and the card is only created at `finish`.
   */
  createOnFirstDelta: boolean;
}

export interface DingTalkConfig {
  enabled: boolean;
  /** Account id within the dingtalk channel (defaults to 'main'). */
  accountId: string;
  /** Base URL of the self-hosted DingTalk HTTP gateway (upstream driver). */
  baseUrl: string;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Long-poll hang time for one receive cycle. */
  longPollTimeoutMs: number;
  reconnect: DingTalkReconnectConfig;
  dedup: DingTalkDedupConfig;
  card: DingTalkCardConfig;
}

export const Config: Schema<DingTalkConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  accountId: Schema.string().default('main'),
  baseUrl: Schema.string().default('http://127.0.0.1:9100'),
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
  card: Schema.object({
    createOnFirstDelta: Schema.boolean().default(true),
  }),
});
