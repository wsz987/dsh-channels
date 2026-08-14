/**
 * Weixin QR login state machine (WX2).
 *
 * Wraps the iLink `get_bot_qrcode` / `get_qrcode_status` calls with the full
 * upstream state machine (wait/scaned/confirmed/expired/need_verifycode/
 * verify_code_blocked/scaned_but_redirect/binded_redirect). The Channel
 * Contract states (pending/authenticated/expired/failed) may normalize the
 * upstream states, but the internal machine keeps full fidelity so none of the
 * upstream information is lost.
 *
 * Redirect (`scaned_but_redirect`) updates the {@link ILinkClient} baseUrl for
 * all later calls. Verify codes are submitted through {@link WeixinQrAuth.submitVerifyCode}
 * — never through stdin — so the CLI/ChannelService owns that UX.
 */
import type { AuthChallenge, AuthStatePoll } from '@wsz987/channel-core';
import { ChannelError } from '@wsz987/channel-core';
import type { ILinkClient } from '../ilink/client.js';
import type { ILinkQrStatus, ILinkQrStatusResponse } from '../ilink/types.js';

export interface WeixinQrAuthOptions {
  client: ILinkClient;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Optional expiry budget in ms (default 5 min). */
  expiresInMs?: number;
}

/** Full fidelity upstream state + redirect/baseUrl tracking. */
export interface WeixinQrAuthInternalState {
  status: ILinkQrStatus | 'unknown' | 'failed';
  /** Effective base URL after IDC redirect. */
  baseUrl?: string;
  botToken?: string;
  ilinkBotId?: string;
  userId?: string;
  pendingVerifyCode?: boolean;
  /** True when `binded_redirect` reports the bot is already bound. */
  alreadyBound?: boolean;
}

const EMPTY: WeixinQrAuthInternalState = {
  status: 'unknown',
  baseUrl: undefined,
  botToken: undefined,
  ilinkBotId: undefined,
  userId: undefined,
  pendingVerifyCode: false,
  alreadyBound: false,
};

/** Map a raw upstream status (already validated) to a Channel AuthState. */
export function toChannelState(status: ILinkQrStatus | 'unknown'): AuthStatePoll['state'] {
  switch (status) {
    case 'confirmed':
    case 'binded_redirect':
      return 'authenticated';
    case 'expired':
    case 'verify_code_blocked':
      return 'failed';
    case 'need_verifycode':
    case 'scaned_but_redirect':
    case 'scaned':
    case 'wait':
      return 'pending';
    default:
      return 'pending';
  }
}

export class WeixinQrAuth {
  private readonly client: ILinkClient;
  private readonly now: () => number;
  private readonly expiresInMs: number;

  /** The last known full-fidelity upstream state. */
  private state: WeixinQrAuthInternalState = { ...EMPTY };
  /** Active challenge state. */
  private activeId?: string;
  private qrcode?: string;
  private startedAt = 0;
  private pendingVerifyCode?: string;

  constructor(options: WeixinQrAuthOptions) {
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.expiresInMs = options.expiresInMs ?? 5 * 60_000;
  }

  /** Current full-fidelity internal state. */
  getState(): WeixinQrAuthInternalState {
    return { ...this.state };
  }

  /** Whether the last known state is authenticated. */
  get isAuthenticated(): boolean {
    return this.state.status === 'confirmed' || this.state.status === 'binded_redirect';
  }

  /**
   * Begin QR auth: fetch a fresh QR challenge from the iLink client.
   * Returns the Channel Contract {@link AuthChallenge}.
   */
  async beginAuth(): Promise<AuthChallenge> {
    const started = this.now();
    const qr = await this.client.getBotQrcode();
    // Reset internal machine for a fresh challenge.
    this.state = { ...EMPTY };
    this.activeId = `weixin-qr-${started}`;
    this.qrcode = qr.qrcode;
    this.startedAt = started;
    this.pendingVerifyCode = undefined;

    if (!qr.qrcode && !qr.qrcode_img_content) {
      throw new ChannelError('CHANNEL_AUTH_FAILED', 'weixin QR login: server returned no qrcode');
    }

    return {
      id: this.activeId,
      instruction: '请使用微信扫描二维码',
      qrUrl: qr.qrcode_img_content,
      expiresAt: started + this.expiresInMs,
    };
  }

  /**
   * Poll the QR status. On `scaned_but_redirect`, updates the client baseUrl
   * from `redirect_host`. On `confirmed`, records token/botId/baseUrl/userId
   * and returns the applicable Channel AuthStatePoll.
   */
  async pollAuth(challenge: AuthChallenge): Promise<AuthStatePoll> {
    if (this.activeId !== challenge.id || !this.qrcode) {
      throw new ChannelError('CHANNEL_AUTH_FAILED', 'weixin QR auth: poll used a stale/invalid challenge');
    }
    if (challenge.expiresAt !== undefined && this.now() > challenge.expiresAt) {
      this.state.status = 'expired';
      return { state: 'expired', detail: 'weixin QR code expired' };
    }

    let response: ILinkQrStatusResponse;
    try {
      response = await this.client.getQrcodeStatus(this.qrcode, {
        verifyCode: this.pendingVerifyCode,
      });
    } catch (error) {
      // getQrcodeStatus already maps long-poll aborts/timeouts to `wait`, so
      // a throw here is a genuine protocol/network error — surface as failed.
      this.state.status = 'unknown';
      return {
        state: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const status = (response.status ?? 'wait') as ILinkQrStatus;
    this.state.status = status;

    switch (status) {
      case 'scaned_but_redirect': {
        if (response.redirect_host) {
          const newBase = `https://${response.redirect_host}`;
          this.client.setBaseUrl(newBase);
          this.state.baseUrl = newBase;
        }
        return { state: 'pending', detail: 'weixin QR scanned; redirecting to IDC host' };
      }
      case 'need_verifycode': {
        this.state.pendingVerifyCode = this.state.pendingVerifyCode === undefined ? true : undefined;
        return { state: 'pending', detail: 'weixin QR requires a phone-verified code' };
      }
      case 'scaned': {
        // After a verify code is accepted, the status may return to scaned.
        if (this.pendingVerifyCode) this.pendingVerifyCode = undefined;
        return { state: 'pending', detail: 'weixin QR scanned; waiting for confirmation' };
      }
      case 'confirmed': {
        if (!response.bot_token || !response.ilink_bot_id) {
          this.state.status = 'failed';
          return { state: 'failed', detail: 'weixin QR confirmed but server omitted bot identity' };
        }
        this.state.botToken = response.bot_token;
        this.state.ilinkBotId = response.ilink_bot_id;
        this.state.userId = response.ilink_user_id;
        this.state.alreadyBound = false;
        if (response.baseurl) {
          this.client.setBaseUrl(response.baseurl);
          this.state.baseUrl = response.baseurl;
        } else if (!this.client.baseUrl) {
          this.state.baseUrl = this.client.baseUrl;
        }
        return { state: 'authenticated', detail: 'weixin QR confirmed and authenticated' };
      }
      case 'binded_redirect': {
        this.state.alreadyBound = true;
        if (response.redirect_host) {
          const newBase = `https://${response.redirect_host}`;
          this.client.setBaseUrl(newBase);
          this.state.baseUrl = newBase;
        }
        return { state: 'authenticated', detail: 'weixin bot already bound; existing credentials remain valid' };
      }
      case 'expired':
        return { state: 'expired', detail: 'weixin QR code expired' };
      case 'verify_code_blocked':
        this.state.pendingVerifyCode = undefined;
        return { state: 'failed', detail: 'weixin QR verify code blocked after repeated failures' };
      case 'wait':
      default:
        return { state: 'pending', detail: 'awaiting WeChat scan' };
    }
  }

  /**
   * Submit a phone-verify code (from the ChannelService/CLI — never stdin
   * inside the adapter). Clears any previously pending code.
   */
  submitVerifyCode(code: string): void {
    this.pendingVerifyCode = code;
    this.state.pendingVerifyCode = true;
  }

  /** The credential-ready result produced by a `confirmed` poll. */
  get confirmedCredential():
    | { token: string; ilinkBotId: string; userId?: string; baseUrl: string }
    | undefined {
    if (!this.state.botToken || !this.state.ilinkBotId) return undefined;
    return {
      token: this.state.botToken,
      ilinkBotId: this.state.ilinkBotId,
      userId: this.state.userId,
      baseUrl: this.state.baseUrl ?? this.client.baseUrl,
    };
  }
}

export type { AuthChallenge, AuthStatePoll };
