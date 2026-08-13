/**
 * QQ auth state machine with optional JSON-file persistence.
 *
 * QR auth tokens are never cached long-term and never logged. The state file
 * stores only the opaque auth state + user id (no credentials).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuthChallenge, AuthStatePoll } from '@dsh/channel-core';
import type { PollAuthResult, QQAuthStatus, QQUpstream } from './upstream.js';

export interface QQAuthState {
  /** `unknown` is an internal pre-load state; the upstream never reports it. */
  status: QQAuthStatus | 'unknown';
  userId?: string;
  updatedAt: number;
}

export interface QQAuthManagerOptions {
  upstream: QQUpstream;
  /** Optional file path for persistence. */
  statePath?: string;
  /** Injectable clock (tests). */
  now?: () => number;
  onAuthChange: (state: QQAuthState) => void;
}

/** Auth statuses exposed to the channel contract. */
export const toChannelAuthState = (status: QQAuthStatus): AuthStatePoll['state'] =>
  status === 'authenticated' ? 'authenticated' : status === 'pending' ? 'pending' : status === 'expired' ? 'expired' : 'failed';

export class QQAuthManager {
  private status: QQAuthStatus | 'unknown' = 'unknown';
  private userId?: string;
  private readonly now: () => number;

  constructor(private readonly options: QQAuthManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  getState(): QQAuthState {
    return { status: this.status, userId: this.userId, updatedAt: this.now() };
  }

  get isAuthenticated(): boolean {
    return this.status === 'authenticated';
  }

  /** Begin QR auth: fetch a challenge from the upstream. */
  async beginAuth(): Promise<AuthChallenge> {
    const payload = await this.options.upstream.login();
    this.status = 'pending';
    this.emit();
    return {
      id: `qq-auth-${this.now()}`,
      instruction: 'scan the QR code with QQ to authenticate',
      qrUrl: payload.qrUrl,
      expiresAt: payload.expiresAt,
      payload: { userId: this.userId },
    };
  }

  /** Poll the upstream auth state and update this machine. */
  async pollAuth(challenge: AuthChallenge): Promise<AuthStatePoll> {
    if (challenge.expiresAt !== undefined && this.now() > challenge.expiresAt) {
      this.status = 'expired';
      this.emit();
      return { state: 'expired', detail: 'QR code expired' };
    }
    let result: PollAuthResult;
    try {
      result = await this.options.upstream.pollAuth();
    } catch (error) {
      this.status = 'failed';
      this.emit();
      return {
        state: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    this.status = result.state;
    if (result.userId) this.userId = result.userId;
    this.emit();
    return { state: toChannelAuthState(this.status), detail: result.detail };
  }

  /** Restore persisted state (best effort; missing/corrupt file is not fatal). */
  async load(): Promise<void> {
    if (!this.options.statePath) return;
    try {
      const text = await readFile(this.options.statePath, 'utf8');
      const parsed = JSON.parse(text) as Partial<QQAuthState>;
      if (parsed.status === 'authenticated') {
        this.status = 'authenticated';
        this.userId = parsed.userId;
      }
    } catch {
      // No state yet or corrupt — start unknown.
    }
  }

  /** Persist current state when a path is configured. */
  async save(): Promise<void> {
    if (!this.options.statePath) return;
    const file = this.options.statePath;
    const tmp = `${file}.${process.pid}.${this.now()}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(tmp, JSON.stringify(this.getState(), null, 2), 'utf8');
      await rename(tmp, file);
    } catch (error) {
      this.options.onAuthChange(this.getState());
      throw error;
    }
  }

  private emit(): void {
    this.options.onAuthChange(this.getState());
  }
}
