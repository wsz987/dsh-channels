/**
 * OwnerClaimSessionManager — in-memory owner-claim lifecycle (execution plan
 * §21, §22, §24, §25).
 *
 * When a channel declares `ownerDiscovery='claim'`, the local operator claims
 * owner identity by beginning a session, showing the short `challengeCode`,
 * then sending `/dsh-claim <challengeCode>` to the bot in a DM. The manager:
 * - begins a session (challenge >= 128-bit, 5 minute TTL, one active per
 *   channel/account),
 * - observes inbound `message.received` events to capture a single valid
 *   candidate from a DM,
 * - confirms a candidate by persisting/rebinding the access policy owner.
 *
 * Security rules (plan §21):
 *   1. Only local Web/API may begin.
 *   2. 16 random bytes / >=128-bit challenge, hex-encoded (>=32 chars).
 *   3. 5 minute TTL.
 *   4. Single-use: one challenge maps to at most one session, and only the
 *      first valid candidate is captured.
 *   5. Concurrent claims: one active claim per channel/account at a time —
 *      a second begin() rejects (fail-closed) rather than silently replacing.
 *   6. Only DM conversations are accepted; group claims are silently ignored.
 *   7. A valid canonical sender.id (non-empty, !== 'unknown') is required.
 *   8. Exact challenge-code match.
 *   9. Candidate does not automatically become owner — local confirm does.
 *  10. Local confirm writes the owner.
 *  11. The claim message is consumed here and never reaches Agent/Session/
 *      Binding (the harness reserved gate also ensures this).
 *  12. Owner changes write an audit log line.
 *
 * The challenge code is in-memory only, never persisted and NEVER logged.
 */
import type { ChannelEvent, ChannelAccessPolicy } from '@wsz987/channel-core';
import { collectText, isReservedClaimCommand, parseOwnerClaimCommand } from '@wsz987/channel-core';
import { randomBytes } from 'node:crypto';
import { ChannelDefinitionRegistry } from '../definitions/registry.js';
import { ControlError } from '../errors.js';
import type { OwnerClaimPhase, PublicOwnerClaimSession } from '../types.js';
import type { ChannelAccessPolicyStore } from './policy-store.js';
import { ownerOnlyPolicy } from './materialize.js';

export const OWNER_CLAIM_TTL_MS = 5 * 60_000;
export const OWNER_CLAIM_CHALLENGE_BYTES = 16;

/** A minimal logger-like surface (the Control logger implements this). */
export interface OwnerClaimLogger {
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
}

export interface OwnerClaimSessionManagerOptions {
  registry: ChannelDefinitionRegistry;
  store: ChannelAccessPolicyStore;
  logger: OwnerClaimLogger;
  /** Injectable clock (ms since epoch). Defaults to Date.now. */
  now?: () => number;
}

interface InternalOwnerClaimSession extends PublicOwnerClaimSession {
  /** The exact challenge the operator must send back. NEVER logged. */
  challenge: string;
  createdAt: number;
}

export class OwnerClaimSessionManager {
  private readonly registry: ChannelDefinitionRegistry;
  private readonly store: ChannelAccessPolicyStore;
  private readonly logger: OwnerClaimLogger;
  private readonly now: () => number;

  /** Active sessions keyed by `${channelId}:${accountId}`. */
  private readonly sessions = new Map<string, InternalOwnerClaimSession>();

  constructor(options: OwnerClaimSessionManagerOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  /** The (single) active claim key for a channel/account. */
  private key(channelId: string, accountId: string): string {
    return `${channelId}:${accountId}`;
  }

  private publicView(session: InternalOwnerClaimSession): PublicOwnerClaimSession {
    // Strip the internal challenge before it can cross the API boundary. The
    // public DTO carries the SAME code (the browser shows it to the operator);
    // only for already-consumed/invalid phases we hide it.
    const challengeCode =
      session.phase === 'waiting-message' || session.phase === 'candidate'
        ? session.challenge
        : undefined;
    return {
      id: session.id,
      channelId: session.channelId,
      accountId: session.accountId,
      phase: session.phase,
      ...(challengeCode !== undefined ? { challengeCode } : {}),
      expiresAt: session.expiresAt,
      ...(session.candidate ? { candidate: session.candidate } : {}),
    };
  }

  /**
   * Begin a NEW owner-claim session for a channel/account (local Web/API only).
   * Rejects CLAIM_NOT_SUPPORTED when the channel does not declare
   * `ownerDiscovery='claim'`, and CLAIM_INVALID when a claim is already active
   * for the same channel/account (fail-closed; the holder must cancel or let
   * it expire first rather than silently invalidating a prior in-flight claim).
   */
  begin(channelId: string, accountId = 'main'): PublicOwnerClaimSession {
    const definition = this.registry.get(channelId);
    if (!definition) {
      throw new ControlError(
        'CLAIM_NOT_SUPPORTED',
        `channel '${channelId}' is not registered`,
      );
    }
    if (definition.access.ownerDiscovery !== 'claim') {
      throw new ControlError(
        'CLAIM_NOT_SUPPORTED',
        `channel '${channelId}' does not use owner claim discovery`,
      );
    }
    const key = this.key(channelId, accountId);
    const existing = this.sessions.get(key);
    if (existing && existing.phase !== 'expired' && existing.phase !== 'cancelled') {
      throw new ControlError(
        'CLAIM_INVALID',
        `an owner claim is already active for '${channelId}:${accountId}'`,
      );
    }

    const challenge = randomBytes(OWNER_CLAIM_CHALLENGE_BYTES).toString('hex');
    const now = this.now();
    const session: InternalOwnerClaimSession = {
      id: cryptoRandomId(),
      channelId,
      accountId,
      phase: 'waiting-message',
      challenge,
      expiresAt: now + OWNER_CLAIM_TTL_MS,
      createdAt: now,
    };
    this.sessions.set(key, session);
    return this.publicView(session);
  }

  /** Read a session; marks + reports expiry (CLAIM_EXPIRED) when past TTL. */
  get(channelId: string, claimId: string): PublicOwnerClaimSession {
    const session = this.findSession(channelId, claimId);
    if (this.isExpired(session)) {
      session.phase = 'expired';
      throw new ControlError('CLAIM_EXPIRED', `owner claim '${claimId}' has expired`);
    }
    return this.publicView(session);
  }

  /** Mark a session cancelled (idempotent). */
  cancel(channelId: string, claimId: string): void {
    const session = this.findSession(channelId, claimId);
    if (session.phase === 'confirmed') {
      // Confirmed claims are terminal facts; report as invalid rather than
      // pretending to un-confirm.
      throw new ControlError('CLAIM_INVALID', 'a confirmed owner claim cannot be cancelled');
    }
    session.phase = 'cancelled';
  }

  /**
   * Observe an inbound channel event. NO-OP for everything except
   * `message.received`. Consumes a `/dsh-claim` command and, when every check
   * passes, captures the FIRST valid candidate. NEVER throws — errors are
   * caught and logged as warnings (plan §22). Challenge codes are never logged.
   */
  observe(event: ChannelEvent): void {
    if (event.type !== 'message.received') return;
    try {
      const text = collectText(event.message.content);
      if (!isReservedClaimCommand(text)) return;
      const parsed = parseOwnerClaimCommand(text);
      if (!parsed?.code) return;

      // Look up an ACTIVE claim for this channel/account.
      const key = this.key(event.channel, event.accountId);
      const session = this.sessions.get(key);
      if (!session) return; // no active local claim — silently ignore.

      // The observation must not reveal a consumed/finished claim's code.
      if (this.isExpired(session)) {
        session.phase = 'expired';
        return;
      }
      if (session.phase !== 'waiting-message') return; // already has candidate / done.

      // Only DM conversations may claim; group claims are silently rejected.
      if (event.conversation.type !== 'dm') return;

      // Require a valid canonical sender.id.
      const senderId =
        typeof event.sender.id === 'string' ? event.sender.id.trim() : '';
      if (!senderId || senderId === 'unknown') return;

      // Exact challenge match — no partial/fuzzy reveal of the code.
      if (parsed.code !== session.challenge) return;

      // First valid candidate captured; subsequent candidates ignored.
      session.candidate = { senderId };
      session.phase = 'candidate';
    } catch (error) {
      this.logger.warn('[channel-control] owner claim observe failed', error);
    }
  }

  /**
   * Confirm a candidate, persisting/rebinding the owner (plan §25), then mark
   * the session confirmed. Requires phase === 'candidate' (a claim without a
   * valid sender cannot be confirmed). Returns the public session.
   */
  async confirm(channelId: string, claimId: string): Promise<PublicOwnerClaimSession> {
    const session = this.findSession(channelId, claimId);
    if (this.isExpired(session)) {
      session.phase = 'expired';
      throw new ControlError('CLAIM_EXPIRED', `owner claim '${claimId}' has expired`);
    }
    if (session.phase !== 'candidate' || !session.candidate) {
      throw new ControlError(
        'CLAIM_INVALID',
        `owner claim '${claimId}' has no candidate to confirm`,
      );
    }
    const ownerId = session.candidate.senderId;

    await this.rebindOwner(channelId, session.accountId, ownerId);

    session.phase = 'confirmed';
    this.logger.info(
      `[channel-control] owner claimed for '${channelId}:${session.accountId}' (claim ${claimId})`,
    );
    return this.publicView(session);
  }

  /** Persist/rebind the owner per plan §25. */
  private async rebindOwner(
    channelId: string,
    accountId: string,
    ownerId: string,
  ): Promise<void> {
    const current = await this.store.get(channelId, accountId);
    let next: ChannelAccessPolicy;
    if (!current) {
      // No policy: materialize a fresh owner-only.
      next = ownerOnlyPolicy(ownerId);
    } else if (current.preset === 'owner-only') {
      // Owner-only: re-materialize allowFrom=[newOwner], group disabled.
      next = {
        ...current,
        ownerId,
        allowFrom: [ownerId],
        groupPolicy: 'disabled',
        groups: {},
      };
    } else {
      // allowlist/custom: only the ownerId changes; allowFrom/groups preserved.
      next = { ...current, ownerId };
    }
    await this.store.set(channelId, accountId, { ...next, version: 1 });
  }

  private findSession(channelId: string, claimId: string): InternalOwnerClaimSession {
    // A claim id is globally unique; locate it among this channel's sessions
    // regardless of account.
    for (const session of this.sessions.values()) {
      if (session.channelId === channelId && session.id === claimId) {
        return session;
      }
    }
    throw new ControlError(
      'CLAIM_NOT_FOUND',
      `owner claim '${claimId}' not found for channel '${channelId}'`,
    );
  }

  private isExpired(session: InternalOwnerClaimSession): boolean {
    return session.phase !== 'confirmed' && session.phase !== 'cancelled' && this.now() > session.expiresAt;
  }
}

/** A short, URL-safe, unguessable claim id (not the challenge). */
function cryptoRandomId(): string {
  return randomBytes(12).toString('hex');
}
