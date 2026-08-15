/**
 * Control-plane error hierarchy with stable machine-readable codes.
 *
 * Channel-level errors reuse [ChannelError] from @wsz987/channel-core (e.g.
 * duplicate definition ids). The control plane additionally defines codes for
 * its own security/session concerns (auth not supported, unknown/cancelled/
 * expired sessions, rejected secret fields) that are NOT part of the core's
 * fixed [ChannelErrorCode] union, so they live here without touching core.
 */
export type ControlErrorCode =
  | 'CONTROL_ERROR'
  | 'CONTROL_DEFINITION_NOT_FOUND'
  | 'AUTH_NOT_SUPPORTED'
  | 'AUTH_SESSION_NOT_FOUND'
  | 'AUTH_SESSION_CANCELLED'
  | 'AUTH_SESSION_EXPIRED'
  | 'AUTH_NOT_READY'
  | 'SECRET_FIELD_REJECTED'
  | 'NOT_A_SECRET_FIELD'
  | 'CREDENTIAL_NOT_SUPPORTED'
  | 'CREDENTIAL_READONLY'
  | 'INVALID_CREDENTIAL'
  | 'UNKNOWN_FIELD';

const MESSAGES: Record<ControlErrorCode, string> = {
  CONTROL_ERROR: 'channel control error',
  CONTROL_DEFINITION_NOT_FOUND: 'channel definition is not registered',
  AUTH_NOT_SUPPORTED: 'channel does not support interactive authorization',
  AUTH_SESSION_NOT_FOUND: 'auth session not found',
  AUTH_SESSION_CANCELLED: 'auth session was cancelled',
  AUTH_SESSION_EXPIRED: 'auth session has expired',
  AUTH_NOT_READY: 'channel is not mounted; start it before beginning auth',
  SECRET_FIELD_REJECTED: 'secret fields must be saved through the credentials seam',
  NOT_A_SECRET_FIELD: 'field is not a secret; save it through the config endpoint',
  CREDENTIAL_NOT_SUPPORTED: 'field has no credential ref',
  CREDENTIAL_READONLY: 'credential is read-only (not writable)',
  INVALID_CREDENTIAL: 'credential value must be a non-empty string',
  UNKNOWN_FIELD: 'channel has no such setup field',
};

/** Base control-plane error. */
export class ControlError extends Error {
  readonly code: ControlErrorCode;

  constructor(code: ControlErrorCode = 'CONTROL_ERROR', message?: string, options?: ErrorOptions) {
    super(message ?? MESSAGES[code], options);
    this.name = 'ControlError';
    this.code = code;
  }
}

/** Whether a value is a control error with the given code. */
export function isControlError(error: unknown, code?: ControlErrorCode): error is ControlError {
  if (!(error instanceof ControlError)) return false;
  return code === undefined || error.code === code;
}

/** Normalize an unknown thrown value into a ControlError with a stable code. */
export function toControlError(
  error: unknown,
  code: ControlErrorCode,
  fallback?: string,
): ControlError {
  if (error instanceof ControlError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ControlError(code, fallback ?? message);
}
