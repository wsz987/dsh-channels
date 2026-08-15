/**
 * AuthSessionManager unit tests (doc §19–§20, §53 Task 7) with a fake
 * ChannelDefinition + injectable clock.
 */
import { describe, expect, it, vi } from 'vitest';
import { ChannelDefinitionRegistry } from '../../src/definitions/registry.js';
import { AuthSessionManager } from '../../src/auth/session-manager.js';
import { ControlError } from '../../src/errors.js';
import type {
  AuthInput,
  AuthProviderSession,
  ChannelDefinition,
} from '../../src/index.js';

/** Fixed future expiry so sessions are live unless a test shrinks it. */
const FAR = Number.MAX_SAFE_INTEGER;

function makeProviderSession(overrides: Partial<AuthProviderSession> = {}): AuthProviderSession {
  return {
    provider: 'weixin',
    expiresAt: FAR,
    pollingIntervalMs: 5000,
    qr: { kind: 'content', value: 'auth://scan' },
    providerState: { marker: 'opaque-provider-state' },
    ...overrides,
  };
}

function makeDefinition(overrides: Partial<ChannelDefinition> = {}): ChannelDefinition {
  return {
    id: 'weixin',
    setup: { fields: [], authMethods: ['qr'] },
    getConfiguredState: async () => ({ configured: false, fields: {} }),
    saveConfig: async () => {},
    createAdapter: async () => {
      throw new Error('not used');
    },
    ...overrides,
  } as ChannelDefinition;
}

/** Build an AuthSessionManager over one def with an explicit clock. */
function setup(overrides: {
  def?: ChannelDefinition;
  now?: number;
  provider?: Partial<AuthProviderSession>;
} = {}) {
  const registry = new ChannelDefinitionRegistry();
  const definition = overrides.def ?? makeDefinition();
  registry.register(definition);

  const clock = { value: overrides.now ?? 1000 };
  const manager = new AuthSessionManager({ registry, now: () => clock.value });
  const advance = (ms: number) => {
    clock.value += ms;
  };
  return { manager, definition, clock, advance };
}

describe('AuthSessionManager', () => {
  it('create returns a browser-safe PublicAuthSession with a randomUUID id (not channelId)', async () => {
    const { manager, definition } = setup();
    const beginAuth = vi.fn(async () => makeProviderSession());
    definition.beginAuth = beginAuth;

    const session = await manager.create('weixin', { method: 'qr' });

    expect(beginAuth).toHaveBeenCalledWith({ method: 'qr' });
    expect(session.id).not.toBe('weixin');
    expect(session.id).toMatch(/^[0-9a-f]{8}-/); // randomUUID shape
    expect(session.channelId).toBe('weixin');
    expect(session.state).toBe('pending');
    // The public DTO carries qr but never host-only fields.
    expect(session.qr).toEqual({ kind: 'content', value: 'auth://scan' });
    expect('providerState' in session).toBe(false);
    expect('deviceCode' in session).toBe(false);
  });

  it('one active session per key: a second create replaces the first (old id gone)', async () => {
    const { manager, definition } = setup();
    definition.beginAuth = vi.fn(async () => makeProviderSession());

    const first = await manager.create('weixin', { method: 'qr' });
    expect(manager.size).toBe(1);

    const second = await manager.create('weixin', { method: 'qr' });
    expect(manager.size).toBe(1);
    expect(second.id).not.toBe(first.id);
    expect(manager.listIds()).toEqual([second.id]);
  });

  it('poll before nextPollAt throttles: provider is NOT called', async () => {
    const { manager, definition } = setup();
    const pollAuth = vi.fn(async () => ({ state: 'pending' as const, phase: 'waiting-scan' as const }));
    definition.beginAuth = vi.fn(async () => makeProviderSession());
    definition.pollAuth = pollAuth;

    const session = await manager.create('weixin', { method: 'qr' });
    // clock=1000, nextPollAt = 1000 + 5000 = 6000.
    const status = await manager.poll(session.id);

    expect(pollAuth).not.toHaveBeenCalled();
    expect(status.state).toBe('pending');
    expect(status.phase).toBe('waiting-scan');
  });

  it('poll after the interval calls the provider once, then throttle kicks in again', async () => {
    const { manager, definition, advance } = setup();
    definition.beginAuth = vi.fn(async () => makeProviderSession());
    const pollAuth = vi.fn(async () => ({ state: 'pending' as const, phase: 'waiting-confirm' as const }));
    definition.pollAuth = pollAuth;

    const session = await manager.create('weixin', { method: 'qr' });
    expect(pollAuth).not.toHaveBeenCalled();

    advance(5000); // now=6000 >= nextPollAt -> hit provider once
    const first = await manager.poll(session.id);
    expect(pollAuth).toHaveBeenCalledTimes(1);
    expect(first.phase).toBe('waiting-confirm');

    // Immediate second poll: within the new interval -> throttled.
    await manager.poll(session.id);
    expect(pollAuth).toHaveBeenCalledTimes(1);
  });

  it('poll on an unknown session throws AUTH_SESSION_NOT_FOUND (stable code)', async () => {
    const { manager } = setup();
    await expect(manager.poll('nope')).rejects.toBeInstanceOf(ControlError);
    await expect(manager.poll('nope')).rejects.toMatchObject({ code: 'AUTH_SESSION_NOT_FOUND' });
  });

  it('terminal state short-circuits provider even when interval has elapsed', async () => {
    const { manager, definition, advance } = setup();
    definition.beginAuth = vi.fn(async () => makeProviderSession());
    const pollAuth = vi.fn(async () => ({
      state: 'authenticated' as const,
      phase: 'authorized' as const,
    }));
    definition.pollAuth = pollAuth;

    const session = await manager.create('weixin', { method: 'qr' });

    // First poll past the interval reaches the provider -> terminal.
    advance(5000);
    await manager.poll(session.id);
    expect(pollAuth).toHaveBeenCalledTimes(1);

    // Even with more elapsed time, a terminal session never hits the provider.
    advance(5000);
    const status = await manager.poll(session.id);
    expect(status.state).toBe('authenticated');
    expect(status.phase).toBe('authorized');
    expect(pollAuth).toHaveBeenCalledTimes(1);
  });

  it('submit verification-code forwards input to the provider and returns a re-polled status', async () => {
    const { manager, definition } = setup();
    definition.beginAuth = vi.fn(async () => makeProviderSession());
    const submitAuthInput = vi.fn(async () => undefined);
    const pollAuth = vi.fn(async () => ({
      state: 'authenticated' as const,
      phase: 'authorized' as const,
    }));
    definition.submitAuthInput = submitAuthInput;
    definition.pollAuth = pollAuth;

    const session = await manager.create('weixin', { method: 'qr' });
    const input: AuthInput = { kind: 'verification-code', value: '123456' };
    const status = await manager.submit(session.id, input);

    expect(submitAuthInput).toHaveBeenCalledTimes(1);
    expect(status.state).toBe('authenticated');
    // Submit forces a provider re-poll.
    expect(pollAuth).toHaveBeenCalledTimes(1);
  });

  it('cancel aborts, removes the session, and later polls reject', async () => {
    const { manager, definition } = setup();
    definition.beginAuth = vi.fn(async () => makeProviderSession());
    const session = await manager.create('weixin', { method: 'qr' });
    const id = session.id;

    await manager.cancel(id);
    expect(manager.listIds()).toEqual([]);
    await expect(manager.poll(id)).rejects.toBeInstanceOf(ControlError);
  });

  it('expired session: clock past expiresAt -> poll returns expired and session removed', async () => {
    const { manager, definition, advance } = setup({
      provider: { expiresAt: 1000 + 60_000 },
    });
    definition.beginAuth = vi.fn(async () => makeProviderSession({ expiresAt: 1000 + 60_000 }));
    const pollAuth = vi.fn(async () => ({ state: 'pending' as const, phase: 'waiting-scan' as const }));
    definition.pollAuth = pollAuth;

    const session = await manager.create('weixin', { method: 'qr' });
    expect(session.state).toBe('pending');

    advance(60_001); // now past expiresAt
    const status = await manager.poll(session.id);
    expect(status.state).toBe('expired');
    expect(status.phase).toBe('expired');
    // The provider is never consulted for an already-expired session.
    expect(pollAuth).not.toHaveBeenCalled();
    expect(manager.listIds()).toEqual([]);
  });

  it('sanitizer toPublicSession strips providerState/challenge/deviceCode', async () => {
    const { manager, definition } = setup({
      provider: { deviceCode: 'dev-42' },
    });
    definition.beginAuth = vi.fn(async () =>
      makeProviderSession({ deviceCode: 'dev-42' }),
    );

    const session = await manager.create('weixin', { method: 'device' });
    // Host-only fields must not appear on the public DTO.
    const sanitized = session as unknown as Record<string, unknown>;
    expect(sanitized.providerState).toBeUndefined();
    expect(sanitized.challenge).toBeUndefined();
    expect(sanitized.deviceCode).toBeUndefined();
    expect(sanitized.abortController).toBeUndefined();
    expect(session.deviceCode).toBeUndefined();
  });

  it('create on a channel without beginAuth throws AUTH_NOT_SUPPORTED', async () => {
    const { manager, definition } = setup();
    delete (definition as Partial<ChannelDefinition>).beginAuth;
    await expect(manager.create('weixin', { method: 'qr' })).rejects.toMatchObject({
      code: 'AUTH_NOT_SUPPORTED',
    });
  });
});
