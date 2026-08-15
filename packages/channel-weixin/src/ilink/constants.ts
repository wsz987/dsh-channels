/**
 * Classification: C — duplicate protocol constants [@deprecated upstream-gap].
 *
 * iLink endpoint table + header names + wire values self-maintained. The
 * official package's constants live in api/types.js (endpoint paths are NOT
 * exported there — they are hard-coded inside api/api.js, which is OpenClaw
 * coupled). The endpoint PATH strings here are protocol knowledge that the
 * official coupled module owns; kept behind the facade as an upstream-gap
 * until Tencent exposes public host-neutral API endpoints. Marked upstream-gap.
 */
/**
 * Tencent Weixin iLink protocol constants.
 *
 * Endpoint paths, header names and fixed wire values for the direct iLink
 * client. Clean-room implementation ported from the Tencent/openclaw-weixin
 * protocol description (see THIRD_PARTY_NOTICES for provenance).
 */

/** Default API base URL for all iLink CGI requests. */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** Default CDN base URL for media download/upload. */
export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

/** Default bot type used for QR login (`get_bot_qrcode?bot_type=3`). */
export const DEFAULT_BOT_TYPE = '3';

/** iLink-App-Id constant fixed by the protocol for bot clients. */
export const ILINK_APP_ID = 'bot';

/** Authorization scheme for the `Authorization` header. */
export const AUTHORIZATION_TYPE = 'ilink_bot_token';

/** Header names used by the iLink protocol. */
export const HEADER_CONTENT_TYPE = 'Content-Type';
export const HEADER_AUTHORIZATION_TYPE = 'AuthorizationType';
export const HEADER_AUTHORIZATION = 'Authorization';
export const HEADER_X_WECHAT_UIN = 'X-WECHAT-UIN';
export const HEADER_ILINK_APP_ID = 'iLink-App-Id';
export const HEADER_ILINK_APP_CLIENT_VERSION = 'iLink-App-ClientVersion';
export const HEADER_SK_ROUTE_TAG = 'SKRouteTag';

/** API endpoint paths (relative to the base URL). */
export const ENDPOINT_GET_BOT_QRCODE = 'ilink/bot/get_bot_qrcode';
export const ENDPOINT_GET_QRCODE_STATUS = 'ilink/bot/get_qrcode_status';
export const ENDPOINT_GET_UPDATES = 'ilink/bot/getupdates';
export const ENDPOINT_SEND_MESSAGE = 'ilink/bot/sendmessage';
export const ENDPOINT_GET_CONFIG = 'ilink/bot/getconfig';
export const ENDPOINT_SEND_TYPING = 'ilink/bot/sendtyping';
export const ENDPOINT_NOTIFY_START = 'ilink/bot/msg/notifystart';
export const ENDPOINT_NOTIFY_STOP = 'ilink/bot/msg/notifystop';
export const ENDPOINT_GET_UPLOAD_URL = 'ilink/bot/getuploadurl';

/** Default long-poll timeout for `getUpdates` (server holds the request). */
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;

/** Default long-poll timeout for `get_qrcode_status` (server holds the request). */
export const DEFAULT_QR_POLL_TIMEOUT_MS = 35_000;

/** Default timeout for regular API requests (`sendMessage`, QR calls). */
export const DEFAULT_API_TIMEOUT_MS = 15_000;

/** Default timeout for lightweight API requests (`getConfig`, `sendTyping`). */
export const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

/**
 * Exit code `-14` reported by the server when the bot token is stale /
 * expired. Detected and surfaced as a typed `StaleTokenError`.
 */
export const STALE_TOKEN_ERRCODE = -14;