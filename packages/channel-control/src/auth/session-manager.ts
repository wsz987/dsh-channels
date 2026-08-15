/**
 * [AuthSessionManager] — host-side lifecycle for interactive authorization
 * (doc §19–§20, §53 Task 7).
 *
 * Responsibilities:
 * - one active session per (channelId, accountId, method); a new session for
 *   the same key cancels (aborts + deletes) the previous pending one
 * - browser-safe session ids are [crypto.randomUUID()], never derived from
 *   channelId/timestamp/deviceCode
 * - host-side POLL THROTTLE: the provider is only hit when
 *   now >= nextPollAt; between intervals the last known status is returned
 *   without touching the provider (the browser may poll every second)
 * - terminal states (authenticated/expired/failed) short-circuit provider
 *   polls and return the cached status
 * - TTL expiry sweeps + a lightweight injectable clock for tests
 * - every public result is passed through the sanitizer
 */
import { randomUUID } from 'node:crypto';
import { ChannelDefinitionRegistry } from '../definitions/registry.js';
import { ControlError } from '../errors.js';
import type {
  AuthBeginInput,
  AuthInput,
  AuthMethod,
  AuthProviderSession,
  AuthState,
  PublicAuthSession,
  PublicAuthStatus,
} from '../types.js';
import {
  toPublicSession,
  toPublicStatus,
  type SessionSnapshot,
} from './sanitizer.js';

/** Interactive QR/device authorization is deliberately short-lived. */
export const MAX_AUTH_SESSION_TTL_MS = 3 * 60 * 1000;

export interface AuthSessionManagerOptions {
  registry: ChannelDefinitionRegistry;
  /** Injectable clock (ms since epoch) for tests. Defaults to Date.now. */
  now?: () => number;
}

const TERMINAL_STATES: readonly AuthState[] = ['authenticated', 'expired', 'failed'];

export class AuthSessionManager {
  private readonly sessions = new Map<string, SessionSnapshot>();
  /** Tombstones for cancelled session ids so a later poll/submit rejects clearly. */
  private readonly cancelled = new Set<string>();
  private readonly registry: ChannelDefinitionRegistry;
  private readonly now: () => number;

  constructor(options: AuthSessionManagerOptions) {
    this.registry = options.registry;
    this.now = options.now ?? (() => Date.now());
  }

  // --- create ---------------------------------------------------------------

  async create(
    channelId: string,
    input: AuthBeginInput,
  ): Promise<PublicAuthSession> {
    const definition = this.registry.require(channelId);
    if (!definition.beginAuth) {
      throw new ControlError(
        'AUTH_NOT_SUPPORTED',
        `channel '${channelId}' does not support interactive authorization`,
      );
    }

    const key = this.key(channelId, input);
    // One active session per key: cancel any existing pending session first.
    const existing = this.findByKey(key);
    if (existing) {
      await this.cancelById(existing.id);
    }

    const providerSession = await definition.beginAuth(input);
    const snapshot = this.buildSnapshot(
      channelId,
      input.accountId ?? '',
      key,
      providerSession,
    );
    this.sessions.set(snapshot.id, snapshot);
    return toPublicSession(snapshot);
  }

  // --- poll -----------------------------------------------------------------

  async poll(sessionId: string): Promise<PublicAuthStatus> {
    if (this.cancelled.has(sessionId)) {
      throw new ControlError('AUTH_SESSION_CANCELLED');
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new ControlError('AUTH_SESSION_NOT_FOUND');
    }

    // Terminal states: return the cached status without ever hitting provider.
    if (TERMINAL_STATES.includes(session.state)) {
      return toPublicStatus({
        state: session.state,
        phase: session.phase,
        expiresAt: session.expiresAt,
      });
    }

    // Expired by TTL: mark + delete, report 'expired'.
    if (this.now() >= session.expiresAt) {
      this.expire(session);
      return toPublicStatus({ state: 'expired', phase: 'expired' });
    }

    // Poll throttle: within the provider interval, return the last known status.
    if (this.now() < session.nextPollAt) {
      return this.lastKnownStatus(session);
    }

    return this.pollProvider(session);
  }

  // --- submit -----------------------------------------------------------------

  async submit(sessionId: string, input: AuthInput): Promise<PublicAuthStatus> {
    if (this.cancelled.has(sessionId)) {
      throw new ControlError('AUTH_SESSION_CANCELLED');
    }
    const session = this.sessions.get(sessionId);
    if (!session) throw new ControlError('AUTH_SESSION_NOT_FOUND');

    const definition = this.registry.require(session.channelId);
    if (!definition.submitAuthInput) {
      throw new ControlError('AUTH_NOT_SUPPORTED');
    }
    await definition.submitAuthInput(session.providerSession, input);
    // Force a fresh provider poll to reflect the submitted input.
    return this.pollProvider(session);
  }

  // --- cancel ----------------------------------------------------------------

  async cancel(sessionId: string): Promise<void> {
    if (this.cancelled.has(sessionId)) return;
    const session = this.sessions.get(sessionId);
    if (!session) {
      // Idempotent: unknown ids are treated as already gone.
      return;
    }
    await this.cancelById(session.id);
  }

  // --- expiry / cleanup --------------------------------------------------------

  /** Abort + delete every session past its TTL; returns how many expired. */
  expireAll(): number {
    let count = 0;
    for (const session of [...this.sessions.values()]) {
      if (this.now() >= session.expiresAt) {
        this.expire(session);
        count += 1;
      }
    }
    return count;
  }

  /** Sweep expired sessions and prune cancelled tombstones. */
  cleanup(): number {
    return this.expireAll();
  }

  /** Internal list of live session ids (test/diagnostics). */
  listIds(): string[] {
    return [...this.sessions.keys()];
  }

  get size(): number {
    return this.sessions.size;
  }

  // --- internals ----------------------------------------------------------------

  private key(channelId: string, input: AuthBeginInput): string {
    return `${channelId}:${input.accountId ?? ''}:${input.method}`;
  }

  private findByKey(key: string): SessionSnapshot | undefined {
    for (const session of this.sessions.values()) {
      if (this.accountKey(session) === key) return session;
    }
    return undefined;
  }

  private accountKey(session: SessionSnapshot): string {
    return `${session.channelId}:${session.accountId}:${session.method}`;
  }

  private buildSnapshot(
    channelId: string,
    accountId: string,
    key: string,
    providerSession: AuthProviderSession,
  ): SessionSnapshot {
    const now = this.now();
    const expiresAt = Math.min(
      providerSession.expiresAt ?? now + MAX_AUTH_SESSION_TTL_MS,
      now + MAX_AUTH_SESSION_TTL_MS,
    );
    const scopedQr = providerSession.qr
      ? { ...providerSession.qr, expiresAt: Math.min(providerSession.qr.expiresAt ?? expiresAt, expiresAt) }
      : undefined;
    const scopedProviderSession: AuthProviderSession = {
      ...providerSession,
      expiresAt,
      qr: scopedQr,
    };
    const interval = scopedProviderSession.pollingIntervalMs;
    const initialPhase =
      scopedProviderSession.qr || scopedProviderSession.prompt?.kind === 'open-browser'
        ? ('waiting-scan' as const)
        : ('preparing' as const);
    const snapshot: SessionSnapshot = {
      id: randomUUID(),
      channelId,
      accountId,
      method: (key.split(':')[2] as AuthMethod) ?? 'qr',
      provider: scopedProviderSession.provider,
      createdAt: now,
      expiresAt,
      pollingIntervalMs: interval,
      nextPollAt: now + interval,
      deviceCode: scopedProviderSession.deviceCode,
      abortController: new AbortController(),
      providerState: scopedProviderSession.providerState,
      qr: scopedProviderSession.qr,
      prompt: scopedProviderSession.prompt,
      state: 'pending',
      phase: initialPhase,
      providerSession: scopedProviderSession,
    };
    return snapshot;
  }

  /** Call the definition's pollAuth, update stored status, return sanitized. */
  private async pollProvider(session: SessionSnapshot): Promise<PublicAuthStatus> {
    const definition = this.registry.require(session.channelId);
    if (!definition.pollAuth) {
      throw new ControlError(
        'AUTH_NOT_SUPPORTED',
        `channel '${session.channelId}' has no pollAuth to drive authorize flow`,
      );
    }
    const status = await definition.pollAuth(session.providerSession);
    session.nextPollAt = this.now() + session.pollingIntervalMs;
    session.state = status.state;
    session.phase = status.phase;
    if (status.prompt) session.prompt = status.prompt;
    return toPublicStatus({ ...status, expiresAt: session.expiresAt });
  }

  private lastKnownStatus(session: SessionSnapshot): PublicAuthStatus {
    return toPublicStatus({
      state: session.state,
      phase: session.phase,
      expiresAt: session.expiresAt,
      prompt: session.prompt,
    });
  }

  private async cancelById(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.cancelled.add(sessionId);
      return;
    }
    session.abortController.abort();
    this.sessions.delete(sessionId);
    this.cancelled.add(sessionId);
  }

  private expire(session: SessionSnapshot): void {
    session.abortController.abort();
    session.state = 'expired';
    session.phase = 'expired';
    this.sessions.delete(session.id);
  }
}
