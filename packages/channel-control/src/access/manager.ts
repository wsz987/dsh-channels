/**
 * ChannelAccessManager — the control-plane owner of a channel's access state
 * (execution plan §4.3, §24, §27).
 *
 * Responsibilities:
 * - read a channel's declared access descriptor from its definition.
 * - compute access readiness from the stored policy + descriptor + owner
 *   discovery, including safe owner bootstrap for `ownerDiscovery='account'`
 *   channels (plan §24: missing policy + resolvable account owner -> materialize
 *   and persist owner-only, then report ready).
 * - validate + persist a policy via `saveAccess`.
 *
 * No secret ever passes through here: only canonical sender/group IDs.
 */
import type {
  ChannelLogger,
  ChannelAccessPolicy,
} from '@wsz987/channel-core';
import { ChannelDefinitionRegistry } from '../definitions/registry.js';
import { ControlError } from '../errors.js';
import type {
  ChannelAccessDescriptor,
  ChannelAccessReadiness,
  ChannelAccessState,
} from '../types.js';
import type { ChannelAccessPolicyStore } from './policy-store.js';
import { ownerOnlyPolicy, platformPrivatePolicy } from './materialize.js';
import { validateAccessPolicy } from './validation.js';

/** A store that can also expose the raw stored string (for missing-vs-invalid). */
export type ReadableChannelAccessPolicyStore = ChannelAccessPolicyStore & {
  getRaw?(channelId: string, accountId: string): Promise<string | undefined>;
};

export interface ChannelAccessManagerOptions {
  registry: ChannelDefinitionRegistry;
  store: ReadableChannelAccessPolicyStore;
  /**
   * Resolve the account owner's canonical sender.id for a channel. For
   * `ownerDiscovery='account'` channels this drives owner bootstrap; it is a
   * no-op (returns undefined) for channels that do not implement it.
   */
  resolveOwnerIdentity(channelId: string, accountId: string): Promise<string | undefined>;
  logger?: Pick<ChannelLogger, 'info' | 'warn'>;
}

export class ChannelAccessManager {
  private readonly registry: ChannelDefinitionRegistry;
  private readonly store: ReadableChannelAccessPolicyStore;
  private readonly resolveOwnerIdentity: ChannelAccessManagerOptions['resolveOwnerIdentity'];
  private readonly logger: Pick<ChannelLogger, 'info' | 'warn'>;

  constructor(options: ChannelAccessManagerOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.resolveOwnerIdentity = options.resolveOwnerIdentity;
    this.logger = options.logger ?? { info: () => {}, warn: () => {} };
  }

  /** Compute the access state for one channel+account (plan §24, §27). */
  async getState(channelId: string, accountId = 'main'): Promise<ChannelAccessState> {
    const definition = this.registry.require(channelId);
    const descriptor = definition.access;

    const stored = await this.store.get(channelId, accountId);
    if (stored) {
      // A valid policy present -> ready.
      return this.buildState(descriptor, 'ready', stored);
    }

    // `get` returned undefined: distinguish an actually-missing policy from a
    // stored-but-invalid one (non-empty raw that fails to parse).
    const raw = await this.store.getRaw?.(channelId, accountId);
    if (raw !== undefined) {
      // Stored raw exists but fails the schema -> invalid-policy (fail closed).
      return this.buildState(descriptor, 'invalid-policy', undefined);
    }

    // No policy at all.
    // ownerDiscovery='account' -> safe owner bootstrap (plan §24).
    if (descriptor.ownerDiscovery === 'account') {
      const ownerId = await this.resolveOwnerIdentity(channelId, accountId);
      if (ownerId) {
        const policy = ownerOnlyPolicy(ownerId);
        await this.store.set(channelId, accountId, policy);
        this.logger.info(`[channel-control] access policy bootstrapped (channel=${channelId}, account=${accountId}, operation=owner-bootstrap, preset=owner-only, readiness=ready)`);
        return this.buildState(descriptor, 'ready', policy, {
          configured: true,
          id: ownerId,
          source: 'account',
        });
      }
      // Account channel but no owner resolvable yet (e.g. no credential).
      return this.buildState(descriptor, 'missing-policy', undefined);
    }

    // Platform-private channels guarantee that C2C messages can only originate
    // from the bot creator. Materialize that narrow grant, never opening groups.
    if (descriptor.ownerDiscovery === 'platform') {
      const policy = platformPrivatePolicy();
      await this.store.set(channelId, accountId, policy);
      this.logger.info(`[channel-control] access policy bootstrapped (channel=${channelId}, account=${accountId}, operation=platform-bootstrap, preset=custom, readiness=ready)`);
      return this.buildState(descriptor, 'ready', policy);
    }

    // Non-account owner discovery with no policy.
    if (descriptor.ownerDiscovery === 'claim') {
      return this.buildState(descriptor, 'needs-owner', undefined);
    }
    return this.buildState(descriptor, 'missing-policy', undefined);
  }

  /** Validate + persist a policy, then return the resulting access state. */
  async saveAccess(
    channelId: string,
    policy: ChannelAccessPolicy,
    accountId = 'main',
  ): Promise<ChannelAccessState> {
    const definition = this.registry.require(channelId);
    const result = validateAccessPolicy(policy, definition.access);
    if (!result.ok) {
      this.logger.warn(`[channel-control] access policy rejected (channel=${channelId}, account=${accountId}, operation=save, reason=validation)`);
      throw new ControlError('INVALID_ACCESS_POLICY', result.error);
    }
    await this.store.set(channelId, accountId, result.policy);
    const state = await this.getState(channelId, accountId);
    this.logger.info(`[channel-control] access policy saved (channel=${channelId}, account=${accountId}, operation=save, preset=${result.policy.preset}, dmPolicy=${result.policy.dmPolicy}, groupPolicy=${result.policy.groupPolicy}, readiness=${state.readiness})`);
    return state;
  }

  private buildState(
    descriptor: ChannelAccessDescriptor,
    readiness: ChannelAccessReadiness,
    policy: ChannelAccessPolicy | undefined,
    ownerOverride?: ChannelAccessState['owner'],
  ): ChannelAccessState {
    return {
      descriptor,
      readiness,
      policy,
      owner: ownerOverride ?? this.deriveOwner(policy, descriptor),
    };
  }

  /** Simple owner-source heuristic (plan §27). No secrets involved. */
  private deriveOwner(
    policy: ChannelAccessPolicy | undefined,
    descriptor: ChannelAccessDescriptor,
  ): ChannelAccessState['owner'] {
    if (policy?.ownerId) {
      const source =
        descriptor.ownerDiscovery === 'account'
          ? 'account'
          : descriptor.ownerDiscovery === 'claim'
            ? 'claim'
            : 'manual';
      return { configured: true, id: policy.ownerId, source };
    }
    return { configured: false };
  }
}
