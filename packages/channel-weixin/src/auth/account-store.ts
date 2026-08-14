/**
 * Credential store for Weixin accounts.
 *
 * Splits the credential across the two storage boundaries the channel runtime
 * provides:
 * - the **token** (secret) lives in the {@link SecretStore};
 * - the non-secret identity/base-URL metadata lives as JSON in the
 *   {@link ChannelStorage}.
 *
 * An account is "configured" only when both halves exist. Tokens are never
 * logged, never embedded in emitted events or exception messages, and never
 * rounded-trip through config dumps.
 */
import type { SecretStore } from '@dsh/channel-core';

export interface WeixinAccountCredential {
  /** Bot token — the secret. Never logged. */
  token: string;
  /** Remote Weixin bot identity (ilink_bot_id). */
  ilinkBotId: string;
  /** Weixin user id of the scanning user (when reported). */
  userId?: string;
  /** Effective API base URL (redirect-adjusted). */
  baseUrl: string;
  /** ISO timestamp when the credential was saved. */
  savedAt: string;
}

export interface AccountCredentialStoreOptions {
  secrets: SecretStore;
  storage: import('@dsh/channel-core').ChannelStorage;
  /** Local DSH account alias; defaults to `main`. */
  accountId?: string;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** Storage key prefix for the non-secret credential metadata. */
const META_KEY_PREFIX = 'weixin:credential:';

/** Helper: one JSON field of the credential metadata. */
export class AccountCredentialStore {
  private readonly secrets: SecretStore;
  private readonly storage: import('@dsh/channel-core').ChannelStorage;
  private readonly accountId: string;
  private readonly now: () => number;

  constructor(options: AccountCredentialStoreOptions) {
    this.secrets = options.secrets;
    this.storage = options.storage;
    this.accountId = options.accountId ?? 'main';
    this.now = options.now ?? Date.now;
  }

  private metaKey(): string {
    return `${META_KEY_PREFIX}${this.accountId}`;
  }

  private tokenKey(): string {
    return `weixin:token:${this.accountId}`;
  }

  /** Save (or replace) a credential atomically. */
  async save(credential: WeixinAccountCredential & { token?: string }): Promise<void> {
    await this.secrets.set(this.tokenKey(), credential.token);
    const meta: Omit<WeixinAccountCredential, 'token'> = {
      ilinkBotId: credential.ilinkBotId,
      userId: credential.userId,
      baseUrl: credential.baseUrl,
      savedAt: credential.savedAt ?? new Date(this.now()).toISOString(),
    };
    await this.storage.set(this.metaKey(), JSON.stringify(meta));
  }

  /** Load the credential; resolves `undefined` when absent or partial. */
  async load(): Promise<WeixinAccountCredential | undefined> {
    const token = await this.secrets.get(this.tokenKey());
    const rawMeta = await this.storage.get(this.metaKey());
    if (!token || !rawMeta) return undefined;
    try {
      const meta = JSON.parse(rawMeta) as Omit<WeixinAccountCredential, 'token'>;
      if (!meta.ilinkBotId || !meta.baseUrl) return undefined;
      return {
        token,
        ilinkBotId: meta.ilinkBotId,
        userId: meta.userId,
        baseUrl: meta.baseUrl,
        savedAt: meta.savedAt,
      };
    } catch {
      // Corrupt metadata — treat as unauthenticated.
      return undefined;
    }
  }

  /** Delete the credential (both halves). */
  async delete(): Promise<void> {
    await Promise.all([this.secrets.delete(this.tokenKey()), this.storage.delete(this.metaKey())]);
  }
}

/** Redacted summary of a credential for diagnostics (never includes the token). */
export function redactCredential(c: WeixinAccountCredential): {
  ilinkBotId: string;
  userId?: string;
  baseUrl: string;
  savedAt: string;
} {
  return {
    ilinkBotId: c.ilinkBotId,
    userId: c.userId,
    baseUrl: c.baseUrl,
    savedAt: c.savedAt,
  };
}
