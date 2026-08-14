/**
 * QQ adapter configuration (Schemastery).
 *
 * V1 consumes the official Tencent SDK `@tencent-connect/qqbot-nodejs`, which
 * owns Token acquisition/refresh, the WebSocket gateway (hello/identify/
 * heartbeat/RESUME/reconnect) and the OpenAPI REST surface. The adapter only
 * needs the AppId and behavioural tuning — no base URL, transport, reconnect
 * budget or QR auth config.
 *
 * The real AppSecret is **never** written into config / profile / git. Config
 * only carries its credential reference name (`appSecretRef`); the actual
 * secret is resolved at startup through `ctx.credentials` (v1.1 §6.2, QQ-R5).
 */
import Schema from '@deepseek-ai/schemastery';

export interface QQStreamingConfig {
  /** Whether incremental outbound streaming is enabled. */
  enabled: boolean;
  /** Stream flush throttle (ms). Tencent SDK: default 500, min 300. */
  throttleMs: number;
}

export interface QQDedupConfig {
  enabled: boolean;
  windowMs: number;
}

export interface QQConfig {
  enabled: boolean;
  /** Account id within the qq channel (defaults to 'main'). */
  accountId: string;
  /** QQ Open Platform AppId (not a secret — may live in config/git). */
  appId: string;
  /**
   * Credential reference name for the QQ Open Platform AppSecret (e.g.
   * `'QQBOT_APP_SECRET'`). Only the reference — never the real secret — is
   * stored here; the secret is resolved via `ctx.credentials` at startup.
   */
  appSecretRef: string;
  /** Whether the bot has markdown permission. */
  markdownSupport: boolean;
  streaming: QQStreamingConfig;
  dedup: QQDedupConfig;
  /** How long start() waits for the SDK `ready` event before failing. */
  startupTimeoutMs: number;
}

export const Config: Schema<QQConfig> = Schema.object({
  enabled: Schema.boolean().default(true),
  accountId: Schema.string().default('main'),
  // Secret strings — never logged, never echoed into error messages.
  appId: Schema.string(),
  appSecretRef: Schema.string(),
  markdownSupport: Schema.boolean().default(false),
  streaming: Schema.object({
    enabled: Schema.boolean().default(true),
    throttleMs: Schema.natural().min(300).default(500),
  }),
  dedup: Schema.object({
    enabled: Schema.boolean().default(true),
    windowMs: Schema.natural().default(5000),
  }),
  startupTimeoutMs: Schema.natural().default(15000),
});
