/**
 * Client-side DTO + fetch wrapper for the dsh-channels host API (M5).
 *
 * The host serves the control plane under /dsh-channels/api/v2 in the same
 * origin, so plain relative fetch() works. All endpoints return sanitized
 * JSON — the client never sees a credential ref or a secret value; it only
 * knows `configured` / `writable` booleans. The legacy /v1 auth endpoints are
 * kept behind the same `request()` helper (a parallel host subagent maintains
 * the v1 compat layer) but this client has been migrated to v2.
 */

// ---------------------------------------------------------------------------
// DTO types
// ---------------------------------------------------------------------------

export type AuthMethod = 'qr' | 'device' | 'portal-login' | 'credentials' | 'hybrid';

export type AuthPhase =
  | 'preparing'
  | 'waiting-scan'
  | 'scanned'
  | 'waiting-confirm'
  | 'verification-required'
  | 'credentials-required'
  | 'authorized'
  | 'expired'
  | 'failed'
  | 'cancelled';

export type RuntimeState = 'running' | 'stopped';

export type ConnectionState = 'connected' | 'degraded' | 'disconnected' | 'unknown';

/** v2 channel list summary (GET /channels). */
export interface ChannelSummary {
  id: string;
  configured: boolean;
  enabled: boolean;
  mounted: boolean;
  runtime: RuntimeState;
  connection: ConnectionState;
}

/** One setup field of a ChannelSetupDescriptor. `ref` is stripped by the host. */
export interface ChannelSetupField {
  name: string;
  kind: 'text' | 'secret';
  secret: boolean;
  configured: boolean;
  writable: boolean;
  /**
   * Current value for NON-secret fields only (e.g. appId/clientId). Secret
   * fields never carry it — the host omits secret values entirely.
   */
  value?: string;
}

/** v2 setup descriptor (GET /channels/:id/setup). */
export interface ChannelSetupDescriptor {
  fields: ChannelSetupField[];
  authMethods: AuthMethod[];
  setupUrl?: string;
}

export type PublicQrPayloadKind = 'content' | 'data-url' | 'external-url';

export interface PublicQrPayload {
  kind: PublicQrPayloadKind;
  value: string;
  expiresAt?: number;
}

export interface PublicAuthPrompt {
  kind: 'verification-code' | 'confirm-on-phone' | 'credentials-required' | 'open-browser';
  message?: string;
}

/** v2 public auth session (POST /channels/:id/auth/sessions). */
export interface PublicAuthSession {
  id: string;
  channelId: string;
  state: 'pending' | 'authenticated' | 'expired' | 'failed';
  phase: AuthPhase;
  qr?: PublicQrPayload | null;
  expiresAt?: number;
  prompt?: PublicAuthPrompt | null;
}

/** v2 public auth status (GET /channels/:id/auth/sessions/:sessionId). */
export interface PublicAuthStatus {
  state: 'pending' | 'authenticated' | 'expired' | 'failed';
  phase: AuthPhase;
  prompt?: PublicAuthPrompt | null;
  expiresAt?: number;
  detail?: string;
}

export interface PublicError {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// fetch helper
// ---------------------------------------------------------------------------

/** v2 control plane base; v1 kept for the legacy compat surface. */
const BASE_V2 = '/dsh-channels/api/v2';
const BASE_V1 = '/dsh-channels/api/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function request<T>(path: string, init?: RequestInit, base: string = BASE_V2): Promise<T> {
  const res = await fetch(base + path, init);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as PublicError | null)?.error;
    throw new ApiError(res.status, err?.code, err?.message ?? `request failed (${res.status})`);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// v2 API
// ---------------------------------------------------------------------------

/** GET /channels → ChannelSummary[] */
export async function fetchChannelsV2(): Promise<ChannelSummary[]> {
  const body = await request<{ channels: ChannelSummary[] }>('/channels');
  return body.channels ?? [];
}

/** GET /channels/:id/setup → ChannelSetupDescriptor */
export async function fetchSetup(id: string): Promise<ChannelSetupDescriptor> {
  return request<ChannelSetupDescriptor>(`/channels/${encodeURIComponent(id)}/setup`);
}

/** PATCH /channels/:id/config — non-secret patch → { configured, fields } */
export async function saveConfig(
  id: string,
  patch: Record<string, unknown>,
): Promise<{ configured: boolean; fields: ChannelSetupField[] }> {
  return request<{ configured: boolean; fields: ChannelSetupField[] }>(
    `/channels/${encodeURIComponent(id)}/config`,
    { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch) },
  );
}

/** PUT /channels/:id/credentials/:field — never echoes value */
export async function saveCredential(
  id: string,
  field: string,
  value: string,
): Promise<{ configured: boolean; writable: boolean }> {
  return request<{ configured: boolean; writable: boolean }>(
    `/channels/${encodeURIComponent(id)}/credentials/${encodeURIComponent(field)}`,
    { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ value }) },
  );
}

export async function applySetup(
  id: string,
  input: {
    config: Record<string, unknown>;
    credentials: Record<string, string>;
    reconcile?: boolean;
  },
): Promise<{ configured: boolean; connection: ConnectionState }> {
  return request(`/channels/${encodeURIComponent(id)}/setup`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** POST /channels/:id/auth/sessions → PublicAuthSession */
export async function beginAuth(
  id: string,
  method: AuthMethod,
  accountId?: string,
): Promise<PublicAuthSession> {
  const body: Record<string, unknown> = { method };
  if (accountId) body.accountId = accountId;
  return request<PublicAuthSession>(`/channels/${encodeURIComponent(id)}/auth/sessions`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
}

/** GET /channels/:id/auth/sessions/:sessionId → PublicAuthStatus */
export async function pollAuthSession(id: string, sessionId: string): Promise<PublicAuthStatus> {
  return request<PublicAuthStatus>(
    `/channels/${encodeURIComponent(id)}/auth/sessions/${encodeURIComponent(sessionId)}`,
  );
}

/** POST /channels/:id/auth/sessions/:sessionId/input → PublicAuthStatus */
export async function submitAuthInput(
  id: string,
  sessionId: string,
  kind: string,
  value: string,
): Promise<PublicAuthStatus> {
  return request<PublicAuthStatus>(
    `/channels/${encodeURIComponent(id)}/auth/sessions/${encodeURIComponent(sessionId)}/input`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ kind, value }) },
  );
}

/** DELETE /channels/:id/auth/sessions/:sessionId → 204 */
export async function cancelAuth(id: string, sessionId: string): Promise<void> {
  await request<unknown>(`/channels/${encodeURIComponent(id)}/auth/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}
