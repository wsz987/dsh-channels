/**
 * ChannelControlService access surface tests (plan §24, §27, §29, §31):
 * getAccess readiness, owner 'account' bootstrap, saveAccess persist/re-read,
 * and malformed policy rejection.
 */
import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, textParts } from '@wsz987/channel-core';
import type { ChannelAccessPolicy } from '@wsz987/channel-core';
import { ChannelControlService } from '../../src/service.js';
import { ChannelDefinitionRegistry } from '../../src/definitions/registry.js';
import type { CredentialSeam } from '../../src/credentials/manager.js';
import { MemoryAccessPolicyStore } from '../../src/access/policy-store.js';
import type { ChannelAccessDescriptor, ChannelDefinition } from '../../src/types.js';

const seam: CredentialSeam = {
  async resolve() {
    return undefined;
  },
  async describe() {
    return { configured: false, writable: true };
  },
  async set() {},
  async unset() {},
};

function makeDef(
  id: string,
  access: ChannelAccessDescriptor,
  overrides: Partial<ChannelDefinition> = {},
): ChannelDefinition {
  return {
    id,
    enabled: true,
    access,
    setup: { fields: [], authMethods: [] },
    getConfiguredState: async () => ({ configured: true, fields: {} }),
    saveConfig: async () => {},
    createAdapter: async () => {
      throw new Error('not used');
    },
    ...overrides,
  } as ChannelDefinition;
}

function harness(defs: ChannelDefinition[]) {
  const ctx = new Context();
  new ChannelService(ctx);
  const registry = new ChannelDefinitionRegistry();
  for (const def of defs) registry.register(def);
  const service = new ChannelControlService(ctx, { credentials: seam, registry });
  return { ctx, service, registry };
}

const claimDescriptor: ChannelAccessDescriptor = {
  directMessages: true,
  groups: true,
  mentions: false,
  ownerDiscovery: 'claim',
  identityLabels: { user: 'QQ User OpenID', group: 'QQ Group OpenID' },
};

const accountDescriptor: ChannelAccessDescriptor = {
  directMessages: true,
  groups: false,
  mentions: false,
  ownerDiscovery: 'account',
  identityLabels: { user: 'Weixin User ID' },
};

const platformPrivateDescriptor: ChannelAccessDescriptor = {
  directMessages: true,
  groups: true,
  mentions: false,
  ownerDiscovery: 'platform',
  identityLabels: { user: 'QQ User OpenID', group: 'QQ Group OpenID' },
};

describe('ChannelControlService.getAccess', () => {
  it('returns needs-owner for a claim channel with no policy', async () => {
    const { service } = harness([makeDef('qq', claimDescriptor)]);
    const state = await service.getAccess('qq');
    expect(state.readiness).toBe('needs-owner');
    expect(state.policy).toBeUndefined();
    expect(state.owner.configured).toBe(false);
  });

  it('bootstrap materializes owner-only for an account channel with a resolvable owner', async () => {
    const { service } = harness([
      makeDef('weixin', accountDescriptor, {
        resolveOwnerIdentity: async () => 'wx-scan-user-123',
      }),
    ]);
    const state = await service.getAccess('weixin');
    expect(state.readiness).toBe('ready');
    expect(state.owner).toEqual({ configured: true, id: 'wx-scan-user-123', source: 'account' });
    // The bootstrap persisted a canonical owner-only policy.
    expect(state.policy).toMatchObject({
      preset: 'owner-only',
      ownerId: 'wx-scan-user-123',
      dmPolicy: 'allowlist',
      allowFrom: ['wx-scan-user-123'],
      groupPolicy: 'disabled',
    });
    // Re-reading now sees the persisted policy (already ready).
    const again = await service.getAccess('weixin');
    expect(again.readiness).toBe('ready');
  });

  it('account channel with no resolvable owner reports missing-policy', async () => {
    const { service } = harness([
      makeDef('weixin', accountDescriptor, { resolveOwnerIdentity: async () => undefined }),
    ]);
    const state = await service.getAccess('weixin');
    expect(state.readiness).toBe('missing-policy');
  });

  it('bootstraps platform-private DM access without opening groups or requiring a claim', async () => {
    const { service } = harness([makeDef('qq', platformPrivateDescriptor)]);
    const state = await service.getAccess('qq');

    expect(state.readiness).toBe('ready');
    expect(state.owner.configured).toBe(false);
    expect(state.policy).toMatchObject({
      preset: 'custom',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      groups: {},
    });
    expect(() => service.beginOwnerClaim('qq')).toThrowError(
      expect.objectContaining({ code: 'CLAIM_NOT_SUPPORTED' }),
    );
  });
});

describe('ChannelControlService.saveAccess', () => {
  it('persists a valid policy and re-reads it as ready', async () => {
    const store = new MemoryAccessPolicyStore();
    const ctx = new Context();
    new ChannelService(ctx);
    const registry = new ChannelDefinitionRegistry();
    registry.register(makeDef('telegram', claimDescriptor));
    const service = new ChannelControlService(ctx, {
      credentials: seam,
      registry,
      accessStore: store,
    });

    const policy: ChannelAccessPolicy = {
      version: 1,
      preset: 'allowlist',
      ownerId: 'my-id',
      dmPolicy: 'allowlist',
      allowFrom: ['my-id'],
      groupPolicy: 'disabled',
      groups: {},
    };
    const saved = await service.saveAccess('telegram', policy);
    expect(saved.readiness).toBe('ready');

    const reread = await service.getAccess('telegram');
    expect(reread.readiness).toBe('ready');
    expect(reread.policy).toEqual(policy);
    expect(reread.owner).toEqual({ configured: true, id: 'my-id', source: 'claim' });
    // The underlying store holds the persisted policy.
    expect(await store.get('telegram', 'main')).toEqual(policy);
  });

  it('rejects a malformed policy with INVALID_ACCESS_POLICY and does not persist', async () => {
    const store = new MemoryAccessPolicyStore();
    const ctx = new Context();
    new ChannelService(ctx);
    const registry = new ChannelDefinitionRegistry();
    registry.register(makeDef('qq', claimDescriptor));
    const service = new ChannelControlService(ctx, {
      credentials: seam,
      registry,
      accessStore: store,
    });

    // owner-only without ownerId is invalid.
    const bad: ChannelAccessPolicy = {
      version: 1,
      preset: 'owner-only',
      dmPolicy: 'allowlist',
      allowFrom: ['x'],
      groupPolicy: 'disabled',
      groups: {},
    };
    await expect(service.saveAccess('qq', bad)).rejects.toMatchObject({
      code: 'INVALID_ACCESS_POLICY',
    });
    expect(await store.get('qq', 'main')).toBeUndefined();
  });
});

describe('ChannelControlService owner claim (plan §29)', () => {
  it('beginOwnerClaim rejects CLAIM_NOT_SUPPORTED for ownerDiscovery=account', () => {
    const { service } = harness([
      makeDef('weixin', accountDescriptor, { resolveOwnerIdentity: async () => 'wx-user' }),
    ]);
    expect(() => service.beginOwnerClaim('weixin')).toThrowError(
      expect.objectContaining({ code: 'CLAIM_NOT_SUPPORTED' }),
    );
  });

  it('begin/get/confirm flow works across the service surface', async () => {
    const store = new MemoryAccessPolicyStore();
    const ctx = new Context();
    new ChannelService(ctx);
    const registry = new ChannelDefinitionRegistry();
    registry.register(makeDef('qq', claimDescriptor));
    const service = new ChannelControlService(ctx, {
      credentials: seam,
      registry,
      accessStore: store,
    });

    const claim = service.beginOwnerClaim('qq');
    expect(claim.phase).toBe('waiting-message');

    // Not-found mapping.
    expect(() => service.getOwnerClaim('qq', 'missing')).toThrowError(
      expect.objectContaining({ code: 'CLAIM_NOT_FOUND' }),
    );

    // Drive a candidate through the service-level observer.
    service.ownerClaims.observe({
      type: 'message.received',
      channel: 'qq',
      accountId: 'main',
      conversation: { id: 'dm-1', type: 'dm' },
      sender: { id: 'qq-user-1' },
      message: {
        id: 'm1',
        content: textParts(`/dsh-claim ${claim.challengeCode}`),
      },
    } as never);

    const candidate = service.getOwnerClaim('qq', claim.id);
    expect(candidate.phase).toBe('candidate');
    expect(candidate.candidate).toEqual({ senderId: 'qq-user-1' });

    // Confirm returns the access state, now ready with the claimed owner.
    const state = await service.confirmOwnerClaim('qq', claim.id);
    expect(state.readiness).toBe('ready');
    expect(state.owner).toEqual({ configured: true, id: 'qq-user-1', source: 'claim' });
  });

  it('cancelOwnerClaim marks the claim cancelled', () => {
    const { service } = harness([makeDef('qq', claimDescriptor)]);
    const claim = service.beginOwnerClaim('qq');
    service.cancelOwnerClaim('qq', claim.id);
    const read = service.getOwnerClaim('qq', claim.id);
    expect(read.phase).toBe('cancelled');
  });
});
