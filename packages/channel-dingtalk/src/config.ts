/**
 * DingTalk adapter configuration (Schemastery).
 *
 * Every deployment-tunable parameter is configurable here — no hardcoded
 * deployment constants. In 'gateway' mode platform credentials live inside the
 * self-hosted HTTP gateway; in 'sdk' mode the DingTalk AppKey (clientId) is
 * configured here as `upstream.clientId` while the AppSecret is resolved
 * through `ctx.credentials` from the reference `upstream.clientSecretRef`
 * (default `DSH_CHANNEL_DINGTALK_MAIN_CLIENT_SECRET`) and injected into the
 * adapter as `deps.clientSecret`. Only the reference name — never the secret
 * value — lives in config; credentials are never logged and never written into
 * fixtures.
 *
 * A deprecated optional `upstream.clientSecret` field is kept so legacy
 * plaintext configs still parse. It is migration-only: apply() writes its value
 * into the credentials seam a single time and deletes it (see index.ts). It is
 * never written and never read to build the SDK client.
 */
import Schema from '@deepseek-ai/schemastery';

/** Credential reference name for the DingTalk AppSecret (SDK mode, default). */
export const DINGTALK_CLIENT_SECRET_REF = 'DSH_CHANNEL_DINGTALK_MAIN_CLIENT_SECRET';

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

/**
 * Upstream driver selection.
 *
 * - `'sdk'`     — inbound via the official `dingtalk-stream` SDK (WebSocket
 *                stream mode). Outbound (message send / AI card) still rides
 *                the HTTP transport against `baseUrl` in this iteration.
 * - `'gateway'` — inbound via the self-hosted HTTP gateway long-poll driver
 *                (legacy protocol-level integration; outbound unchanged).
 */
export interface DingTalkUpstreamConfig {
  mode: 'sdk' | 'gateway';
  /** DingTalk AppKey (clientId) for SDK mode. Not a secret — may live in config. */
  clientId?: string;
  /**
   * Credential reference name for the DingTalk AppSecret (SDK mode). Only the
   * reference — never the real secret — is stored here; the value is resolved
   * via `ctx.credentials` at startup and injected as `deps.clientSecret`.
   * Defaults to `DSH_CHANNEL_DINGTALK_MAIN_CLIENT_SECRET`.
   */
  clientSecretRef?: string;
}

export interface DingTalkConfig {
  enabled: boolean;
  /** Account id within the dingtalk channel (defaults to 'main'). */
  accountId: string;
  /**
   * Base URL of the HTTP upstream. In 'gateway' mode this is the self-hosted
   * gateway that owns inbound long-polling AND the outbound endpoints. In
   * 'sdk' mode inbound comes from the official SDK and this base is used only
   * for outbound HTTP calls (message send / AI card) through the transport.
   */
  baseUrl: string;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Long-poll hang time for one receive cycle (gateway mode only). */
  longPollTimeoutMs: number;
  reconnect: DingTalkReconnectConfig;
  dedup: DingTalkDedupConfig;
  card: DingTalkCardConfig;
  /** Upstream driver selection (official SDK vs self-hosted gateway). */
  upstream: DingTalkUpstreamConfig;
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
  upstream: Schema.object({
    mode: Schema.union(['sdk', 'gateway']).default('sdk'),
    // The AppKey (clientId) is not a secret and may live in config.
    clientId: Schema.string(),
    // Credential reference name — never the secret value itself.
    clientSecretRef: Schema.string().default(DINGTALK_CLIENT_SECRET_REF),
    // DEPRECATED migration-only legacy plaintext field: kept so old configs
    // still parse. apply() migrates its value to credentials a single time and
    // deletes it. Never written, never read to build the SDK client.
    clientSecret: Schema.string().hidden(),
  }),
});
