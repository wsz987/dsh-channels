/**
 * Classification: C — duplicate protocol implementation [@deprecated upstream-gap].
 *
 * iLink HTTP client (QR code, getUpdates long-poll, sendmessage, getconfig,
 * sendtyping, getuploadurl, notify). Self-implemented because the official
 * Tencent/openclaw-weixin @ 2.4.6 equivalents for these calls (api/api.js +
 * auth/login-qr.js) are coupled to the OpenClaw runtime via util/logger.ts /
 * auth/accounts.ts and execute OpenClaw side effects at import time (plan §18:
 * do not drag the OpenClaw runtime into DSH). Marked upstream-gap; official
 * source of truth = @tencent-weixin/openclaw-weixin/dist/src/api/api.js.
 * DO NOT delete wholesale this milestone (plan §19).
 */
/**
 * ILinkClient — thin, endpoint-aware client over the base {@link HttpTransport}.
 *
 * Owns the iLink endpoint paths, request/response shapes and error
 * normalization. The base URL is mutable per account so QR-redirect and
 * confirmed `baseurl` can update all later calls (getUpdates / sendMessage /
 * QR status).
 */
import pkg from '../../package.json' with { type: 'json' };
import { z } from 'zod';
import { FetchTransport, type HttpTransport } from '../transport.js';
import { buildHeaders } from './headers.js';
import { buildBaseInfo } from './base-info.js';
import {
  DEFAULT_CDN_BASE_URL,
  DEFAULT_LONG_POLL_TIMEOUT_MS,
  ENDPOINT_GET_BOT_QRCODE,
  ENDPOINT_GET_CONFIG,
  ENDPOINT_GET_QRCODE_STATUS,
  ENDPOINT_GET_UPDATES,
  ENDPOINT_GET_UPLOAD_URL,
  ENDPOINT_NOTIFY_START,
  ENDPOINT_NOTIFY_STOP,
  ENDPOINT_SEND_MESSAGE,
  ENDPOINT_SEND_TYPING,
  DEFAULT_BOT_TYPE,
  DEFAULT_QR_POLL_TIMEOUT_MS,
} from './constants.js';
import { normalizeILinkError } from './errors.js';
import {
  getConfigResponseSchema,
  getUpdatesResponseSchema,
  getUploadUrlResponseSchema,
  notifyResponseSchema,
  qrCodeResponseSchema,
  qrStatusResponseSchema,
  responseEnvelopeSchema,
  sendMessageResponseSchema,
  sendTypingResponseSchema,
} from './schema.js';
import type {
  ILinkBaseInfo,
  ILinkGetConfigRequest,
  ILinkGetConfigResponse,
  ILinkGetUpdatesResponse,
  ILinkGetUploadUrlRequest,
  ILinkGetUploadUrlResponse,
  ILinkNotifyResponse,
  ILinkQrCodeResponse,
  ILinkQrStatusResponse,
  ILinkSendMessageRequest,
  ILinkSendMessageResponse,
  ILinkSendTypingRequest,
  ILinkSendTypingResponse,
} from './types.js';

export interface ILinkClientOptions {
  /** API base URL; may be updated per-account after QR redirect. */
  baseUrl: string;
  /** CDN base URL for media operations (WX5 scaffold). */
  cdnBaseUrl?: string;
  /** Bot token for authenticated requests. */
  token?: string;
  /** Timeout for regular API requests (ms). */
  timeoutMs?: number;
  /** Timeout for the getUpdates long-poll (ms). */
  longPollTimeoutMs?: number;
  /** bot_agent string for base_info. */
  botAgent?: string;
  /** Injectable transport (tests). */
  transport?: HttpTransport;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Optional route tag emitted as SKRouteTag. */
  routeTag?: string;
  /** Injectable random source for X-WECHAT-UIN (tests). */
  rand?: () => number;
}

export interface GetUpdatesParams {
  getUpdatesBuf?: string;
  /** Long-poll timeout override (dynamic from server). */
  longPollTimeoutMs?: number;
  /** External abort signal (channel stop). */
  signal?: AbortSignal;
}

export interface GetUpdatesResult {
  msgs: ILinkGetUpdatesResponse['msgs'];
  get_updates_buf?: string;
  /** Next long-poll timeout suggested by the server. */
  nextLongPollTimeoutMs?: number;
  /** Whether the response came from a long-poll client-side timeout (empty msgs). */
  timedOut?: boolean;
}

/** Optional local state supplied when requesting a QR login challenge. */
export interface GetBotQrcodeOptions {
  /** Recent locally-held bot tokens. Values are never logged. */
  localTokens?: readonly string[];
  /** External abort signal for the request. */
  signal?: AbortSignal;
}

const localTokenArraySchema = z.array(z.unknown());
const localTokenSchema = z.string().trim().min(1).max(4096);
const MAX_LOCAL_TOKENS = 10;

interface ILinkResponseEnvelope {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/** Validate, normalize, deduplicate, and bound QR local tokens at the wire boundary. */
function normalizeLocalTokens(value: unknown): string[] {
  const parsed = localTokenArraySchema.safeParse(value);
  if (!parsed.success) return [];

  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const item of parsed.data) {
    const token = localTokenSchema.safeParse(item);
    if (!token.success || seen.has(token.data)) continue;
    seen.add(token.data);
    tokens.push(token.data);
    if (tokens.length === MAX_LOCAL_TOKENS) break;
  }
  return tokens;
}

function ensureSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

const OFFICIAL_ILINK_HOST_SUFFIX = 'weixin.qq.com';

function parseIlinkBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TypeError('invalid iLink base URL');
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError('invalid iLink base URL');
  }
  return url;
}

function isOfficialIlinkHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === OFFICIAL_ILINK_HOST_SUFFIX || normalized.endsWith(`.${OFFICIAL_ILINK_HOST_SUFFIX}`);
}

function serializeBaseUrl(url: URL): string {
  return url.toString().replace(/\/+$/, '');
}

export class ILinkClient {
  private _baseUrl: string;
  private readonly configuredBaseAuthority: string;
  private readonly cdnBaseUrl: string;
  private _token?: string;
  private readonly timeoutMs: number;
  private readonly longPollTimeoutMs: number;
  private readonly botAgent: string;
  private readonly transport: HttpTransport;
  private readonly now: () => number;
  private readonly rand: () => number;
  private readonly routeTag?: string;
  private readonly accountId: string;

  constructor(private readonly options: ILinkClientOptions, accountId = 'main') {
    this.accountId = accountId;
    const configuredBaseUrl = parseIlinkBaseUrl(options.baseUrl);
    this.configuredBaseAuthority = configuredBaseUrl.host.toLowerCase();
    this._baseUrl = serializeBaseUrl(configuredBaseUrl);
    this.cdnBaseUrl = (options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL).replace(/\/+$/, '');
    this._token = options.token;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.longPollTimeoutMs = options.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
    this.botAgent = options.botAgent ?? 'DeepSeekHarness/' + pkg.version;
    this.rand = options.rand ?? Math.random;
    this.now = options.now ?? Date.now;
    this.routeTag = options.routeTag;
    this.transport = options.transport ?? new FetchTransport({ timeoutMs: this.timeoutMs });
  }

  /** Current effective API base URL (mutable after QR redirect). */
  get baseUrl(): string {
    return this._baseUrl;
  }

  /** Update the effective base URL (QR redirect / confirmed baseurl). */
  setBaseUrl(baseUrl: string): void {
    const candidate = parseIlinkBaseUrl(baseUrl);
    const candidateHost = candidate.hostname.toLowerCase();
    const candidateAuthority = candidate.host.toLowerCase();
    if (candidateAuthority !== this.configuredBaseAuthority && !isOfficialIlinkHost(candidateHost)) {
      throw new TypeError('untrusted iLink base URL host');
    }
    this._baseUrl = serializeBaseUrl(candidate);
  }

  /** Update the bot token (post-QR-confirm). */
  setToken(token?: string): void {
    this._token = token?.trim() ? token : undefined;
  }

  get token(): string | undefined {
    return this._token;
  }

  /** CDN base URL (no trailing slash). */
  get cdnUrl(): string {
    return this.cdnBaseUrl;
  }

  private headers(): Record<string, string> {
    return buildHeaders({ token: this._token, routeTag: this.routeTag, rand: this.rand });
  }

  private baseInfo(): ILinkBaseInfo {
    return buildBaseInfo({ botAgent: this.botAgent });
  }

  private async post(endpoint: string, body: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    const url = ensureSlash(this._baseUrl) + endpoint;
    try {
      const init: { method: string; headers: Record<string, string>; body?: unknown; timeoutMs?: number } =
        { method: 'POST', headers: this.headers(), body };
      if (timeoutMs !== undefined) init.timeoutMs = timeoutMs;
      return await this.transport.request(url, init, signal);
    } catch (error) {
      throw normalizeILinkError(error, { operation: endpoint, accountId: this.accountId });
    }
  }

  private async get(endpoint: string, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    const url = ensureSlash(this._baseUrl) + endpoint;
    const init: { method: string; headers: Record<string, string>; timeoutMs?: number } =
      { method: 'GET', headers: this.headers() };
    if (timeoutMs !== undefined) init.timeoutMs = timeoutMs;
    try {
      return await this.transport.request(url, init, signal);
    } catch (error) {
      throw normalizeILinkError(error, { operation: endpoint, accountId: this.accountId });
    }
  }

  private parseResponse<T extends ILinkResponseEnvelope>(
    schema: z.ZodType<T>,
    raw: unknown,
    operation: string,
  ): T {
    // Decode the common error envelope first. Error responses are not required
    // to carry endpoint-specific success fields such as QR content.
    const envelope = responseEnvelopeSchema.safeParse(raw);
    if (envelope.success &&
        ((envelope.data.ret !== undefined && envelope.data.ret !== 0) ||
         (envelope.data.errcode !== undefined && envelope.data.errcode !== 0))) {
      throw normalizeILinkError(new Error(envelope.data.errmsg ?? 'iLink protocol error'), {
        operation,
        accountId: this.accountId,
        ret: envelope.data.ret,
        errcode: envelope.data.errcode,
        errmsg: envelope.data.errmsg,
      });
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw normalizeILinkError(new Error('invalid iLink response shape'), {
        operation,
        accountId: this.accountId,
      });
    }
    const response = parsed.data;
    return response;
  }

  /** POST /ilink/bot/get_bot_qrcode?bot_type=3 with { local_token_list: [] }. */
  async getBotQrcode(options: GetBotQrcodeOptions = {}): Promise<ILinkQrCodeResponse> {
    const endpoint = `${ENDPOINT_GET_BOT_QRCODE}?bot_type=${encodeURIComponent(DEFAULT_BOT_TYPE)}`;
    const raw = await this.post(endpoint, {
      local_token_list: normalizeLocalTokens(options.localTokens),
    }, options.signal);
    return this.parseResponse(qrCodeResponseSchema, raw, ENDPOINT_GET_BOT_QRCODE);
  }

  /**
   * GET /ilink/bot/get_qrcode_status?qrcode=... (optionally &verify_code=...).
   *
   * This is a long-poll endpoint: the server holds the request open while the
   * status is `wait` (before the user scans). A client-side long-poll timeout
   * is therefore normal control flow — same semantics as `getUpdates` — and is
   * mapped back to `{ status: 'wait' }` so `WeixinQrAuth` never has to reason
   * about HTTP timeouts: timeout → wait → pending → next poll.
   */
  async getQrcodeStatus(qrcode: string, opts: { verifyCode?: string; signal?: AbortSignal } = {}): Promise<ILinkQrStatusResponse> {
    let endpoint = `${ENDPOINT_GET_QRCODE_STATUS}?qrcode=${encodeURIComponent(qrcode)}`;
    if (opts.verifyCode) {
      endpoint += `&verify_code=${encodeURIComponent(opts.verifyCode)}`;
    }
    try {
      const raw = await this.get(endpoint, opts.signal, DEFAULT_QR_POLL_TIMEOUT_MS);
      return this.parseResponse(qrStatusResponseSchema, raw, ENDPOINT_GET_QRCODE_STATUS);
    } catch (error) {
      if (isClientAbortOrTimeout(error)) {
        return { status: 'wait' };
      }
      throw error;
    }
  }

  /**
   * POST /ilink/bot/getupdates.
   * A long-poll client-side timeout is normal control flow: returns an empty
   * result with `timedOut: true` so the monitor can simply retry.
   */
  async getUpdates(params: GetUpdatesParams = {}): Promise<GetUpdatesResult> {
    const timeout = params.longPollTimeoutMs ?? this.longPollTimeoutMs;
    try {
      const raw = await this.post(
        ENDPOINT_GET_UPDATES,
        { get_updates_buf: params.getUpdatesBuf ?? '', base_info: this.baseInfo() },
        params.signal,
        timeout,
      );
      const resp = this.parseResponse(getUpdatesResponseSchema, raw, ENDPOINT_GET_UPDATES);
      return {
        msgs: resp.msgs ?? [],
        get_updates_buf: resp.get_updates_buf,
        nextLongPollTimeoutMs: resp.longpolling_timeout_ms,
        timedOut: false,
      };
    } catch (error) {
      if (isLongPollClientTimeout(error)) {
        return { msgs: [], get_updates_buf: params.getUpdatesBuf, timedOut: true };
      }
      throw error;
    }
  }

  /** POST /ilink/bot/sendmessage. */
  async sendMessage(req: ILinkSendMessageRequest, signal?: AbortSignal): Promise<ILinkSendMessageResponse> {
    const body = { ...req, base_info: req.base_info ?? this.baseInfo() };
    const raw = await this.post(ENDPOINT_SEND_MESSAGE, body, signal);
    return this.parseResponse(sendMessageResponseSchema, raw, ENDPOINT_SEND_MESSAGE);
  }

  /** POST /ilink/bot/getuploadurl (WX5 media upload slot). */
  async getUploadUrl(req: ILinkGetUploadUrlRequest, signal?: AbortSignal): Promise<ILinkGetUploadUrlResponse> {
    const body = { ...req, base_info: req.base_info ?? this.baseInfo() };
    const raw = await this.post(ENDPOINT_GET_UPLOAD_URL, body, signal);
    return this.parseResponse(getUploadUrlResponseSchema, raw, ENDPOINT_GET_UPLOAD_URL);
  }

  /** POST /ilink/bot/getconfig. */
  async getConfig(req: ILinkGetConfigRequest, signal?: AbortSignal): Promise<ILinkGetConfigResponse> {
    const body = { ...req, base_info: req.base_info ?? this.baseInfo() };
    const raw = await this.post(ENDPOINT_GET_CONFIG, body, signal);
    return this.parseResponse(getConfigResponseSchema, raw, ENDPOINT_GET_CONFIG);
  }

  /** POST /ilink/bot/sendtyping. */
  async sendTyping(req: ILinkSendTypingRequest, signal?: AbortSignal): Promise<ILinkSendTypingResponse> {
    const body = { ...req, base_info: req.base_info ?? this.baseInfo() };
    const raw = await this.post(ENDPOINT_SEND_TYPING, body, signal);
    return this.parseResponse(sendTypingResponseSchema, raw, ENDPOINT_SEND_TYPING);
  }

  /** POST /ilink/bot/msg/notifystart (best effort). */
  async notifyStart(signal?: AbortSignal): Promise<ILinkNotifyResponse> {
    const raw = await this.post(ENDPOINT_NOTIFY_START, { base_info: this.baseInfo() }, signal);
    return this.parseResponse(notifyResponseSchema, raw, ENDPOINT_NOTIFY_START);
  }

  /** POST /ilink/bot/msg/notifystop (best effort). */
  async notifyStop(signal?: AbortSignal): Promise<ILinkNotifyResponse> {
    const raw = await this.post(ENDPOINT_NOTIFY_STOP, { base_info: this.baseInfo() }, signal);
    return this.parseResponse(notifyResponseSchema, raw, ENDPOINT_NOTIFY_STOP);
  }
}

/** A long-poll getUpdates client-side timeout (AbortError from the timeout) is treated as empty. */
function isLongPollClientTimeout(error: unknown): boolean {
  return isClientAbortOrTimeout(error);
}

/**
 * Client-side abort/timeout (walking the `.cause` chain) — the transport and
 * `normalizeILinkError` wrap the raw `AbortError`, so we must follow `cause`
 * to classify a long-poll timeout as normal control flow rather than an error.
 */
function isClientAbortOrTimeout(error: unknown): boolean {
  let cur: unknown = error;
  // Guard against cycles.
  const seen = new Set<unknown>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const name = (cur as Error)?.name;
    if (name === 'AbortError' || name === 'ILinkAbortError' || name === 'ILinkTimeoutError' || name === 'TimeoutError') {
      return true;
    }
    const msg = typeof (cur as Error)?.message === 'string' ? (cur as Error).message : '';
    if (msg.includes('http request aborted') || msg.includes('timed out')) {
      return true;
    }
    cur = (cur as Error)?.cause;
  }
  return false;
}
