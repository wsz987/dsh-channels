/**
 * Typed iLink protocol errors and normalization.
 *
 * Tokens are NEVER embedded in error messages or logs — every message passes
 * through {@link redactMessage}.
 */
import { ChannelError, ChannelSendError } from '@wsz987/channel-core';
import { STALE_TOKEN_ERRCODE } from './constants.js';

/** iLink protocol-level error (server returned `ret !== 0`). */
export class ILinkError extends ChannelError {
  /** Upstream ret code (`0` = success). */
  readonly ret: number;
  /** Optional server error code (e.g. -14 stale token). */
  readonly errcode?: number;
  /** Raw server message; already redacted. */
  readonly upstreamMessage?: string;

  constructor(
    ret: number,
    message: string,
    options?: { errcode?: number; errmsg?: string; cause?: unknown },
  ) {
    super('CHANNEL_ERROR', message, { cause: options?.cause });
    this.name = 'ILinkError';
    this.ret = ret;
    this.errcode = options?.errcode;
    this.upstreamMessage = options?.errmsg ? redactMessage(options.errmsg) : undefined;
  }
}

/** The bot token is stale / expired (server `errcode === -14`). */
export class StaleTokenError extends ChannelError {
  readonly accountId: string;

  constructor(accountId: string, options?: { cause?: unknown }) {
    super('CHANNEL_AUTH_FAILED', `weixin bot token for account '${accountId}' is stale or expired; re-authenticate via QR login`, {
      cause: options?.cause,
    });
    this.name = 'StaleTokenError';
    this.accountId = accountId;
  }
}

/** A request timed out (client-side or long-poll client abort). */
export class ILinkTimeoutError extends ChannelError {
  readonly operation: string;

  constructor(operation: string, options?: { cause?: unknown }) {
    super('CHANNEL_ERROR', `weixin ${operation} timed out`, { cause: options?.cause });
    this.name = 'ILinkTimeoutError';
    this.operation = operation;
  }
}

/** A request was aborted by an external signal (normal teardown). */
export class ILinkAbortError extends ChannelError {
  readonly operation: string;

  constructor(operation: string, options?: { cause?: unknown }) {
    super('CHANNEL_ERROR', `weixin ${operation} aborted`, { cause: options?.cause });
    this.name = 'ILinkAbortError';
    this.operation = operation;
  }
}

/** A sendmessage RPC failed; keeps the ChannelSendError code. */
export class ILinkSendError extends ChannelSendError {
  readonly operation: string;

  constructor(operation: string, message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'ILinkSendError';
    this.operation = operation;
  }
}

const SENSITIVE_TOKEN = /(bot_token|token|context_token|authorization|authorization|access_key|aes_key)/gi;

/**
 * Redact known sensitive values from a message/body for logs and errors.
 */
export function redactMessage(input: string | undefined | null): string {
  if (!input) return '';
  return String(input).replace(SENSITIVE_TOKEN, '<redacted>');
}

/**
 * Normalize an unknown thrown value into a typed iLink error. Determines
 * whether the failure was a protocol ret-code error, a stale token, a timeout,
 * an abort, or a network error — and throws the closest typed error. Never
 * includes token values.
 */
export function normalizeILinkError(
  error: unknown,
  context: { operation: string; accountId: string; ret?: number; errcode?: number; errmsg?: string },
): ChannelError {
  // Re-wrap typed protocol errors.
  if (error instanceof ILinkError || error instanceof StaleTokenError) return error;

  const { operation, accountId, ret, errcode, errmsg } = context;
  if (ret !== undefined && ret !== 0) {
    if (errcode === STALE_TOKEN_ERRCODE) {
      return new StaleTokenError(accountId, { cause: error });
    }
    return new ILinkError(ret, redactMessage(errmsg) || `weixin ${operation} returned ret=${ret}`, { errcode });
  }

  if (isAbortError(error)) return new ILinkAbortError(operation, { cause: error });
  if (isTimeoutError(error)) return new ILinkTimeoutError(operation, { cause: error });

  if (error instanceof ChannelError) {
    // Preserve transport-channel errors but redact any accidental token text.
    const channel = error as ChannelError;
    return new ChannelError(channel.code ?? 'CHANNEL_ERROR', redactMessage(channel.message), { cause: channel });
  }

  const base = error instanceof Error ? error.message : String(error);
  return new ChannelError('CHANNEL_ERROR', `weixin ${operation} failed: ${redactMessage(base)}`, { cause: error });
}

/** Whether a thrown value indicates an external abort. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof ILinkAbortError) return true;
  return (error as Error)?.name === 'AbortError';
}

/** Whether a thrown value indicates a timeout abort. */
export function isTimeoutError(error: unknown): boolean {
  return (error as { code?: string })?.code === 'UND_ERR_CONNECT_TIMEOUT' || (error as Error)?.name === 'AbortError';
}
