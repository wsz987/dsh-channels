/**
 * Lark adapter configuration (Schemastery).
 *
 * Every deployment-tunable parameter is configurable here — no hardcoded
 * deployment constants. The upstream is ALWAYS the official
 * `@larksuiteoapi/node-sdk`: the Lark AppId is a plain config string
 * (`upstream.appId` — not a secret) while the AppSecret is resolved via
 * `ctx.credentials` (reference `DSH_CHANNEL_LARK_MAIN_APP_SECRET`). The secret
 * value never appears in profile config, logs, or fixtures — only its reference
 * name does.
 *
 * Fail-closed config governance:
 * - `upstream.mode` is a fixed literal `'sdk'`. A legacy config carrying
 *   `mode: 'gateway'` fails config validation (the plugin never enters the
 *   runtime), so no gateway fallback can silently come back.
 * - `upstream.appSecret` is a validation-only hidden field that REJECTS any
 *   non-empty plaintext value at parse time. Legacy plaintext configs must be
 *   migrated to ctx.credentials (`appSecretRef`) before loading; there is no
 *   runtime migration anymore.
 * - `baseUrl` / `longPollTimeoutMs` (old self-hosted gateway settings) are
 *   removed from the schema and defaults.
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
   * Create the CardKit streaming card entity on the first streamed delta
   * (eager preview). When `false`, deltas buffer locally and the card is only
   * created at `finish`.
   */
  createOnFirstDelta: boolean;
  /** Add/remove the Feishu `Typing` reaction while generating a reply. */
  typingIndicator: boolean;
}

/**
 * Upstream driver selection. The official `@larksuiteoapi/node-sdk` is the
 * ONLY driver: inbound via its WebSocket long-connection (`WSClient` +
 * `EventDispatcher`, `im.message.receive_v1` / `card.action.trigger`) and
 * outbound via its OpenAPI client, including CardKit 2.0 native streaming.
 * The legacy self-hosted HTTP gateway mode is removed — `mode` is a fixed
 * literal so old `'gateway'` configs fail validation.
 */
export interface LarkUpstreamConfig {
  /** Fixed: the official SDK is the only upstream driver. */
  mode: 'sdk';
  /**
   * Feishu/Lark AppId — a PLAIN config string (not a secret). The web UI writes
   * it through the config endpoint. Defaults to unset.
   */
  appId?: string;
  /**
   * Credential reference name for the Lark AppSecret (resolved via
   * `ctx.credentials`). Defaults to `LARK_APP_SECRET_REF`. Only the
   * reference name lives in config — the value never appears in profile / git.
   */
  appSecretRef?: string;
  /**
   * API domain: 'feishu' | 'lark' | custom base domain. Defaults to 'feishu'
   * (Feishu China).
   */
  domain?: string;
}

export interface LarkConfig {
  enabled: boolean;
  /** Account id within the lark channel (defaults to 'main'). */
  accountId: string;
  /** Per-request timeout. */
  timeoutMs: number;
  reconnect: LarkReconnectConfig;
  dedup: LarkDedupConfig;
  card: LarkCardConfig;
  /** Upstream driver: always the official SDK (detailed above). */
  upstream: LarkUpstreamConfig;
}

export const Config: Schema<LarkConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  accountId: Schema.string().default('main'),
  timeoutMs: Schema.natural().default(30000),
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
    // Fixed literal — `mode: 'gateway'` fails validation (fail closed).
    mode: Schema.union(['sdk']).default('sdk'),
    // AppId is a plain (non-secret) config string, written via the config endpoint.
    appId: Schema.string(),
    // Credential reference name only — never the secret value itself.
    appSecretRef: Schema.string().default(LARK_APP_SECRET_REF),
    // Fail-closed legacy-plaintext guard: any non-empty value is rejected at
    // parse time with a migration hint. Never written, never read at runtime.
    appSecret: Schema.transform(Schema.string().hidden(), (value: string | undefined) => {
      if (typeof value === 'string' && value.length > 0) {
        throw new TypeError(
          'upstream.appSecret (legacy plaintext) is no longer supported: move the value into ctx.credentials under '
            + 'upstream.appSecretRef and remove the field from config',
        );
      }
      return value;
    }),
    // 'feishu' | 'lark' | custom base domain (resolved to the SDK Domain).
    domain: Schema.string().default('feishu'),
  }),
});
