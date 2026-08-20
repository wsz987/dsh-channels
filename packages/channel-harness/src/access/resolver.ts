/**
 * Harness-side Access Policy Resolver (execution plan §17, §15).
 *
 * Failure-closed resolution over the shared ChannelStorage. The Harness DOES
 * NOT depend on channel-control: it reads the shared versioned policy KV via
 * `accessPolicyStorageKey` and validates it with
 * the shared `channelAccessPolicySchema` (both live in @wsz987/channel-core).
 *
 * Reading rules (§15):
 *   - missing JSON     -> `missing`
 *   - malformed JSON   -> `invalid`
 *   - unknown version / schema failure -> `invalid`
 *
 * There is no policy caching: every inbound reads once, so Web
 * saves and permission revocations take effect immediately with no invalidation
 * machinery and no stale-ACL window.
 */
import type { ChannelAccessPolicy, ChannelStorage } from '@wsz987/channel-core';
import { accessPolicyStorageKey, channelAccessPolicySchema } from '@wsz987/channel-core';

export type ResolvedAccessPolicy =
  | { state: 'present'; policy: ChannelAccessPolicy }
  | { state: 'missing' }
  | { state: 'invalid'; error: string };

export interface ChannelAccessPolicyResolver {
  resolve(channelId: string, accountId: string): Promise<ResolvedAccessPolicy>;
}

/**
 * Default resolver backed by the shared ChannelStorage (production wiring is
 * `ctx.channels.resources.storage`). Lazily resolves storage via a getter so it
 * stays decoupled from the Cordis context / ChannelService lifecycle.
 */
export class StoredChannelAccessPolicyResolver implements ChannelAccessPolicyResolver {
  constructor(private readonly getStorage: () => ChannelStorage) {}

  async resolve(channelId: string, accountId: string): Promise<ResolvedAccessPolicy> {
    const storage = this.getStorage();
    const raw = await storage.get(accessPolicyStorageKey(channelId, accountId));
    if (raw === undefined) return { state: 'missing' };

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { state: 'invalid', error: 'malformed policy JSON' };
    }

    const result = channelAccessPolicySchema.safeParse(parsed);
    if (!result.success) {
      return { state: 'invalid', error: `policy schema validation failed: ${result.error.message}` };
    }
    return { state: 'present', policy: result.data };
  }
}
