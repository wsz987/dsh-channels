/**
 * OwnerClaimSessionManager tests (execution plan §21, §55).
 *
 * Matrix covered:
 * - begin claim (challenge >= 32 hex chars, TTL, phase waiting-message)
 * - wrong code → phase stays waiting-message
 * - expired code → phase expired
 * - single-use / first candidate captured, second ignored
 * - group claim rejected
 * - unknown sender rejected
 * - local cancel
 * - local confirm rebinds owner (no-policy / owner-only / allowlist-custom)
 * - claim message never creates state on wrong/partial input (void + no policy)
 * - challenge never logged (spy logger)
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChannelAccessPolicy, ChannelEvent } from '@wsz987/channel-core';
import { textParts } from '@wsz987/channel-core';
import { ChannelDefinitionRegistry } from '../../src/definitions/registry.js';
import type { ChannelAccessDescriptor, ChannelDefinition } from '../../src/types.js';
import { MemoryAccessPolicyStore } from '../../src/access/policy-store.js';
import {
  OwnerClaimSessionManager,
  type OwnerClaimLogger,
} from '../../src/access/owner-claim.js';
import { ownerOnlyPolicy } from '../../src/access/materialize.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const claimDescriptor: ChannelAccessDescriptor = {
  directMessages: true,
  groups: true,
  mentions: false,
  ownerDiscovery: 'claim',
  identityLabels: { user: 'QQ User OpenID', group: 'QQ Group OpenID' },
};

function makeDef(id: string, overrides: Partial<ChannelDefinition> = {}): ChannelDefinition {
  return {
    id,
    enabled: true,
    access: claimDescriptor,
    setup: { fields: [], authMethods: [] },
    getConfiguredState: async () => ({ configured: true, fields: {} }),
    saveConfig: async () => {},
    createAdapter: async () => {
      throw new Error('not used');
    },
    ...overrides,
  } as ChannelDefinition;
}

function claimMessage(
  overrides: Partial<ChannelEvent> = {},
): ChannelEvent {
  return {
    type: 'message.received',
    channel: 'qq',
    accountId: 'main',
    conversation: { id: 'conv-1', type: 'dm' },
    sender: { id: 'sender-1' },
    message: { id: 'msg-1', content: textParts('/dsh-claim XXXXX') },
    ...overrides,
  } as unknown as ChannelEvent;
}

function makeManager(options: { now?: () => number } = {}) {
  const store = new MemoryAccessPolicyStore();
  const registry = new ChannelDefinitionRegistry();
  registry.register(makeDef('qq'));
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
  } as OwnerClaimLogger & { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
  const manager = new OwnerClaimSessionManager({
    registry,
    store,
    logger,
    now: options.now,
  });
  return { manager, store, registry, logger };
}

function claimWithCode(manager: OwnerClaimSessionManager, code: string): ChannelEvent {
  return claimMessage({
    message: { id: 'msg-c', content: textParts(`/dsh-claim ${code}`) },
  });
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('OwnerClaimSessionManager.begin', () => {
  it('creates a waiting-message session with a 32+ hex challenge and 5m TTL', () => {
    const { manager } = makeManager();
    const claim = manager.begin('qq');
    expect(claim.phase).toBe('waiting-message');
    expect(claim.channelId).toBe('qq');
    expect(claim.accountId).toBe('main');
    expect(claim.challengeCode).toBeDefined();
    expect(claim.challengeCode!.length).toBeGreaterThanOrEqual(32);
    expect(/^[0-9a-f]+$/.test(claim.challengeCode!)).toBe(true);
    // Whole number of bytes → even length.
    expect(claim.challengeCode!.length % 2).toBe(0);
    // 5-minute TTL.
    const ttl = claim.expiresAt - Date.now();
    expect(ttl).toBeGreaterThanOrEqual(5 * 60_000 - 100);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000);
  });

  it('rejects CLAIM_NOT_SUPPORTED for a non-claim channel', () => {
    const registry = new ChannelDefinitionRegistry();
    registry.register(
      makeDef('weixin', {
        access: {
          directMessages: true,
          groups: false,
          mentions: false,
          ownerDiscovery: 'account',
          identityLabels: { user: 'Weixin User ID' },
        },
      }),
    );
    const manager = new OwnerClaimSessionManager({
      registry,
      store: new MemoryAccessPolicyStore(),
      logger: { warn: () => {}, info: () => {} },
    });
    expect(() => manager.begin('weixin')).toThrowError(
      expect.objectContaining({ code: 'CLAIM_NOT_SUPPORTED' }),
    );
  });

  it('resumes the active claim without replacing its id or challenge', () => {
    const { manager, logger } = makeManager();
    const first = manager.begin('qq');
    const resumed = manager.begin('qq');
    expect(resumed).toEqual(first);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('owner claim resumed'));
    expect(logger.info.mock.calls.flat().join(' ')).not.toContain(first.challengeCode);
  });

  it('starts a new claim when the prior session expired without being polled', () => {
    let now = 0;
    const { manager } = makeManager({ now: () => now });
    const first = manager.begin('qq');
    now = first.expiresAt + 1;
    const next = manager.begin('qq');
    expect(next.id).not.toBe(first.id);
    expect(next.challengeCode).not.toBe(first.challengeCode);
  });

  it('starts a new claim after the prior session was confirmed', async () => {
    const { manager } = makeManager();
    const first = manager.begin('qq');
    manager.observe(claimWithCode(manager, first.challengeCode!));
    await manager.confirm('qq', first.id);

    const next = manager.begin('qq');
    expect(next.id).not.toBe(first.id);
    expect(next.phase).toBe('waiting-message');
  });

  it('allows a new claim after the prior was cancelled', () => {
    const { manager, logger } = makeManager();
    const first = manager.begin('qq');
    manager.cancel('qq', first.id);
    expect(() => manager.begin('qq')).not.toThrow();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('owner claim started'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('owner claim cancelled'));
    expect(logger.info.mock.calls.flat().join(' ')).not.toContain(first.challengeCode);
  });
});

describe('OwnerClaimSessionManager.observe', () => {
  it('stores the trimmed canonical sender id', () => {
    const { manager } = makeManager();
    const claim = manager.begin('qq');
    const event = claimWithCode(manager, claim.challengeCode!);
    event.sender.id = '  sender-1  ' as never;

    manager.observe(event);

    expect(manager.get('qq', claim.id).candidate).toEqual({ senderId: 'sender-1' });
  });

  it('captures the first valid candidate with the exact code (single-use)', () => {
    const { manager } = makeManager();
    const claim = manager.begin('qq');
    manager.observe(claimWithCode(manager, claim.challengeCode!));
    const read = manager.get('qq', claim.id);
    expect(read.phase).toBe('candidate');
    expect(read.candidate).toEqual({ senderId: 'sender-1' });
  });

  it('ignores a wrong code (phase stays waiting-message, never reveals)', async () => {
    const { manager, store } = makeManager();
    const claim = manager.begin('qq');
    manager.observe(claimWithCode(manager, 'deadbeefdeadbeefdeadbeefdeadbeef'));
    const read = manager.get('qq', claim.id);
    expect(read.phase).toBe('waiting-message');
    expect(read.candidate).toBeUndefined();
    // The wrong code must not have produced any stored policy.
    expect(await store.get('qq', 'main')).toBeUndefined();
  });

  it('ignores a second candidate after the first is captured', () => {
    const { manager } = makeManager();
    const claim = manager.begin('qq');
    manager.observe(claimWithCode(manager, claim.challengeCode!));
    manager.observe(
      claimMessage({ sender: { id: 'sender-2' }, message: { id: 'm2', content: textParts(`/dsh-claim ${claim.challengeCode!}`) } }),
    );
    const read = manager.get('qq', claim.id);
    expect(read.phase).toBe('candidate');
    expect(read.candidate).toEqual({ senderId: 'sender-1' });
  });

  it('rejects a group claim (does not record a candidate)', () => {
    const { manager } = makeManager();
    const claim = manager.begin('qq');
    manager.observe(
      claimMessage({
        conversation: { id: 'grp-1', type: 'group' },
        message: { id: 'm3', content: textParts(`/dsh-claim ${claim.challengeCode!}`) },
      }),
    );
    const read = manager.get('qq', claim.id);
    expect(read.phase).toBe('waiting-message');
    expect(read.candidate).toBeUndefined();
  });

  it('rejects an unknown/invalid sender id', () => {
    const { manager } = makeManager();
    const claim = manager.begin('qq');
    manager.observe(
      claimMessage({
        sender: { id: 'unknown' },
        message: { id: 'm4', content: textParts(`/dsh-claim ${claim.challengeCode!}`) },
      }),
    );
    manager.observe(
      claimMessage({
        sender: { id: '' },
        message: { id: 'm5', content: textParts(`/dsh-claim ${claim.challengeCode!}`) },
      }),
    );
    const read = manager.get('qq', claim.id);
    expect(read.phase).toBe('waiting-message');
    expect(read.candidate).toBeUndefined();
  });

  it('marks the claim expired when the code arrives after TTL', () => {
    let now = 0;
    const { manager } = makeManager({ now: () => now });
    const claim = manager.begin('qq');
    now = claim.expiresAt + 1;
    manager.observe(claimWithCode(manager, claim.challengeCode!));
    expect(() => manager.get('qq', claim.id)).toThrowError(
      expect.objectContaining({ code: 'CLAIM_EXPIRED' }),
    );
  });

  it('is a NO-OP for a non-message event', () => {
    const { manager } = makeManager();
    const claim = manager.begin('qq');
    manager.observe({ type: 'connection.changed', channel: 'qq', accountId: 'main', state: 'connected' });
    const read = manager.get('qq', claim.id);
    expect(read.phase).toBe('waiting-message');
  });

  it('is a NO-OP when there is no active claim (no throw, no state)', async () => {
    const { manager, store } = makeManager();
    expect(() =>
      manager.observe(claimWithCode(manager, 'abcdefabcdefabcdefabcdefabcdef')),
    ).not.toThrow();
    // observe is void and must not write any policy.
    expect(await store.get('qq', 'main')).toBeUndefined();
  });

  it('never throws out of observe even on malformed input', () => {
    const { manager } = makeManager();
    const claim = manager.begin('qq');
    expect(() => manager.observe({} as ChannelEvent)).not.toThrow();
    expect(() => manager.observe(claimMessage({ message: { id: 'x', content: [] } }))).not.toThrow();
  });
});

describe('OwnerClaimSessionManager.cancel / get', () => {
  it('get throws CLAIM_NOT_FOUND for an unknown claim', () => {
    const { manager } = makeManager();
    manager.begin('qq');
    expect(() => manager.get('qq', 'nope')).toThrowError(
      expect.objectContaining({ code: 'CLAIM_NOT_FOUND' }),
    );
  });

  it('cancel marks the session cancelled, idempotent', () => {
    const { manager } = makeManager();
    const claim = manager.begin('qq');
    manager.cancel('qq', claim.id);
    manager.cancel('qq', claim.id); // idempotent
    const read = manager.get('qq', claim.id);
    expect(read.phase).toBe('cancelled');
  });

  it('get on an expired session throws CLAIM_EXPIRED', () => {
    let now = 0;
    const { manager } = makeManager({ now: () => now });
    const claim = manager.begin('qq');
    now = claim.expiresAt + 1;
    expect(() => manager.get('qq', claim.id)).toThrowError(
      expect.objectContaining({ code: 'CLAIM_EXPIRED' }),
    );
  });
});

describe('OwnerClaimSessionManager.confirm (plan §25 rebind)', () => {
  it('throws CLAIM_INVALID when there is no candidate yet', async () => {
    const { manager } = makeManager();
    const claim = manager.begin('qq');
    await expect(manager.confirm('qq', claim.id)).rejects.toThrowError(
      expect.objectContaining({ code: 'CLAIM_INVALID' }),
    );
  });

  it('no-policy and owner-only rebind to a fresh owner-only', async () => {
    const { manager, store } = makeManager();
    const claim = manager.begin('qq');
    manager.observe(claimWithCode(manager, claim.challengeCode!));
    const confirmed = await manager.confirm('qq', claim.id);
    expect(confirmed.phase).toBe('confirmed');
    const policy = await store.get('qq', 'main');
    expect(policy).toEqual(ownerOnlyPolicy('sender-1'));
  });

  it('owner-only policy re-materializes allowFrom for the new owner', async () => {
    const { manager, store } = makeManager();
    await store.set('qq', 'main', ownerOnlyPolicy('old-owner'));
    const claim = manager.begin('qq');
    manager.observe(claimWithCode(manager, claim.challengeCode!));
    await manager.confirm('qq', claim.id);
    const policy = await store.get('qq', 'main');
    expect(policy).toMatchObject({
      preset: 'owner-only',
      ownerId: 'sender-1',
      allowFrom: ['sender-1'],
      groupPolicy: 'disabled',
      groups: {},
    });
  });

  it('allowlist/custom updates ownerId only, leaves allowFrom/groups untouched', async () => {
    const { manager, store } = makeManager();
    const custom: ChannelAccessPolicy = {
      version: 1,
      preset: 'custom',
      ownerId: 'old-owner',
      dmPolicy: 'allowlist',
      allowFrom: ['alice', 'bob'],
      groupPolicy: 'allowlist',
      groups: {
        'grp-1': { enabled: true, senderPolicy: 'open', allowFrom: ['carol'], requireMention: true },
      },
    };
    await store.set('qq', 'main', custom);
    const claim = manager.begin('qq');
    manager.observe(claimWithCode(manager, claim.challengeCode!));
    await manager.confirm('qq', claim.id);
    const policy = await store.get('qq', 'main');
    expect(policy?.ownerId).toBe('sender-1');
    expect(policy?.allowFrom).toEqual(['alice', 'bob']);
    expect(policy?.groups).toEqual(custom.groups);
  });

  it('confirm on an expired session throws CLAIM_EXPIRED', async () => {
    let now = 0;
    const { manager } = makeManager({ now: () => now });
    const claim = manager.begin('qq');
    manager.observe(claimWithCode(manager, claim.challengeCode!));
    now = claim.expiresAt + 1;
    await expect(manager.confirm('qq', claim.id)).rejects.toThrowError(
      expect.objectContaining({ code: 'CLAIM_EXPIRED' }),
    );
  });
});

describe('OwnerClaimSessionManager logging safety', () => {
  it('never logs the challenge code', async () => {
    const { manager, logger } = makeManager();
    const claim = manager.begin('qq');
    manager.observe(claimWithCode(manager, claim.challengeCode!));
    await manager.confirm('qq', claim.id);

    const callArgs = [...logger.info.mock.calls, ...logger.warn.mock.calls]
      .map((c) => c.map(String).join(' '))
      .join('\n');
    expect(callArgs).not.toContain(claim.challengeCode);
  });
});
