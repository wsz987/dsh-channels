/**
 * Classification: C — duplicate protocol header assembly [@deprecated upstream-gap].
 *
 * iLink request headers (Authorization, X-WECHAT-UIN, iLink-App-Id,
 * ClientVersion, SKRouteTag). The official buildHeaders lives inside
 * api/api.js (OpenClaw coupled — imports util/logger + auth/accounts). Kept as
 * an upstream-gap; reusable primitives (client-version encoding, base-info) are
 * DSH glue that stays.
 */
/**
 * iLink HTTP header construction.
 *
 * Every endpoint shares the same header set; building them here avoids
 * duplicating header logic per request.
 */
import {
  AUTHORIZATION_TYPE,
  HEADER_AUTHORIZATION,
  HEADER_AUTHORIZATION_TYPE,
  HEADER_CONTENT_TYPE,
  HEADER_ILINK_APP_CLIENT_VERSION,
  HEADER_ILINK_APP_ID,
  HEADER_SK_ROUTE_TAG,
  HEADER_X_WECHAT_UIN,
  ILINK_APP_ID,
} from './constants.js';

export interface BuildHeadersOptions {
  /** Bot token for the `Authorization` header; omitted when absent. */
  token?: string;
  /** Base URL (used only to derive a {@link buildClientVersion} seed — kept for symmetric API). */
  baseUrl?: string;
  /** Weixin user id (uint32) used to seed X-WECHAT-UIN randomness. */
  uin?: number;
  /** Optional client version override; defaults to {@link encodeClientVersion}. */
  clientVersion?: number;
  /** Optional routing tag; emitted as `SKRouteTag` when present. */
  routeTag?: string;
  /** Injectable random source for X-WECHAT-UIN (tests). */
  rand?: () => number;
}

/**
 * Encode a dotted version `major.minor.patch` as a uint32 `0x00MMNNPP`
 * (high 8 bits fixed to 0).
 */
export function encodeClientVersion(major = 0, minor = 0, patch = 0): number {
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

/** Parse `major.minor.patch` and return the encoded uint32. */
export function clientVersionFromString(version: string): number {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  const major = Number.isFinite(parts[0]) ? parts[0]! : 0;
  const minor = Number.isFinite(parts[1]) ? parts[1]! : 0;
  const patch = Number.isFinite(parts[2]) ? parts[2]! : 0;
  return encodeClientVersion(major, minor, patch);
}

/**
 * X-WECHAT-UIN: a random uint32 rendered as a decimal string, then base64.
 * Falls back to a seeded/deterministic value when a uint32 is supplied via
 * `opts.uin` (tests), otherwise uses crypto randomness.
 */
export function buildWechatUin(uint32?: number, rand: () => number = Math.random): string {
  const value = uint32 !== undefined ? uint32 & 0xffffffff : (rand() * 0xffffffff) >>> 0;
  const decimal = String(value >>> 0);
  return Buffer.from(decimal, 'utf-8').toString('base64');
}

/**
 * Build the shared iLink request headers.
 *
 * - Content-Type: application/json
 * - AuthorizationType: ilink_bot_token
 * - Authorization: Bearer <token>   (only when a token is provided)
 * - X-WECHAT-UIN: <random uint32 -> decimal -> base64>
 * - iLink-App-Id: bot
 * - iLink-App-ClientVersion: <encoded uint32>
 * - SKRouteTag (optional)
 */
export function buildHeaders(opts: BuildHeadersOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    [HEADER_CONTENT_TYPE]: 'application/json',
    [HEADER_AUTHORIZATION_TYPE]: AUTHORIZATION_TYPE,
    [HEADER_X_WECHAT_UIN]: buildWechatUin(opts.uin, opts.rand),
    [HEADER_ILINK_APP_ID]: ILINK_APP_ID,
    [HEADER_ILINK_APP_CLIENT_VERSION]: String(
      opts.clientVersion ?? clientVersionFromString('0.8.1'),
    ),
  };
  if (opts.token?.trim()) {
    headers[HEADER_AUTHORIZATION] = `Bearer ${opts.token.trim()}`;
  }
  if (opts.routeTag) {
    headers[HEADER_SK_ROUTE_TAG] = opts.routeTag;
  }
  return headers;
}