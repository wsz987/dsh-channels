/**
 * QQ adapter configuration (Schemastery).
 *
 * Every deployment-tunable parameter is configurable here — no hardcoded
 * deployment constants. In 'gateway' mode platform credentials live inside the
 * self-hosted HTTP gateway; in 'sdk' mode the QQ 开放平台 AppId / ClientSecret
 * are configured here as `upstream.appId` / `upstream.clientSecret` and are
 * exchanged for a short-lived access token against the official OpenAPI only.
 * Credentials are never logged and never written into fixtures.
 */
import Schema from '@deepseek-ai/schemastery';

export interface QQAuthConfig {
  /** Optional JSON file path for persisting auth state across restarts. */
  statePath?: string;
  /** How often QR auth state is polled. */
  qrPollIntervalMs: number;
  /** QR code expiry budget in milliseconds. */
  qrExpireMs: number;
}

export interface QQReconnectConfig {
  enabled: boolean;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
}

export interface QQDedupConfig {
  enabled: boolean;
  windowMs: number;
}

/**
 * Upstream driver selection.
 *
 * - `'sdk'`     — the official QQ 开放平台 WebSocket gateway protocol
 *   (isolated source, no third-party SDK): token auth (AppId + ClientSecret →
 *   access token), gateway connect/identify/heartbeat/reconnect, inbound
 *   C2C / group-@ dispatch mapped into the shared raw shape, and outbound
 *   message send through the official v2 OpenAPI.
 * - `'gateway'` — inbound via the self-hosted HTTP gateway long-poll driver
 *   (legacy protocol-level integration; QR auth; outbound unchanged).
 */
export interface QQUpstreamConfig {
  mode: 'sdk' | 'gateway';
  /** QQ 开放平台 AppId for SDK mode. SECRET — never logged. */
  appId?: string;
  /** QQ 开放平台 ClientSecret for SDK mode. SECRET — never logged. */
  clientSecret?: string;
}

export interface QQConfig {
  enabled: boolean;
  /** Account id within the qq channel (defaults to 'main'). */
  accountId: string;
  /** Base URL of the self-hosted QQ HTTP gateway (gateway mode upstream driver). */
  baseUrl: string;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Long-poll hang time for one receive cycle (gateway mode only). */
  longPollTimeoutMs: number;
  auth: QQAuthConfig;
  reconnect: QQReconnectConfig;
  dedup: QQDedupConfig;
  /** Upstream driver selection (official WebSocket gateway vs self-hosted gateway). */
  upstream: QQUpstreamConfig;
}

export const Config: Schema<QQConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  accountId: Schema.string().default('main'),
  baseUrl: Schema.string().default('http://127.0.0.1:9200'),
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
  upstream: Schema.object({
    mode: Schema.union(['sdk', 'gateway']).default('sdk'),
    // Secret strings — never logged, never echoed into error messages.
    appId: Schema.string(),
    clientSecret: Schema.string(),
  }),
});
