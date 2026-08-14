/**
 * Channel display labels and safe path/title helpers (plan §4.2 / P1).
 *
 * Workspace titles group channel sessions under a human-readable name using a
 * registry of channel display labels, and account identity is reduced to a
 * stable, non-sensitive short string so that tokens / openids / full phone
 * numbers are never exposed in a Workspace title or directory path (plan §4.2
 * "不要直接把 token、openid、完整手机号等敏感 accountId 展示").
 */
import { createHash } from 'node:crypto';

/**
 * Human-readable display labels for known channels. Unknown channels fall back
 * to their raw `channelId` (see {@link channelLabel}).
 */
export const CHANNEL_LABELS: Record<string, string> = {
  weixin: '微信',
  qq: 'QQ',
  dingtalk: 'DingTalk',
  lark: 'Lark',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
};

/** Display label for a channel, falling back to the raw id for unknown ones. */
export function channelLabel(channelId: string): string {
  return CHANNEL_LABELS[channelId] ?? channelId;
}

/**
 * Workspace title for a channel/account pair (plan §4.2):
 * - single-account channels (id in the small default set): `Channels · 微信`
 * - multi-account: `Channels · 微信 · <accountLabel>`, where
 *   `<accountLabel>` is the readable account label when {@link safeAccountLabel}
 *   deems it safe, else the stable 6-hex short hash.
 */
export function channelWorkspaceTitle(input: { channelId: string; accountId: string }): string {
  const base = `Channels · ${channelLabel(input.channelId)}`;
  if (isDefaultAccount(input.accountId)) return base;
  const accountLabel = safeAccountLabel(input.accountId) ?? stableSafeAccountKey(input.accountId);
  return `${base} · ${accountLabel}`;
}

/**
 * Deterministic 6-hex-character key for an account id (sha256, first 6 hex
 * chars). Used to build path-safe, non-sensitive account segments and the
 * fallback account label in Workspace titles.
 */
export function stableSafeAccountKey(accountId: string): string {
  return createHash('sha256').update(accountId).digest('hex').slice(0, 6);
}

/**
 * Collapse a value into a single path-safe segment: lowercase, runs of
 * characters outside `[a-z0-9._-]` replaced with `-`, leading/trailing `-`
 * trimmed, and an empty result falls back to `'unknown'`.
 */
export function safeSegment(value: string): string {
  const segment = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return segment === '' ? 'unknown' : segment;
}

/**
 * Whether an account id may be shown readably in a Workspace title. A value
 * is *unsafe* (returns `undefined`, so the caller uses the stable short hash)
 * when it is:
 * - too long (> 24 chars),
 * - not a conservative printable-ish pattern
 *   (`/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,23}$/`), or
 * - "obviously sensitive": an all-digits value of length >= 11 (phone-like),
 *   or containing `token` / `openid` / `secret` / `appid` (case-insensitive).
 *
 * This is a conservative heuristic, not a security boundary: the stable hash
 * fallback is always available and is what callers use when this returns
 * `undefined`.
 */
export function safeAccountLabel(accountId: string): string | undefined {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,23}$/.test(accountId)) return undefined;
  if (/^\d{11,}$/.test(accountId)) return undefined;
  if (/token|openid|secret|appid/i.test(accountId)) return undefined;
  return accountId;
}

/** Default single-account ids treated as "the one account" for title purposes. */
const DEFAULT_ACCOUNT_IDS: ReadonlySet<string> = new Set(['default', 'main', '0', 'primary', '']);

function isDefaultAccount(accountId: string): boolean {
  return DEFAULT_ACCOUNT_IDS.has(accountId);
}
