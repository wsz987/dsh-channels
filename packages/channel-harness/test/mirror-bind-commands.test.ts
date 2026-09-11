/**
 * Issue #6 — fail-closed `/bind` rebind support + issue #5 `/mirror` command.
 *
 * The resolution never mutates: exact match wins, a unique prefix (>= 4
 * chars) resolves, ambiguous prefixes / missing ids / targets bound to
 * another conversation / persisted-preset conflicts all refuse. `confirm`
 * re-runs the resolution (race guard) and only then re-points the durable
 * binding, adopting the target's persisted preset exactly like the official
 * resume path.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { SessionBinding } from '../src/session-router.ts';
import { confirmBindTarget, resolveBindTarget } from '../src/bind-support.ts';
import { createBindCommand } from '../src/commands/bind.ts';
import { createMirrorCommand } from '../src/commands/mirror.ts';
import type { ChannelBindResolution, ChannelCommandDependencies } from '../src/commands/index.ts';

function binding(sessionId: string, conversationId = 'chat-1'): SessionBinding {
  return {
    channelId: 'telegram',
    accountId: 'main',
    conversationId,
    conversationType: 'dm',
    sessionId,
    route: { preset: 'default' },
    schemaVersion: 3,
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeAgent(id: string): Agent {
  return { id: SessionId(id) } as unknown as Agent;
}

interface Fixture {
  bindings: Map<string, SessionBinding>;
  persisted: string[];
  presets: Map<string, string | undefined>;
}

function makeStores(fixture: Fixture) {
  const gateway = {
    listPersistedSessionIds: async () => [...fixture.persisted],
    persistedPresetOf: async (sessionId: string) => fixture.presets.get(sessionId),
  };
  const bindingStore = {
    get: async (key: string) => fixture.bindings.get(key),
    put: async (value: SessionBinding) => {
      for (const [key, existing] of fixture.bindings) {
        if (existing.sessionId === value.sessionId && key !== bindingKeyOf(value)) {
          fixture.bindings.delete(key);
        }
      }
      fixture.bindings.set(bindingKeyOf(value), value);
    },
    delete: async (key: string) => void fixture.bindings.delete(key),
    findBySessionId: async (sessionId: string) =>
      [...fixture.bindings.values()].find((b) => b.sessionId === sessionId),
  };
  return { gateway: gateway as never, bindingStore: bindingStore as never };
}

function bindingKeyOf(b: SessionBinding): string {
  return `${b.channelId}:${b.accountId}:${b.conversationId}`;
}

function fixture(): Fixture {
  const bindings = new Map<string, SessionBinding>();
  bindings.set('telegram:main:chat-1', binding('session-live'));
  const persisted = ['session-live', 'aaaaaaaa-1111', 'aaaaaaaa-2222', 'bbbbbbbb-3333'];
  const presets = new Map<string, string | undefined>([['bbbbbbbb-3333', 'code']]);
  return { bindings, persisted, presets };
}

describe('resolveBindTarget (issue #6, fail-closed)', () => {
  it('resolves an exact persisted id and reports its persisted preset', async () => {
    const f = fixture();
    const { gateway, bindingStore } = makeStores(f);
    const resolution = await resolveBindTarget(gateway, bindingStore, makeAgent('session-live'), 'aaaaaaaa-1111');
    expect(resolution).toMatchObject({ kind: 'resolved', sessionId: 'aaaaaaaa-1111', preset: undefined });
  });

  it('resolves a UNIQUE prefix but refuses an ambiguous one with candidates', async () => {
    const f = fixture();
    const { gateway, bindingStore } = makeStores(f);
    const unique = await resolveBindTarget(gateway, bindingStore, makeAgent('session-live'), 'bbbb');
    expect(unique).toMatchObject({ kind: 'resolved', sessionId: 'bbbbbbbb-3333', preset: 'code' });

    const ambiguous = await resolveBindTarget(gateway, bindingStore, makeAgent('session-live'), 'aaaa');
    expect(ambiguous).toMatchObject({ kind: 'ambiguous', candidates: ['aaaaaaaa-1111', 'aaaaaaaa-2222'] });
  });

  it('refuses a too-short prefix as missing', async () => {
    const f = fixture();
    const { gateway, bindingStore } = makeStores(f);
    await expect(resolveBindTarget(gateway, bindingStore, makeAgent('session-live'), 'aa'))
      .resolves.toMatchObject({ kind: 'missing' });
  });

  it('flags a target already bound to a different conversation (boundElsewhere)', async () => {
    const f = fixture();
    f.bindings.set('telegram:main:chat-2', binding('aaaaaaaa-1111', 'chat-2'));
    const { gateway, bindingStore } = makeStores(f);
    const resolution = await resolveBindTarget(gateway, bindingStore, makeAgent('session-live'), 'aaaaaaaa-1111');
    expect(resolution).toMatchObject({ kind: 'resolved', boundElsewhere: true });
  });

  it('flags a persisted-preset conflict with the conversation route', async () => {
    const f = fixture();
    const { gateway, bindingStore } = makeStores(f);
    const resolution = await resolveBindTarget(gateway, bindingStore, makeAgent('session-live'), 'bbbbbbbb-3333');
    expect(resolution).toMatchObject({ kind: 'resolved', preset: 'code', conflict: true });
  });

  it('reports missing for unknown ids', async () => {
    const f = fixture();
    const { gateway, bindingStore } = makeStores(f);
    await expect(resolveBindTarget(gateway, bindingStore, makeAgent('session-live'), 'zzzz-9999'))
      .resolves.toMatchObject({ kind: 'missing' });
  });
});

describe('confirmBindTarget (issue #6)', () => {
  it('re-points the durable binding and adopts the persisted preset', async () => {
    const f = fixture();
    f.persisted = ['session-live', 'cccccccc-4444'];
    f.presets.set('cccccccc-4444', 'research');
    // A route without an explicit preset cannot conflict — the persisted
    // composition wins exactly like the official resume path.
    f.bindings.get('telegram:main:chat-1')!.route = {};
    const { gateway, bindingStore } = makeStores(f);
    await confirmBindTarget(gateway, bindingStore, makeAgent('session-live'), 'cccccccc-4444');
    const rebound = f.bindings.get('telegram:main:chat-1')!;
    expect(rebound.sessionId).toBe('cccccccc-4444');
    expect(rebound.route).toEqual({ preset: 'research' });
    expect(rebound.channelId).toBe('telegram');
  });

  it('refuses to rebind a session bound to another conversation', async () => {
    const f = fixture();
    f.bindings.set('telegram:main:chat-2', binding('aaaaaaaa-1111', 'chat-2'));
    const { gateway, bindingStore } = makeStores(f);
    await expect(
      confirmBindTarget(gateway, bindingStore, makeAgent('session-live'), 'aaaaaaaa-1111'),
    ).rejects.toThrow(/bound to another conversation/);
    expect(f.bindings.get('telegram:main:chat-1')!.sessionId).toBe('session-live');
  });

  it('refuses a preset conflict instead of creating an unresumable binding', async () => {
    const f = fixture();
    const { gateway, bindingStore } = makeStores(f);
    await expect(
      confirmBindTarget(gateway, bindingStore, makeAgent('session-live'), 'bbbbbbbb-3333'),
    ).rejects.toThrow(/preset conflicts/);
    expect(f.bindings.get('telegram:main:chat-1')!.sessionId).toBe('session-live');
  });

  it('refuses self-rebind and a target that vanished between resolve and confirm', async () => {
    const f = fixture();
    const { gateway, bindingStore } = makeStores(f);
    await expect(
      confirmBindTarget(gateway, bindingStore, makeAgent('session-live'), 'session-live'),
    ).rejects.toThrow(/already bound/);
    await expect(
      confirmBindTarget(gateway, bindingStore, makeAgent('session-live'), 'zzzzzzzz-9999'),
    ).rejects.toThrow(/no longer uniquely resolvable/);
  });
});

describe('/mirror command (issue #5)', () => {
  function depsWith() {
    const mirror = { get: vi.fn(async () => false), set: vi.fn(async (_a: Agent, on: boolean) => void on) };
    const deps = { mirror } as unknown as ChannelCommandDependencies;
    return { deps, mirror };
  }

  it('toggles on and off, and reports the current state on empty args', async () => {
    const { deps, mirror } = depsWith();
    const command = createBindableMirror(deps);
    const agent = makeAgent('session-live');

    const on = await command.handler!({ agent, rawInput: 'on' } as never);
    expect(on).toMatchObject({ kind: 'success' });
    expect(mirror.set).toHaveBeenCalledWith(agent, true);

    const status = await command.handler!({ agent, rawInput: '' } as never);
    expect(status.kind).toBe('success');
    expect(mirror.get).toHaveBeenCalledWith(agent);

    const off = await command.handler!({ agent, rawInput: 'off' } as never);
    expect(off).toMatchObject({ kind: 'success' });
    expect(mirror.set).toHaveBeenCalledWith(agent, false);
  });

  it('rejects unknown arguments and a missing mirror capability', async () => {
    const command = createBindableMirror({} as ChannelCommandDependencies);
    await expect(command.handler!({ agent: makeAgent('s'), rawInput: 'maybe' } as never))
      .resolves.toMatchObject({ kind: 'error' });
    await expect(command.handler!({ agent: makeAgent('s'), rawInput: '' } as never))
      .resolves.toMatchObject({ kind: 'error' });
  });
});

describe('/bind command (issue #6)', () => {
  function resolution(overrides: Partial<ChannelBindResolution>): ChannelBindResolution {
    return { kind: 'resolved', sessionId: 'aaaaaaaa-1111', ...overrides };
  }

  it('presents the confirmation plan on resolve and rebinds on confirm', async () => {
    const bind = {
      resolve: vi.fn(async () => resolution({ preset: 'research' })),
      confirm: vi.fn(async () => {}),
    };
    const command = createBindCommand({ bind } as unknown as ChannelCommandDependencies);
    const agent = makeAgent('session-live');

    const plan = await command.handler!({ agent, rawInput: 'aaaaaaaa-1111' } as never);
    expect(plan.kind).toBe('success');
    expect((plan as { text: string }).text).toContain('/bind aaaaaaaa-1111 confirm');
    expect(bind.confirm).not.toHaveBeenCalled();

    const done = await command.handler!({ agent, rawInput: 'aaaaaaaa-1111 confirm' } as never);
    expect(done).toMatchObject({ kind: 'success' });
    expect(bind.confirm).toHaveBeenCalledWith(agent, 'aaaaaaaa-1111');
  });

  it('surfaces refusals verbatim and never confirms an unresolved target', async () => {
    const bind = {
      resolve: vi.fn(async () => resolution({ boundElsewhere: true })),
      confirm: vi.fn(async () => {}),
    };
    const command = createBindCommand({ bind } as unknown as ChannelCommandDependencies);
    const agent = makeAgent('session-live');

    const refused = await command.handler!({ agent, rawInput: 'aaaaaaaa-1111 confirm' } as never);
    expect(refused).toMatchObject({ kind: 'error' });
    expect(bind.confirm).not.toHaveBeenCalled();

    const ambiguous = await command.handler!({ agent, rawInput: 'aaaa' } as never);
    expect(ambiguous.kind).toBe('success'); // resolve-only output, no mutation
  });

  it('requires arguments and the confirm literal', async () => {
    const command = createBindCommand({ bind: { resolve: vi.fn(), confirm: vi.fn() } } as unknown as ChannelCommandDependencies);
    await expect(command.handler!({ agent: makeAgent('s'), rawInput: '' } as never))
      .resolves.toMatchObject({ kind: 'error' });
    await expect(command.handler!({ agent: makeAgent('s'), rawInput: 'aaaaaaaa-1111 yes' } as never))
      .resolves.toMatchObject({ kind: 'error' });
  });
});

function createBindableMirror(deps: ChannelCommandDependencies) {
  return createMirrorCommand(deps);
}
