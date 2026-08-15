/**
 * Public-DTO sanitizer (doc §18, §59).
 *
 * Converts host-only auth session/status objects into browser-facing public
 * DTOs. The sanitizer is the ONLY legitimate path to a [PublicAuthSession] /
 * [PublicAuthStatus]: it strips every field that must never reach the browser
 * (providerState, challenge, deviceCode, tokens, any provider payload).
 * Security tests assert the absence of these fields after sanitization.
 *
 * The manager stores sessions as a [SessionSnapshot] — an [InternalAuthSession]
 * plus the host-tracked current phase/state/qr/prompt. The sanitizer accepts
 * that snapshot and forwards only the declared public fields.
 */
import type {
  AuthMethod,
  AuthPhase,
  AuthProviderSession,
  AuthState,
  InternalAuthSession,
  PublicAuthPrompt,
  PublicAuthSession,
  PublicAuthStatus,
  PublicQrPayload,
} from '../types.js';

/** Host-view snapshot the manager keeps for one session. */
export interface SessionSnapshot extends InternalAuthSession {
  method: AuthMethod;
  state: AuthState;
  phase: AuthPhase;
  qr?: PublicQrPayload;
  prompt?: PublicAuthPrompt;
  /** The full provider session returned by beginAuth (host-only). */
  providerSession: AuthProviderSession;
}

/** Deep-copy a QR payload so mutations cannot escape the host boundary. */
export function toPublicQr(qr: PublicQrPayload | undefined): PublicQrPayload | undefined {
  if (!qr) return undefined;
  return qr.kind && qr.value ? { ...qr } : undefined;
}

export function toPublicPrompt(
  prompt: PublicAuthPrompt | undefined,
): PublicAuthPrompt | undefined {
  return prompt ? { ...prompt } : undefined;
}

/**
 * Field-by-field copy into the public session shape. Nothing beyond the
 * declared public fields is forwarded, so a host mutation cannot leak.
 */
export function toPublicSession(session: SessionSnapshot): PublicAuthSession {
  const publicSession: PublicAuthSession = {
    id: session.id,
    channelId: session.channelId,
    state: session.state,
    phase: session.phase,
  };
  const qr = toPublicQr(session.qr);
  if (qr) publicSession.qr = qr;
  if (session.expiresAt !== undefined) publicSession.expiresAt = session.expiresAt;
  const prompt = toPublicPrompt(session.prompt);
  if (prompt) publicSession.prompt = prompt;
  return publicSession;
}

/** Sanitize a poll/status result, dropping any host-only fields. */
export function toPublicStatus(status: PublicAuthStatus): PublicAuthStatus {
  const result: PublicAuthStatus = {
    state: status.state,
    phase: status.phase,
  };
  if (status.expiresAt !== undefined) result.expiresAt = status.expiresAt;
  if (status.detail !== undefined) result.detail = status.detail;
  const prompt = toPublicPrompt(status.prompt);
  if (prompt) result.prompt = prompt;
  return result;
}
