/**
 * dsh-channels host API routes (M1). Read-only dashboard + Weixin QR auth loop.
 *
 * Lives on `/dsh-channels/api/v1` and talks only to `ctx.channels`
 * (ChannelService `get` / `list`) and each adapter's beginAuth / pollAuth /
 * submitAuthInput / getHealth hooks. No lifecycle refactor (M2), no other platform
 * config work.
 *
 * Auth challenges are stored host-side in a Map keyed by challenge id; only the
 * public subset (id/instruction/qrUrl/expiresAt) is ever put on the wire.
 * Adapter payloads and credentials never leave the process.
 */
import type {
  AuthChallenge,
  AuthInput,
  AuthStatePoll,
  ChannelAdapter,
  ChannelHealth,
} from '@wsz987/channel-core';
import { errorBody } from './security.js';
import { authInputSchema } from './routes-v2.js';

/** Client-safe view status enum (spec §23). */
export type ChannelStatus = 'connected' | 'degraded' | 'unconfigured' | 'error';

/** The fixed four-channel catalog the dashboard always shows, mounted or not. */
export const CHANNEL_CATALOG = ['weixin', 'qq', 'dingtalk', 'lark'] as const;
export type ChannelCatalogId = (typeof CHANNEL_CATALOG)[number];

/** Client-safe view of one channel (spec: id/enabled/configured/mounted/status/health/capabilities/lastError). */
export interface ChannelView {
  id: string;
  enabled: boolean;
  configured: boolean;
  mounted: boolean;
  status: ChannelStatus;
  health?: ChannelHealth | null;
  capabilities?: Record<string, boolean | string> | null;
  lastError?: string | null;
}

/** Public auth challenge — never includes the adapter's payload. */
export interface PublicAuthChallenge {
  id: string;
  instruction: string;
  qrUrl?: string;
  expiresAt?: number;
}

export interface PublicAuthPoll {
  state: 'pending' | 'authenticated' | 'expired' | 'failed';
  detail?: string;
  /** Client hint: 'verify-code' | 'confirm' | 'waiting-scan' | undefined. */
  prompt?: string;
}

/** Minimal structural view of the ChannelService surface we consume. */
export interface ChannelsLike {
  get(id: string): ChannelAdapter | undefined;
  list(): ChannelAdapter[];
}

export interface ChannelRoutesOptions {
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface ApiResult {
  status: number;
  body: unknown;
}

/** Human label for a channel id; falls back to the id itself. */
const CHANNEL_LABELS: Record<string, string> = {
  weixin: 'Weixin',
  qq: 'QQ',
  dingtalk: 'DingTalk',
  lark: 'Lark',
};

/** Sanitize a channel lastError to avoid leaking credentials. */
function safeLastError(error: unknown): string | null {
  if (!error) return null;
  const msg = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);
  if (!msg) return null;
  return errorBody('REDACTED', msg).error.message;
}

export class ChannelApi {
  private readonly channels: ChannelsLike;
  private readonly now: () => number;
  /** Host-side store of full auth challenges: never exposes payload. */
  private readonly challenges = new Map<string, AuthChallenge>();

  constructor(channels: ChannelsLike, options: ChannelRoutesOptions = {}) {
    this.channels = channels;
    this.now = options.now ?? Date.now;
  }

  private adapter(id: string): ChannelAdapter | undefined {
    return this.channels.get(id);
  }

  private projectCapabilities(c: ChannelAdapter['capabilities']): Record<string, boolean | string> {
    if (!c) return {};
    const out: Record<string, boolean | string> = {};
    for (const [k, v] of Object.entries(c)) {
      if (v === undefined) continue;
      out[k] = typeof v === 'object' && v !== null ? JSON.stringify(v) : (v as boolean | string);
    }
    return out;
  }

  /** Map a ChannelHealth to the spec §23 status enum. */
  private mapStatus(health: ChannelHealth | undefined): ChannelStatus {
    if (health?.error) return 'error';
    if (!health) return 'unconfigured';
    switch (health.status) {
      case 'ok':
        return 'connected';
      case 'degraded':
        return 'degraded';
      default:
        // 'down' | 'unknown': authenticated but receive loop down → degraded,
        // otherwise treat as unconfigured.
        return health.authenticated === true ? 'degraded' : 'unconfigured';
    }
  }

  private async buildView(adapter: ChannelAdapter): Promise<ChannelView> {
    const health = adapter.getHealth ? await adapter.getHealth().catch(() => undefined) : undefined;
    const authenticated = health?.authenticated === true;
    // M1 has no managed lifecycle: a registered adapter is mounted/enabled.
    // configured is inferred from adapter health.
    const configured = authenticated;
    return {
      id: adapter.id,
      enabled: true,
      configured,
      mounted: true,
      status: this.mapStatus(health),
      health: health ?? null,
      capabilities: this.projectCapabilities(adapter.capabilities),
      lastError: health?.error ? safeLastError(health.error) : null,
    };
  }

  /** A neutral, unmounted view for a known catalog id with no live adapter. */
  private offlineView(id: string): ChannelView {
    return {
      id,
      enabled: false,
      configured: false,
      mounted: false,
      status: 'unconfigured',
      health: null,
      capabilities: null,
      lastError: null,
    };
  }

  /** GET /channels → ChannelView[] for the fixed four-channel catalog. */
  async listChannels(): Promise<ApiResult> {
    const views = await Promise.all(
      CHANNEL_CATALOG.map((id) => {
        const adapter = this.adapter(id);
        return adapter ? this.buildView(adapter) : Promise.resolve(this.offlineView(id));
      }),
    );
    return { status: 200, body: views };
  }

  /** GET /channels/:id → ChannelView. */
  async getChannel(id: string): Promise<ApiResult> {
    const adapter = this.adapter(id);
    if (adapter) return { status: 200, body: await this.buildView(adapter) };
    // A known catalog id that is not mounted returns its offline view (200),
    // not 404; truly unknown ids still 404.
    if ((CHANNEL_CATALOG as readonly string[]).includes(id)) {
      return { status: 200, body: this.offlineView(id) };
    }
    return { status: 404, body: errorBody('CHANNEL_NOT_FOUND', 'unknown channel: ' + id) };
  }

  /** POST /channels/:id/auth/start → PublicAuthChallenge. */
  async startAuth(id: string): Promise<ApiResult> {
    const adapter = this.adapter(id);
    if (!adapter) return { status: 404, body: errorBody('CHANNEL_NOT_FOUND', 'unknown channel: ' + id) };
    if (!adapter.beginAuth) {
      return { status: 400, body: errorBody('AUTH_NOT_SUPPORTED', 'channel does not support auth') };
    }
    try {
      const full = await adapter.beginAuth();
      if (!full || typeof full.id !== 'string') {
        return { status: 500, body: errorBody('AUTH_BEGIN_FAILED', 'channel returned an invalid challenge') };
      }
      this.challenges.set(full.id, full);
      const pub: PublicAuthChallenge = {
        id: full.id,
        instruction: full.instruction,
        qrUrl: full.qrUrl,
        expiresAt: full.expiresAt,
      };
      return { status: 200, body: pub };
    } catch (error) {
      return { status: 500, body: errorBody('AUTH_BEGIN_FAILED', error instanceof Error ? error.message : String(error)) };
    }
  }

  /** Resolve a stored challenge or a structured error result. */
  private storedChallenge(id: string, challengeId: unknown): { ok: true; challenge: AuthChallenge } | { ok: false; result: ApiResult } {
    if (typeof challengeId !== 'string' || !challengeId) {
      return { ok: false, result: { status: 400, body: errorBody('INVALID_CHALLENGE', 'challengeId is required') } };
    }
    const challenge = this.challenges.get(challengeId);
    if (!challenge) {
      return { ok: false, result: { status: 404, body: errorBody('CHALLENGE_NOT_FOUND', 'unknown or expired challenge') } };
    }
    if (challenge.expiresAt !== undefined && this.now() > challenge.expiresAt) {
      this.challenges.delete(challengeId);
      return { ok: false, result: { status: 410, body: errorBody('CHALLENGE_EXPIRED', 'challenge expired') } };
    }
    return { ok: true, challenge };
  }

  /** POST /channels/:id/auth/poll → PublicAuthPoll. */
  async pollAuth(id: string, challengeId: unknown): Promise<ApiResult> {
    const adapter = this.adapter(id);
    if (!adapter) return { status: 404, body: errorBody('CHANNEL_NOT_FOUND', 'unknown channel: ' + id) };
    if (!adapter.pollAuth) return { status: 400, body: errorBody('AUTH_NOT_SUPPORTED', 'channel does not support auth polling') };
    const stored = this.storedChallenge(id, challengeId);
    if (!stored.ok) return stored.result;
    try {
      const poll = await adapter.pollAuth(stored.challenge);
      const pub: PublicAuthPoll = {
        state: poll.state,
        detail: poll.detail,
        prompt: derivePrompt(poll.state, poll.detail),
      };
      if (poll.state === 'authenticated' || poll.state === 'expired' || poll.state === 'failed') {
        this.challenges.delete(stored.challenge.id);
      }
      return { status: 200, body: pub };
    } catch (error) {
      return { status: 500, body: errorBody('AUTH_POLL_FAILED', error instanceof Error ? error.message : String(error)) };
    }
  }

  /** POST /channels/:id/auth/input → PublicAuthPoll. */
  async inputAuth(id: string, challengeId: unknown, input: AuthInput | undefined): Promise<ApiResult> {
    const adapter = this.adapter(id);
    if (!adapter) return { status: 404, body: errorBody('CHANNEL_NOT_FOUND', 'unknown channel: ' + id) };
    if (!adapter.submitAuthInput) {
      return { status: 400, body: errorBody('AUTH_NOT_SUPPORTED', 'channel does not support auth input') };
    }
    if (!input || !authInputSchema.safeParse(input).success) {
      return { status: 400, body: errorBody('INVALID_INPUT', 'input must be { kind: "verification-code", value: string }') };
    }
    const stored = this.storedChallenge(id, challengeId);
    if (!stored.ok) return stored.result;
    try {
      await adapter.submitAuthInput(stored.challenge, input);
      // Call pollAuth as a method so adapters keep their `this` binding.
      const poll = await adapter.pollAuth!(stored.challenge);
      const pub: PublicAuthPoll = {
        state: poll.state,
        detail: poll.detail,
        prompt: derivePrompt(poll.state, poll.detail),
      };
      return { status: 200, body: pub };
    } catch (error) {
      return { status: 500, body: errorBody('AUTH_INPUT_FAILED', error instanceof Error ? error.message : String(error)) };
    }
  }

  /**
   * Match a path under `/dsh-channels/api/v1` (the prefix is stripped by the
   * caller) and dispatch to the appropriate handler. Returns 404 for unknown routes.
   */
  async handle(method: string, pathname: string, body: unknown): Promise<ApiResult> {
    const clean = pathname.replace(/\/+$/, '');
    if (method === 'GET' && clean === '/channels') return this.listChannels();
    if (method === 'GET') {
      const one = /^\/channels\/([^/]+)$/.exec(clean);
      if (one) return this.getChannel(decodeURIComponent(one[1]!));
    }
    if (method === 'POST') {
      const start = /^\/channels\/([^/]+)\/auth\/start$/.exec(clean);
      if (start) return this.startAuth(decodeURIComponent(start[1]!));
      const poll = /^\/channels\/([^/]+)\/auth\/poll$/.exec(clean);
      if (poll) {
        const b = body as { challengeId?: unknown } | undefined;
        return this.pollAuth(decodeURIComponent(poll[1]!), b?.challengeId);
      }
      const input = /^\/channels\/([^/]+)\/auth\/input$/.exec(clean);
      if (input) {
        const b = (body ?? {}) as { challengeId?: unknown; input?: AuthInput } | undefined;
        return this.inputAuth(decodeURIComponent(input[1]!), b?.challengeId, b?.input);
      }
    }
    return { status: 404, body: errorBody('NOT_FOUND', 'no such endpoint') };
  }
}

/** Map an auth poll to a client face-hint string. */
function derivePrompt(state: AuthStatePoll['state'], detail?: string): PublicAuthPoll['prompt'] {
  if (state === 'pending') {
    const d = detail?.toLowerCase() ?? '';
    if (d.includes('verify') || d.includes('code')) return 'verify-code';
    if (d.includes('scan')) return d.includes('confirm') || d.includes('redirect') ? 'confirm' : 'waiting-scan';
    return d.includes('confirm') ? 'confirm' : 'waiting-scan';
  }
  return undefined;
}