/**
 * Error hierarchy with stable machine-readable codes.
 *
 * Contract tests assert error mapping through these codes; adapters must
 * wrap platform errors into `ChannelError` subclasses at their boundary.
 */
export type ChannelErrorCode =
  | 'CHANNEL_ERROR'
  | 'CHANNEL_START_FAILED'
  | 'CHANNEL_STOP_FAILED'
  | 'CHANNEL_SEND_FAILED'
  | 'CHANNEL_AUTH_FAILED'
  | 'CHANNEL_DUPLICATE_ID'
  | 'CHANNEL_NOT_STARTED'
  | 'CHANNEL_UNSUPPORTED';

const MESSAGES: Record<ChannelErrorCode, string> = {
  CHANNEL_ERROR: 'channel error',
  CHANNEL_START_FAILED: 'channel failed to start',
  CHANNEL_STOP_FAILED: 'channel failed to stop',
  CHANNEL_SEND_FAILED: 'channel failed to send message',
  CHANNEL_AUTH_FAILED: 'channel authentication failed',
  CHANNEL_DUPLICATE_ID: 'a channel adapter with this id is already registered',
  CHANNEL_NOT_STARTED: 'channel adapter is not started',
  CHANNEL_UNSUPPORTED: 'operation not supported by this channel adapter',
};

/** Base channel error. */
export class ChannelError extends Error {
  readonly code: ChannelErrorCode;

  constructor(code: ChannelErrorCode = 'CHANNEL_ERROR', message?: string, options?: ErrorOptions) {
    super(message ?? MESSAGES[code], options);
    this.name = 'ChannelError';
    this.code = code;
  }
}

export class ChannelStartError extends ChannelError {
  constructor(message?: string, options?: ErrorOptions) {
    super('CHANNEL_START_FAILED', message, options);
    this.name = 'ChannelStartError';
  }
}

export class ChannelStopError extends ChannelError {
  constructor(message?: string, options?: ErrorOptions) {
    super('CHANNEL_STOP_FAILED', message, options);
    this.name = 'ChannelStopError';
  }
}

export class ChannelSendError extends ChannelError {
  constructor(message?: string, options?: ErrorOptions) {
    super('CHANNEL_SEND_FAILED', message, options);
    this.name = 'ChannelSendError';
  }
}

export class ChannelAuthError extends ChannelError {
  constructor(message?: string, options?: ErrorOptions) {
    super('CHANNEL_AUTH_FAILED', message, options);
    this.name = 'ChannelAuthError';
  }
}

export class ChannelDuplicateError extends ChannelError {
  constructor(message?: string, options?: ErrorOptions) {
    super('CHANNEL_DUPLICATE_ID', message, options);
    this.name = 'ChannelDuplicateError';
  }
}

export class ChannelNotStartedError extends ChannelError {
  constructor(message?: string, options?: ErrorOptions) {
    super('CHANNEL_NOT_STARTED', message, options);
    this.name = 'ChannelNotStartedError';
  }
}

export class ChannelUnsupportedError extends ChannelError {
  constructor(message?: string, options?: ErrorOptions) {
    super('CHANNEL_UNSUPPORTED', message, options);
    this.name = 'ChannelUnsupportedError';
  }
}

/** Whether an error is a channel error with the given code. */
export function isChannelError(error: unknown, code?: ChannelErrorCode): error is ChannelError {
  if (!(error instanceof ChannelError)) return false;
  return code === undefined || error.code === code;
}

/** Normalize an unknown thrown value into a ChannelError with a stable code. */
export function toChannelError(
  error: unknown,
  code: ChannelErrorCode,
  fallback?: string,
): ChannelError {
  if (error instanceof ChannelError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ChannelError(code, fallback ?? message);
}

/**
 * Cordis throws its own errors (e.g. `CordisError`); keep a stable code for
 * them without depending on cordis internals at call sites.
 */
export function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'string') return new Error(error);
  return new Error(String(error));
}
