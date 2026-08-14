/**
 * Lark adapter configuration (Schemastery).
 *
 * Every deployment-tunable parameter is configurable here — no hardcoded
 * deployment constants. In 'gateway' mode platform credentials live inside the
 * self-hosted HTTP gateway; in 'sdk' mode the Lark AppId/AppSecret are
 * configured here as `upstream.appId` / `upstream.appSecret` and are handed
 * to the official SDK only. Credentials are never logged and never written
 * into fixtures.
 */
import Schema from '@deepseek-ai/schemastery';

export interface LarkReconnectConfig {
  enabled: boolean;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetries: number;
}

export interface LarkDedupConfig {
  enabled: boolean;
  windowMs: number;
}

export interface LarkCardConfig {
  /**
   * Create the editable card on the first streamed delta (eager preview). When
   * `false`, deltas buffer locally and the card is only created at `finish`.
   */
  createOnFirstDelta: boolean;
}

/**
 * Upstream driver selection.
 *
 * - `'sdk'`     — inbound via the official `@larksuiteoapi/node-sdk`
 *                (WebSocket long-connection). Outbound (message send / media /
 *                editable card) still rides the HTTP transport against
 *                `baseUrl` in this iteration.
 * - `'gateway'` — inbound via the self-hosted HTTP gateway long-poll driver
 *                (legacy protocol-level integration; outbound unchanged).
 */
export interface LarkUpstreamConfig {
  mode: 'sdk' | 'gateway';
  /** Lark AppId for SDK mode. SECRET — never logged. */
  appId?: string;
  /** Lark AppSecret for SDK mode. SECRET — never logged. */
  appSecret?: string;
}

export interface LarkConfig {
  enabled: boolean;
  /** Account id within the lark channel (defaults to 'main'). */
  accountId: string;
  /**
   * Base URL of the HTTP upstream. In 'gateway' mode this is the self-hosted
   * gateway that owns inbound long-polling AND the outbound endpoints. In
   * 'sdk' mode inbound comes from the official SDK and this base is used only
   * for outbound HTTP calls (message send / media / editable card) through the
   * transport.
   */
  baseUrl: string;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Long-poll hang time for one receive cycle (gateway mode only). */
  longPollTimeoutMs: number;
  reconnect: LarkReconnectConfig;
  dedup: LarkDedupConfig;
  card: LarkCardConfig;
  /** Upstream driver selection (official SDK vs self-hosted gateway). */
  upstream: LarkUpstreamConfig;
}

export const Config: Schema<LarkConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  accountId: Schema.string().default('main'),
  baseUrl: Schema.string().default('http://127.0.0.1:9300'),
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
    // Secret strings — never logged, never echoed into error messages.
    appId: Schema.string(),
    appSecret: Schema.string(),
  }),
});
