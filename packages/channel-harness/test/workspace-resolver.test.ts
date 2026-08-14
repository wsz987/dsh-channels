/**
 * Channel Workspace resolver tests (plan Test 6 / Test 7, §9).
 *
 * Uses the real `Context` from `@deepseek-ai/cordis` and provides a fake
 * `workspaceRegistry` (structural `WorkspaceRegistryLike`) via `ctx.provide`,
 * so `ctx.get('workspaceRegistry')` returns it — mirroring how the harness
 * exposes the official service at runtime.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ChannelLogger } from '@wsz987/channel-core';
import type { WorkspaceConfig } from '../src/config.ts';
import { HarnessChannelWorkspaceResolver, resolveChannelWorkspaceRoot, type ChannelWorkspaceLike, type ChannelWorkspaceInput, type WorkspaceRegistryLike } from '../src/workspace-resolver.ts';
import { stableSafeAccountKey as resolverKey } from '../src/channel-label.ts';

const silentLogger: ChannelLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Minimal fake workspace recording attach/detach calls. */
class FakeWorkspace implements ChannelWorkspaceLike {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  attachCalls: SessionId[] = [];

  constructor(path: string, title: string, index: number) {
    this.path = path;
    this.title = title;
    this.id = `ws-${index}`;
  }

  async attachSession(sessionId: SessionId): Promise<void> {
    this.attachCalls.push(sessionId);
  }

  async detachSession(_sessionId: SessionId): Promise<void> {}
}

/** Fake registry recording resolve/create calls and creating fake workspaces. */
class FakeRegistry implements WorkspaceRegistryLike {
  createCalls: { path: string; title?: string }[] = [];
  resolveCalls: string[] = [];
  private byPath = new Map<string, FakeWorkspace>();
  private nextIndex = 1;

  seed(path: string, title: string): FakeWorkspace {
    const ws = new FakeWorkspace(path, title, this.nextIndex++);
    this.byPath.set(path, ws);
    return ws;
  }

  async resolveByPath(path: string): Promise<ChannelWorkspaceLike | undefined> {
    this.resolveCalls.push(path);
    return this.byPath.get(path);
  }

  async create(path: string, title?: string): Promise<ChannelWorkspaceLike> {
    this.createCalls.push({ path, title });
    return this.seed(path, title ?? path);
  }
}

function baseInput(overrides: Partial<ChannelWorkspaceInput> = {}): ChannelWorkspaceInput {
  return { channelId: 'weixin', accountId: 'account-a', conversationId: 'c1', ...overrides };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('channel-account mode (plan Test 6 / Test 7)', () => {
  it('gives different channels distinct workspaces and cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ws-resolver-'));
    let ctx: Context | undefined;
    try {
      ctx = new Context();
      const registry = new FakeRegistry();
      ctx.provide('workspaceRegistry', registry);

      const config: WorkspaceConfig = { mode: 'channel-account', root: dir, autoCreate: true };
      const resolver = new HarnessChannelWorkspaceResolver(ctx, config, silentLogger);

      const weixin = await resolver.resolve(baseInput({ channelId: 'weixin' }));
      const telegram = await resolver.resolve(baseInput({ channelId: 'telegram' }));

      expect(weixin.cwd).toBe(join(dir, 'weixin', resolverKey('account-a')));
      expect(telegram.cwd).toBe(join(dir, 'telegram', resolverKey('account-a')));
      expect(weixin.cwd).not.toBe(telegram.cwd);
      expect(weixin.workspace?.id).not.toBe(telegram.workspace?.id);
      // Two distinct create calls (one per channel segment).
      expect(registry.createCalls).toHaveLength(2);
      expect(registry.createCalls[0]?.path === weixin.cwd).toBe(true);
      expect(registry.createCalls[1]?.path === telegram.cwd).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('same channel reuses the same workspace across conversations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ws-resolver-'));
    let ctx: Context | undefined;
    try {
      ctx = new Context();
      const registry = new FakeRegistry();
      ctx.provide('workspaceRegistry', registry);

      const config: WorkspaceConfig = { mode: 'channel-account', root: dir, autoCreate: true };
      const resolver = new HarnessChannelWorkspaceResolver(ctx, config, silentLogger);

      const first = await resolver.resolve(baseInput({ conversationId: 'c1' }));
      const second = await resolver.resolve(baseInput({ conversationId: 'c2' }));

      // Identical cwd and workspace for the same channel/account.
      expect(second.cwd).toBe(first.cwd);
      expect(second.workspace?.id).toBe(first.workspace?.id);
      // create called exactly once; the second resolve hit resolveByPath.
      expect(registry.createCalls).toHaveLength(1);
      expect(registry.resolveCalls).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('mode variations', () => {
  it('disabled resolves to {} without touching the registry', async () => {
    const ctx = new Context();
    const registry = new FakeRegistry();
    ctx.provide('workspaceRegistry', registry);

    const config: WorkspaceConfig = { mode: 'disabled', autoCreate: true };
    const resolver = new HarnessChannelWorkspaceResolver(ctx, config, silentLogger);

    const resolved = await resolver.resolve(baseInput());
    expect(resolved).toEqual({});
    expect(registry.createCalls).toHaveLength(0);
    expect(registry.resolveCalls).toHaveLength(0);
  });

  it('host-cwd returns process.cwd() and attaches the existing workspace', async () => {
    const ctx = new Context();
    const registry = new FakeRegistry();
    registry.seed(process.cwd(), 'Host CWD Workspace');
    ctx.provide('workspaceRegistry', registry);

    const config: WorkspaceConfig = { mode: 'host-cwd', autoCreate: true };
    const resolver = new HarnessChannelWorkspaceResolver(ctx, config, silentLogger);

    const resolved = await resolver.resolve(baseInput());
    expect(resolved.cwd).toBe(process.cwd());
    expect(resolved.workspace?.id).toBeDefined();
    expect(registry.resolveCalls).toContain(process.cwd());
  });

  it('host-cwd with no registry returns just { cwd }', async () => {
    const ctx = new Context();
    const config: WorkspaceConfig = { mode: 'host-cwd', autoCreate: true };
    const resolver = new HarnessChannelWorkspaceResolver(ctx, config, silentLogger);

    const resolved = await resolver.resolve(baseInput());
    expect(resolved.cwd).toBe(process.cwd());
    expect(resolved.workspace).toBeUndefined();
  });

  it('autoCreate false does not call create for an unregistered path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ws-resolver-'));
    let ctx: Context | undefined;
    try {
      ctx = new Context();
      const registry = new FakeRegistry();
      ctx.provide('workspaceRegistry', registry);

      const config: WorkspaceConfig = { mode: 'channel-account', root: dir, autoCreate: false };
      const resolver = new HarnessChannelWorkspaceResolver(ctx, config, silentLogger);

      const resolved = await resolver.resolve(baseInput());
      expect(resolved.cwd).toBeDefined();
      expect(resolved.workspace).toBeUndefined();
      expect(registry.createCalls).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('undefined config (schema default not applied)', () => {
  it('behaves as channel-account with default root under DSH_HOME', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ws-resolver-'));
    let ctx: Context | undefined;
    try {
      vi.stubEnv('DSH_HOME', dir);
      ctx = new Context();
      const registry = new FakeRegistry();
      ctx.provide('workspaceRegistry', registry);

      const resolver = new HarnessChannelWorkspaceResolver(ctx, undefined, silentLogger);

      const resolved = await resolver.resolve(baseInput());
      const defaultRoot = resolveChannelWorkspaceRoot(undefined);
      expect(defaultRoot).toBe(join(dir, 'workspaces', 'channels'));
      expect(resolved.cwd?.startsWith(join(dir, 'workspaces', 'channels'))).toBe(true);
      // mode is channel-account, so a workspace is created.
      expect(resolved.workspace?.id).toBeDefined();
      expect(registry.createCalls).toHaveLength(1);
    } finally {

      await rm(dir, { recursive: true, force: true });
    }
  });
});
