/**
 * Client-side DTO + fetch wrapper for the dsh-channels host API (M1).
 *
 * The host serves these under /dsh-channels/api/v1 in the same origin, so
 * plain relative fetch() works. All endpoints return sanitized JSON — no
 * tokens or verify codes ever appear in responses.
 */

export interface ChannelView {
  id: string;
  enabled: boolean;
  configured: boolean;
  mounted: boolean;
  status: 'connected' | 'degraded' | 'unconfigured' | 'error';
  health?: {
    status?: string;
    detail?: string;
    connection?: string;
    authenticated?: boolean;
    error?: string;
  } | null;
  capabilities?: Record<string, boolean | string> | null;
  lastError?: string | null;
}

export interface PublicAuthChallenge {
  id: string;
  instruction: string;
  qrUrl?: string;
  expiresAt?: number;
}

export interface PublicAuthPoll {
  state: 'pending' | 'authenticated' | 'expired' | 'failed';
  detail?: string;
  prompt?: string;
}

export interface PublicAuthInput {
  kind: 'verification-code';
  value: string;
}

export interface PublicError {
  error: { code: string; message: string };
}

const BASE = '/dsh-channels/api/v1';

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, init);
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

export async function fetchChannels(): Promise<ChannelView[]> {
  return request<ChannelView[]>('/channels');
}

export async function fetchChannel(id: string): Promise<ChannelView> {
  return request<ChannelView>(`/channels/${encodeURIComponent(id)}`);
}

export async function startAuth(id: string): Promise<PublicAuthChallenge> {
  return request<PublicAuthChallenge>(`/channels/${encodeURIComponent(id)}/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function pollAuth(id: string, challengeId: string): Promise<PublicAuthPoll> {
  return request<PublicAuthPoll>(`/channels/${encodeURIComponent(id)}/auth/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId }),
  });
}

export async function submitAuthInput(id: string, challengeId: string, input: PublicAuthInput): Promise<PublicAuthPoll> {
  return request<PublicAuthPoll>(`/channels/${encodeURIComponent(id)}/auth/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ challengeId, input }),
  });
}