/**
 * Telegram adapter configuration (Schemastery).
 *
 * Every deployment-tunable parameter is configurable here — no hardcoded
 * deployment constants. The Bot API token is a secret: config carries only its
 * credential reference (`tokenRef`, default `TELEGRAM_BOT_TOKEN`); the real
 * value is resolved through `ctx.credentials` at startup and never lives in
 * profile config, logs, or fixtures.
 *
 * Migration note: legacy configs may still carry a plaintext `token`. The field
 * is deprecated and hidden; the plugin's apply() migrates it into
 * `ctx.credentials` under `tokenRef` exactly once and strips the plaintext.
 */
import Schema from '@deepseek-ai/schemastery';

/** Default credential reference name for the Telegram Bot API token. */
export const TELEGRAM_BOT_TOKEN_REF = 'TELEGRAM_BOT_TOKEN';

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

export interface TelegramStreamingConfig {
  /**
   * Whether incremental outbound streaming is enabled. When false, the reply
   * router falls back to the buffered send-once strategy.
   */
  enabled: boolean;
  /** Text sent as the initial placeholder while the model is working. */
  placeholder: string;
}

/**
 * Outbound formatting policy (plan §5.1). The adapter's minimum supported
 * upstream is Bot API 10.2, so `auto` always selects Rich Markdown.
 */
export interface TelegramFormattingConfig {
  /**
   * Output renderer:
   * - `auto`         -> Rich Markdown
   * - `rich-markdown`-> sendRichMessage / sendRichMessageDraft
   * - `html`         -> sendMessage(parse_mode=HTML) via the safe HTML renderer
   * - `markdown-v2`  -> expert-compat mode (fully escaped, never raw Agent MD)
   * - `plain`        -> no formatting parsed
   */
  mode: 'auto' | 'rich-markdown' | 'html' | 'markdown-v2' | 'plain';
  /**
   * What to fall back to when the selected mode fails with a *format* error.
   * Only `plain` is supported today; 401/403 / 429 / network / 5xx never
   * trigger this fallback (plan §20.9).
   */
  fallback: 'plain';
}

export interface TelegramConfig {
  enabled: boolean;
  /** Account id within the telegram channel (defaults to 'main'). */
  accountId: string;
  /** Base URL of the Telegram Bot API. */
  baseUrl: string;
  /**
   * Credential reference name for the Bot API token (resolved via
   * `ctx.credentials`). Defaults to `TELEGRAM_BOT_TOKEN_REF`. Only the
   * reference name lives in config — never the token itself.
   */
  tokenRef: string;
  /**
   * @deprecated Migration-only compatibility field. Legacy plaintext configs
   * still parse; apply() migrates the value into `ctx.credentials` under
   * `tokenRef` and deletes this field. New configs must use `tokenRef`.
   */
  token?: string;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Long-poll hang time for one getUpdates cycle. */
  longPollTimeoutMs: number;
  reconnect: TelegramReconnectConfig;
  dedup: TelegramDedupConfig;
  streaming: TelegramStreamingConfig;
  /** Outbound formatting / rich rendering policy. */
  formatting: TelegramFormattingConfig;
  /** Hard byte cap for one inbound media download (image / document). */
  maxDownloadBytes: number;
}

export const Config: Schema<TelegramConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  accountId: Schema.string().default('main'),
  baseUrl: Schema.string().default('https://api.telegram.org'),
  // Credential reference name only — never the secret value itself.
  tokenRef: Schema.string().default(TELEGRAM_BOT_TOKEN_REF),
  // DEPRECATED migration-only legacy plaintext field: kept so old configs still
  // parse. apply() migrates its value to credentials once and deletes it.
  token: Schema.string().hidden(),
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
  streaming: Schema.object({
    enabled: Schema.boolean().default(true),
    placeholder: Schema.string().default('…'),
  }),
  formatting: Schema.object({
    mode: Schema.union([
      Schema.const('auto'),
      Schema.const('rich-markdown'),
      Schema.const('html'),
      Schema.const('markdown-v2'),
      Schema.const('plain'),
    ]).default('auto'),
    fallback: Schema.const('plain').default('plain'),
  }),
  maxDownloadBytes: Schema.natural().default(20 * 1024 * 1024),
});
