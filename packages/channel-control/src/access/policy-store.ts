/**
 * Access Policy Store — durable read/write of a channel's access policy
 * (execution plan §15).
 *
 * Policies live in the shared channel-domain KV namespace (`accessPolicyStorageKey`)
 * over the SAME `ChannelStorage` that adapters and the harness resolver use, so
 * the writer (channel-control) and the reader (channel-harness) never hard-code
 * each other's key format.
 *
 * The store keeps the raw/full distinction explicit:
 * - `get`      returns the parsed policy ONLY when it parses against the shared
 *              `channelAccessPolicySchema` (malformed/missing both resolve to
 *              `undefined`).
 * - `getRaw`   returns the raw JSON string so a resolver (harness-side) can
 *              distinguish MISSING (no raw) from INVALID (non-empty raw that
 *              fails to parse) — plan §15 "missing vs invalid".
 */
import {
  accessPolicyStorageKey,
  channelAccessPolicySchema,
  type ChannelAccessPolicy,
  type ChannelStorage,
} from '@wsz987/channel-core';

/** Durable access-policy store abstraction used by the control plane. */
export interface ChannelAccessPolicyStore {
  get(channelId: string, accountId: string): Promise<ChannelAccessPolicy | undefined>;
  set(channelId: string, accountId: string, policy: ChannelAccessPolicy): Promise<void>;
  delete(channelId: string, accountId: string): Promise<void>;
}

function parseStoredPolicy(raw: string): ChannelAccessPolicy | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const parsed = channelAccessPolicySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * [ChannelStorageAccessPolicyStore] — a [ChannelAccessPolicyStore] backed by a
 * [ChannelStorage]. Values are written as JSON strings under the shared
 * versioned key. This store deliberately does NOT decide "invalid vs missing" —
 * that policy lives in the harness-side resolver; here `get` simply returns the
 * parsed policy when valid and `undefined` otherwise, and `getRaw` exposes the
 * raw string so a caller can tell them apart.
 */
export class ChannelStorageAccessPolicyStore implements ChannelAccessPolicyStore {
  private readonly getStorage: () => ChannelStorage;

  constructor(getStorage: () => ChannelStorage) {
    this.getStorage = getStorage;
  }

  private key(channelId: string, accountId: string): string {
    return accessPolicyStorageKey(channelId, accountId);
  }

  async get(channelId: string, accountId: string): Promise<ChannelAccessPolicy | undefined> {
    const raw = await this.getStorage().get(this.key(channelId, accountId));
    if (raw === undefined) return undefined;
    return parseStoredPolicy(raw);
  }

  /** The raw JSON string under the policy key, or undefined when absent. */
  async getRaw(channelId: string, accountId: string): Promise<string | undefined> {
    return this.getStorage().get(this.key(channelId, accountId));
  }

  async set(channelId: string, accountId: string, policy: ChannelAccessPolicy): Promise<void> {
    await this.getStorage().set(this.key(channelId, accountId), JSON.stringify(policy));
  }

  async delete(channelId: string, accountId: string): Promise<void> {
    await this.getStorage().delete(this.key(channelId, accountId));
  }
}

/**
 * In-memory access-policy store (tests / transient default). Keeps raw JSON
 * strings so `getRaw` can still distinguish missing vs invalid when a caller
 * needs that precision; state is lost on restart.
 */
export class MemoryAccessPolicyStore implements ChannelAccessPolicyStore {
  private readonly values = new Map<string, string>();

  private key(channelId: string, accountId: string): string {
    return accessPolicyStorageKey(channelId, accountId);
  }

  async get(channelId: string, accountId: string): Promise<ChannelAccessPolicy | undefined> {
    const raw = this.values.get(this.key(channelId, accountId));
    if (raw === undefined) return undefined;
    return parseStoredPolicy(raw);
  }

  async getRaw(channelId: string, accountId: string): Promise<string | undefined> {
    return this.values.get(this.key(channelId, accountId));
  }

  async set(channelId: string, accountId: string, policy: ChannelAccessPolicy): Promise<void> {
    this.values.set(this.key(channelId, accountId), JSON.stringify(policy));
  }

  async delete(channelId: string, accountId: string): Promise<void> {
    this.values.delete(this.key(channelId, accountId));
  }
}
