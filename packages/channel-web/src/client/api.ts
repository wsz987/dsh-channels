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
  /** Access readiness of the channel (plan §28). */
  access: ChannelAccessReadiness;
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
  /** Safe provider polling interval (ms); never a secret (doc §15). */
  pollingIntervalMs?: number;
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
// Access-control DTOs (plan §27, §29) — mirror @wsz987/channel-control shapes.
// Policies carry ONLY canonical owner/sender/group ids — never any secret.
// ---------------------------------------------------------------------------

export type ChannelAccessReadiness =
  | 'ready'
  | 'needs-owner'
  | 'missing-policy'
  | 'invalid-policy';

/** How a channel determines its local operator / owner identity (plan §10). */
export type OwnerDiscoveryMode = 'account' | 'claim' | 'manual';

/** Declared access capability of a channel (plan §10). */
export interface ChannelAccessDescriptor {
  directMessages: boolean;
  groups: boolean;
  mentions: boolean;
  ownerDiscovery: OwnerDiscoveryMode;
  identityLabels: { user: string; group?: string };
  defaults?: { requireMention?: boolean };
}

export type AccessPreset = 'owner-only' | 'allowlist' | 'custom';
export type DirectMessagePolicy = 'disabled' | 'allowlist' | 'open';
export type GroupPolicy = 'disabled' | 'allowlist';
export type GroupSenderPolicy = 'allowlist' | 'open';

/** One named-group rule (V1: named groups only, no global open). */
export interface GroupAccessRule {
  enabled: boolean;
  senderPolicy: GroupSenderPolicy;
  allowFrom: string[];
  requireMention: boolean;
}

/** Versioned, cross-package access policy (shared contract in channel-core). */
export interface ChannelAccessPolicy {
  version: 1;
  preset: AccessPreset;
  ownerId?: string;
  dmPolicy: DirectMessagePolicy;
  allowFrom: string[];
  groupPolicy: GroupPolicy;
  groups: Record<string, GroupAccessRule>;
}

/** Full access picture for one channel+account (plan §27). */
export interface ChannelAccessState {
  descriptor: ChannelAccessDescriptor;
  readiness: ChannelAccessReadiness;
  policy?: ChannelAccessPolicy;
  owner: { configured: boolean; id?: string; source?: 'account' | 'claim' | 'manual' };
}

export type OwnerClaimPhase =
  | 'waiting-message'
  | 'candidate'
  | 'confirmed'
  | 'expired'
  | 'cancelled';

/** Browser-facing owner-claim session (plan §21). */
export interface PublicOwnerClaimSession {
  id: string;
  channelId: string;
  accountId: string;
  phase: OwnerClaimPhase;
  /** Short one-time challenge the local browser shows the operator. NOT a credential. */
  challengeCode?: string;
  expiresAt: number;
  candidate?: { senderId: string };
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
export async function fetchChannelsV2(signal?: AbortSignal): Promise<ChannelSummary[]> {
  const body = await request<{ channels: ChannelSummary[] }>('/channels', { signal });
  return body.channels ?? [];
}

/** GET /channels/:id/setup → ChannelSetupDescriptor */
export async function fetchSetup(id: string, signal?: AbortSignal): Promise<ChannelSetupDescriptor> {
  return request<ChannelSetupDescriptor>(`/channels/${encodeURIComponent(id)}/setup`, { signal });
}

/**
 * PUT /channels/:id/enabled → ChannelSummary (doc §23). Persists the enabled
 * intent; the control plane starts/stops the runtime accordingly.
 */
export async function setChannelEnabled(
  id: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<ChannelSummary> {
  return request<ChannelSummary>(`/channels/${encodeURIComponent(id)}/enabled`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ enabled }),
    signal,
  });
}

/** PATCH /channels/:id/config — non-secret patch → { configured, fields } */
export async function saveConfig(
  id: string,
  patch: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ configured: boolean; fields: ChannelSetupField[] }> {
  return request<{ configured: boolean; fields: ChannelSetupField[] }>(
    `/channels/${encodeURIComponent(id)}/config`,
    { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch), signal },
  );
}

/** PUT /channels/:id/credentials/:field — never echoes value */
export async function saveCredential(
  id: string,
  field: string,
  value: string,
  signal?: AbortSignal,
): Promise<{ configured: boolean; writable: boolean }> {
  return request<{ configured: boolean; writable: boolean }>(
    `/channels/${encodeURIComponent(id)}/credentials/${encodeURIComponent(field)}`,
    { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ value }), signal },
  );
}

export async function applySetup(
  id: string,
  input: {
    config: Record<string, unknown>;
    credentials: Record<string, string>;
    reconcile?: boolean;
  },
  signal?: AbortSignal,
): Promise<{ configured: boolean; connection: ConnectionState }> {
  return request(`/channels/${encodeURIComponent(id)}/setup`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
}

/** POST /channels/:id/auth/sessions → PublicAuthSession */
export async function beginAuth(
  id: string,
  method: AuthMethod,
  accountId?: string,
  signal?: AbortSignal,
): Promise<PublicAuthSession> {
  const body: Record<string, unknown> = { method };
  if (accountId) body.accountId = accountId;
  return request<PublicAuthSession>(`/channels/${encodeURIComponent(id)}/auth/sessions`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    signal,
  });
}

/** GET /channels/:id/auth/sessions/:sessionId → PublicAuthStatus */
export async function pollAuthSession(
  id: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<PublicAuthStatus> {
  return request<PublicAuthStatus>(
    `/channels/${encodeURIComponent(id)}/auth/sessions/${encodeURIComponent(sessionId)}`,
    { signal },
  );
}

/** POST /channels/:id/auth/sessions/:sessionId/input → PublicAuthStatus */
export async function submitAuthInput(
  id: string,
  sessionId: string,
  kind: string,
  value: string,
  signal?: AbortSignal,
): Promise<PublicAuthStatus> {
  return request<PublicAuthStatus>(
    `/channels/${encodeURIComponent(id)}/auth/sessions/${encodeURIComponent(sessionId)}/input`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ kind, value }), signal },
  );
}

/** DELETE /channels/:id/auth/sessions/:sessionId → 204 */
export async function cancelAuth(
  id: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  await request<unknown>(`/channels/${encodeURIComponent(id)}/auth/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    signal,
  });
}

// ---------------------------------------------------------------------------
// Access-control API (plan §30)
// ---------------------------------------------------------------------------

/** GET /channels/:id/access → ChannelAccessState */
export async function fetchAccess(id: string, signal?: AbortSignal): Promise<ChannelAccessState> {
  return request<ChannelAccessState>(`/channels/${encodeURIComponent(id)}/access`, { signal });
}

/** PUT /channels/:id/access → ChannelAccessState */
export async function saveAccess(
  id: string,
  policy: ChannelAccessPolicy,
  signal?: AbortSignal,
): Promise<ChannelAccessState> {
  return request<ChannelAccessState>(`/channels/${encodeURIComponent(id)}/access`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(policy),
    signal,
  });
}

/** POST /channels/:id/access/owner-claims → 201 PublicOwnerClaimSession */
export async function beginOwnerClaim(
  id: string,
  signal?: AbortSignal,
): Promise<PublicOwnerClaimSession> {
  return request<PublicOwnerClaimSession>(
    `/channels/${encodeURIComponent(id)}/access/owner-claims`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({}), signal },
  );
}

/** GET /channels/:id/access/owner-claims/:claimId → PublicOwnerClaimSession */
export async function fetchOwnerClaim(
  id: string,
  claimId: string,
  signal?: AbortSignal,
): Promise<PublicOwnerClaimSession> {
  return request<PublicOwnerClaimSession>(
    `/channels/${encodeURIComponent(id)}/access/owner-claims/${encodeURIComponent(claimId)}`,
    { signal },
  );
}

/** POST /channels/:id/access/owner-claims/:claimId/confirm → ChannelAccessState */
export async function confirmOwnerClaim(
  id: string,
  claimId: string,
  signal?: AbortSignal,
): Promise<ChannelAccessState> {
  return request<ChannelAccessState>(
    `/channels/${encodeURIComponent(id)}/access/owner-claims/${encodeURIComponent(claimId)}/confirm`,
    { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({}), signal },
  );
}

/** DELETE /channels/:id/access/owner-claims/:claimId → 204 */
export async function cancelOwnerClaim(
  id: string,
  claimId: string,
  signal?: AbortSignal,
): Promise<void> {
  await request<unknown>(
    `/channels/${encodeURIComponent(id)}/access/owner-claims/${encodeURIComponent(claimId)}`,
    { method: 'DELETE', signal },
  );
}
