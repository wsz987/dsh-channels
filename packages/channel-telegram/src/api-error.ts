/**
 * Structured Telegram Bot API error (execution plan §3.1 / §5.4).
 *
 * Telegram's error envelope carries `error_code`/`description` and, for some
 * failures, a `parameters` object (e.g. `retry_after`, `migrate_to_chat_id`).
 * The previous code collapsed every non-ok `sendMessage` into a bare
 * "invalid response" catch-all, which made it impossible to distinguish a
 * rich-formatting parse failure (→ plain fallback) from a 401/403 (→ never
 * fallback), a 429 (→ rate-limit retry) or a 5xx/network failure (→ retry).
 *
 * `TelegramApiError` preserves the original fields and classifies each error
 * into a stable `TelegramErrorKind`. It is constructed at the envelope/post
 * boundary in `HttpTelegramUpstream`, so downstream code (the renderer and the
 * reply engine) can decide retry / fallback / fail without rebuilding the
 * classification from raw numbers.
 */
import { ChannelError } from '@wsz987/channel-core';

/**
 * Machine-readable Telegram error class used to drive fallback/retry policy.
 *
 * - `format`    — Telegram rejected the formatted payload (bad entity, rich
 *                 message parse failure). The only kind that may trigger a
 *                 one-shot plain fallback.
 * - `rate-limit`— HTTP 429; retry after `parameters.retryAfter`.
 * - `auth`      — 401 invalid token.
 * - `permission`— 403 the bot lacks permission / was removed; never fallback.
 * - `network`   — the HTTP request never got a valid Bot API response (timeout,
 *                 aborted, transport failure). Not a formatting problem.
 * - `upstream`  — 5xx / other genuine Telegram-side server errors. Retry.
 */
export type TelegramErrorKind =
  | 'format'
  | 'rate-limit'
  | 'auth'
  | 'permission'
  | 'network'
  | 'upstream';

/** Fields Telegram may return in the error `parameters` object. */
export interface TelegramErrorParameters {
  retryAfter?: number;
  migrateToChatId?: number;
}

/** Telegram errors Telegram may legitimately return (by description text). */
const FORMAT_TEXT_MARKERS = [
  'can\'t parse entities',
  'entity is too long',
  'failed to parse',
  'rich message',
  'message entities',
  'unsupported start tag',
  'unsupported end tag',
  'unclosed start tag',
];

/**
 * Classify a Telegram `error_code` (plus optional retry/migration parameters)
 * into a stable `TelegramErrorKind`. This is the single source of truth for
 * fallback / retry policy; no caller should infer the kind from raw numbers.
 *
 * Logic (execution plan §20.9):
 * - explicit retry_after      -> rate-limit
 * - 401                       -> auth
 * - 403                       -> permission
 * - 429                       -> rate-limit
 * - 5xx                       -> upstream
 * - description match addenda  -> format (only for 400-class non-authed)
 * - other 400 responses        -> upstream (Telegram also uses 400 for chat,
 *   message, thread, and button errors; those must never trigger fallback)
 * - unknown / missing code     -> upstream (not enough evidence to fallback)
 */
export function classifyTelegramError(
  errorCode: number | undefined,
  description: string | undefined,
  parameters?: TelegramErrorParameters,
): TelegramErrorKind {
  if (parameters?.retryAfter !== undefined) return 'rate-limit';
  if (errorCode === 401) return 'auth';
  if (errorCode === 403) return 'permission';
  if (errorCode === 429) return 'rate-limit';
  if (errorCode !== undefined && errorCode >= 500) return 'upstream';
  if (errorCode === 400 && description) {
    const lower = description.toLowerCase();
    if (FORMAT_TEXT_MARKERS.some((marker) => lower.includes(marker))) return 'format';
    return 'upstream';
  }
  if (errorCode === 400) return 'upstream';
  // No usable code / unexpected shape — treat as an upstream-level failure.
  return 'upstream';
}

/** Map the resolved kind to a stable, readable message fragment. */
function kindLabel(kind: TelegramErrorKind): string {
  switch (kind) {
    case 'format': return 'format';
    case 'rate-limit': return 'rate-limit';
    case 'auth': return 'auth';
    case 'permission': return 'permission';
    case 'network': return 'network';
    case 'upstream': return 'upstream';
  }
}

export interface TelegramApiErrorOptions extends ErrorOptions {
  method?: string;
  errorCode?: number;
  description?: string;
  parameters?: TelegramErrorParameters;
  kind?: TelegramErrorKind;
}

/**
 * Structured Telegram error. Extends `ChannelError` so existing adapter-level
 * error mapping (which asserts `ChannelError`) keeps working, while preserving
 * the Telegram-specific original fields and the stable classification.
 */
export class TelegramApiError extends ChannelError {
  readonly method: string;
  readonly errorCode?: number;
  readonly description?: string;
  readonly parameters?: TelegramErrorParameters;
  readonly kind: TelegramErrorKind;

  constructor(options: TelegramApiErrorOptions = {}) {
    const kind = options.kind ?? classifyTelegramError(options.errorCode, options.description, options.parameters);
    const method = options.method ?? 'telegram';
    const detail = options.description ?? 'unknown error';
    const code = kind === 'auth' ? 'CHANNEL_AUTH_FAILED' : 'CHANNEL_ERROR';
    super(code, `telegram ${method} failed (${kindLabel(kind)}): ${detail}`, options);
    this.name = 'TelegramApiError';
    this.method = method;
    this.errorCode = options.errorCode;
    this.description = options.description;
    this.parameters = options.parameters;
    this.kind = kind;
  }
}
