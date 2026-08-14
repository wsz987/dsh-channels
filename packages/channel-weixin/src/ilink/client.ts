/**
 * ILinkClient — thin, endpoint-aware client over the base {@link HttpTransport}.
 *
 * Owns the iLink endpoint paths, request/response shapes and error
 * normalization. The base URL is mutable per account so QR-redirect and
 * confirmed `baseurl` can update all later calls (getUpdates / sendMessage /
 * QR status).
 */
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

function ensureSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

export class ILinkClient {
  private _baseUrl: string;
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
    this._baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.cdnBaseUrl = (options.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL).replace(/\/+$/, '');
    this._token = options.token;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.longPollTimeoutMs = options.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
    this.botAgent = options.botAgent ?? 'DeepSeekHarness/0.8.1';
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
    if (baseUrl && baseUrl.trim()) {
      this._baseUrl = baseUrl.replace(/\/+$/, '');
    }
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

  /** POST /ilink/bot/get_bot_qrcode?bot_type=3 with { local_token_list: [] }. */
  async getBotQrcode(signal?: AbortSignal): Promise<ILinkQrCodeResponse> {
    const endpoint = `${ENDPOINT_GET_BOT_QRCODE}?bot_type=${encodeURIComponent(DEFAULT_BOT_TYPE)}`;
    const raw = await this.post(endpoint, { local_token_list: [] }, signal);
    const value = raw as ILinkQrCodeResponse;
    return {
      qrcode: value.qrcode ?? '',
      qrcode_img_content: value.qrcode_img_content ?? '',
    };
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
      return raw as ILinkQrStatusResponse;
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
      const resp = raw as ILinkGetUpdatesResponse;
      if (resp.ret !== undefined && resp.ret !== 0) {
        if (resp.errcode === -14) {
          throw normalizeILinkError(new Error('stale token'), {
            operation: ENDPOINT_GET_UPDATES,
            accountId: this.accountId,
            ret: resp.ret,
            errcode: resp.errcode,
            errmsg: resp.errmsg,
          });
        }
        throw normalizeILinkError(new Error(resp.errmsg ?? `getUpdates ret=${resp.ret}`), {
          operation: ENDPOINT_GET_UPDATES,
          accountId: this.accountId,
          ret: resp.ret,
          errcode: resp.errcode,
          errmsg: resp.errmsg,
        });
      }
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
    const resp = raw as ILinkSendMessageResponse;
    if (resp.ret !== undefined && resp.ret !== 0) {
      throw normalizeILinkError(new Error(resp.errmsg ?? `sendmessage ret=${resp.ret}`), {
        operation: ENDPOINT_SEND_MESSAGE,
        accountId: this.accountId,
        ret: resp.ret,
        errmsg: resp.errmsg,
      });
    }
    return resp;
  }

  /** POST /ilink/bot/getuploadurl (WX5 media upload slot). */
  async getUploadUrl(req: ILinkGetUploadUrlRequest, signal?: AbortSignal): Promise<ILinkGetUploadUrlResponse> {
    const body = { ...req, base_info: req.base_info ?? this.baseInfo() };
    const raw = await this.post(ENDPOINT_GET_UPLOAD_URL, body, signal);
    return raw as ILinkGetUploadUrlResponse;
  }

  /** POST /ilink/bot/getconfig. */
  async getConfig(req: ILinkGetConfigRequest, signal?: AbortSignal): Promise<ILinkGetConfigResponse> {
    const body = { ...req, base_info: req.base_info ?? this.baseInfo() };
    const raw = await this.post(ENDPOINT_GET_CONFIG, body, signal);
    return raw as ILinkGetConfigResponse;
  }

  /** POST /ilink/bot/sendtyping. */
  async sendTyping(req: ILinkSendTypingRequest, signal?: AbortSignal): Promise<ILinkSendTypingResponse> {
    const body = { ...req, base_info: req.base_info ?? this.baseInfo() };
    const raw = await this.post(ENDPOINT_SEND_TYPING, body, signal);
    return raw as ILinkSendTypingResponse;
  }

  /** POST /ilink/bot/msg/notifystart (best effort). */
  async notifyStart(signal?: AbortSignal): Promise<ILinkNotifyResponse> {
    const raw = await this.post(ENDPOINT_NOTIFY_START, { base_info: this.baseInfo() }, signal);
    return raw as ILinkNotifyResponse;
  }

  /** POST /ilink/bot/msg/notifystop (best effort). */
  async notifyStop(signal?: AbortSignal): Promise<ILinkNotifyResponse> {
    const raw = await this.post(ENDPOINT_NOTIFY_STOP, { base_info: this.baseInfo() }, signal);
    return raw as ILinkNotifyResponse;
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
