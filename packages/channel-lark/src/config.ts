/**
 * Lark adapter configuration (Schemastery).
 *
 * Every deployment-tunable parameter is configurable here — no hardcoded
 * deployment constants. In 'gateway' mode platform credentials live inside the
 * self-hosted HTTP gateway; in 'sdk' mode the Lark AppId is a plain config
 * string (`upstream.appId` — not a secret) while the AppSecret is resolved via
 * `ctx.credentials` (reference `DSH_CHANNEL_LARK_MAIN_APP_SECRET`). The secret
 * value never appears in profile config, logs, or fixtures — only its reference
 * name does.
 *
 * Migration note (doc §10 / §52 Task 5): legacy configs may still carry a
 * plaintext `upstream.appSecret`. That field is deprecated and hidden; the
 * plugin's apply() performs a one-time migration into ctx.credentials under
 * `appSecretRef` and strips the plaintext.
 */
import Schema from '@deepseek-ai/schemastery';

/** Default credential reference name for the Lark AppSecret (web + config default). */
export const LARK_APP_SECRET_REF = 'DSH_CHANNEL_LARK_MAIN_APP_SECRET';

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
  /** Add/remove the Feishu `Typing` reaction while generating a reply. */
  typingIndicator: boolean;
}

/**
 * Upstream driver selection.
 *
 * - `'sdk'`     — inbound via the official `@larksuiteoapi/node-sdk`
 *                (WebSocket long-connection) AND outbound via the official
 *                OpenAPI client. No localhost gateway / `baseUrl` is needed.
 * - `'gateway'` — inbound via the self-hosted HTTP gateway long-poll driver
 *                (legacy protocol-level integration; outbound unchanged).
 */
export interface LarkUpstreamConfig {
  mode: 'sdk' | 'gateway';
  /**
   * Feishu/Lark AppId — a PLAIN config string (not a secret). The web UI writes
   * it through the config endpoint (doc §30). Defaults to unset.
   */
  appId?: string;
  /**
   * Credential reference name for the Lark AppSecret (resolved via
   * `ctx.credentials`). Defaults to `LARK_APP_SECRET_REF`. Only the
   * reference name lives in config — the value never appears in profile / git.
   */
  appSecretRef?: string;
  /**
   * API domain for SDK mode: 'feishu' | 'lark' | custom base domain.
   * Defaults to 'feishu' (Feishu China).
   */
  domain?: string;
  /**
   * @deprecated Migration-only compatibility field (§52 Task 5). Legacy
   * plaintext configs still parse; apply() migrates the value into
   * `ctx.credentials` under `appSecretRef` and deletes this field. New
   * configs must use `appSecretRef`. Never write secret values to config.
   */
  appSecret?: string;
}

export interface LarkConfig {
  enabled: boolean;
  /** Account id within the lark channel (defaults to 'main'). */
  accountId: string;
  /**
   * Base URL of the self-hosted HTTP gateway, used only in 'gateway' mode
   * (inbound long-polling + outbound endpoints). 'sdk' mode ignores this and
   * talks to the official Lark OpenAPI instead.
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
    typingIndicator: Schema.boolean().default(true),
  }),
  upstream: Schema.object({
    mode: Schema.union(['sdk', 'gateway']).default('sdk'),
    // AppId is a plain (non-secret) config string, written via the config endpoint.
    appId: Schema.string(),
    // Credential reference name only — never the secret value itself.
    appSecretRef: Schema.string().default(LARK_APP_SECRET_REF),
    // DEPRECATED migration-only legacy plaintext field: kept so old configs
    // still parse. apply() migrates its value to credentials a single time and
    // deletes it. Never written, never read to build the SDK client.
    appSecret: Schema.string().hidden(),
    // 'feishu' | 'lark' | custom base domain (resolved to the SDK Domain).
    domain: Schema.string().default('feishu'),
  }),
});
