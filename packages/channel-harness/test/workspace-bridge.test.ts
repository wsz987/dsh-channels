/**
 * M5 workspace integration tests (plan §21, Test 1–4).
 *
 * Proves the channel Session factory transaction (plan §12/M3):
 *
 *   A. workspaceResolver.resolve(conversation)  -> cwd (+ workspace)
 *   B. agentManager.create(sessionId, route, ..., { cwd })
 *   C. workspace.attachSession(sessionId)
 *   D. bindingStore.put(binding)
 *   E. registerBinding(binding)
 *   F. structured success log
 *
 * and its failure semantics (plan §11 revision — SOFT attach): a Workspace
 * attach failure keeps the freshly-created agent (NOT disposed), persists the
 * binding, and followup still runs — the session merely stays ungrouped — while
 * a binding-write failure still rolls back (detach + dispose).
 *
 * Fixture design mirrors `channel-harness.test.ts` (FakeGateway, FakeAdapter,
 * baseConfig with `workspace: { mode: 'disabled' }`), but the bridge under
 * test injects a configurable `FakeWorkspaceResolver` instead of the no-op.
 * The `/new` case mounts the REAL command runtime so the registered channel
 * command executes through `ctx.commands` (same as `commands.test.ts`).
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import { createScope } from '@deepseek-ai/dsh-scope';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { MessageReceived } from '@wsz987/channel-core';
import {
  AgentManager,
  type AgentGateway,
  type AgentCreateMeta,
  type AgentRouteSpec,
  type GatewayAgentHandle,
} from '../src/agent-manager.ts';
import { AgentRouter } from '../src/agent-router.ts';
import { MemoryBindingStore } from '../src/binding-store.ts';
import { ChannelHarnessBridge } from '../src/bridge.ts';
import { Config } from '../src/config.ts';
import { ReplyContextStore } from '../src/reply-context-store.ts';
import { SESSION_BINDING_SCHEMA_VERSION, type SessionBinding } from '../src/session-router.ts';
import type {
  ChannelWorkspaceInput,
  ChannelWorkspaceLike,
  ChannelWorkspaceResolver,
  ResolvedChannelWorkspace,
} from '../src/workspace-resolver.ts';

const defaultRoute: AgentRouteSpec = { preset: 'default' };

function baseConfig(): Config {
  return Config({
    agent: { default: defaultRoute },
    routing: {
      mode: 'global',
      overrides: {
        channel: { weixin: { model: 'weixin-agent' } },
      },
    },
    bindingStore: { type: 'memory' },
    workspace: { mode: 'disabled' },
    reply: {
      updateIntervalMs: 0,
      maxTextLength: undefined,
      splitParagraphs: true,
      splitCodeBlocks: true,
      finalFlush: true,
    },
    maxConcurrency: 4,
    includeMetadataPrefix: true,
  });
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Capturing logger so we can assert the structured success / error logs. */
function capturingLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

class FakeAdapter {
  id: string;
  capabilities = {
    text: true,
    image: false,
    file: false,
    audio: false,
    video: false,
    markdown: true,
    cards: false,
    reactions: false,
    threads: false,
    streaming: 'buffered',
  } as const;
  sent: { text?: string }[] = [];

  constructor(id = 'weixin') {
    this.id = id;
  }

  async start() {}
  async stop() {}
  async send(_target: unknown, message: { text?: string }) {
    this.sent.push(message);
    return { delivered: true };
  }
}

function makeMessageEvent(overrides: Partial<MessageReceived> = {}): MessageReceived {
  return {
    type: 'message.received',
    channel: 'weixin',
    accountId: 'main',
    conversation: { id: 'user_123', type: 'dm' },
    sender: { id: 'user_123', name: 'Alice' },
    message: { id: 'm1', content: [{ type: 'text', text: 'hello' }] },
    ...overrides,
  };
}

function makeBinding(overrides: Partial<SessionBinding> = {}): SessionBinding {
  return {
    channelId: 'weixin',
    accountId: 'main',
    conversationId: 'user_123',
    conversationType: 'dm',
    sessionId: 'old-session',
    route: defaultRoute,
    schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface FakeSessionLog {
  events: { type: string; data: unknown; seq: number; time: number }[];
  append(type: string, data: unknown): { type: string; data: unknown; seq: number; time: number };
}

interface FakeAgent {
  id: SessionId;
  ctx: Context;
  session: FakeSessionLog;
  status: 'idle' | 'running';
}

/** Mint a fake agent under a real scoped context (the agent object is the scope key). */
function fakeScopedAgent(rootCtx: Context, id: string): FakeAgent {
  const events: FakeSessionLog['events'] = [];
  const agent: FakeAgent = {
    id: SessionId(id),
    ctx: new Context(),
    session: {
      events,
      append(type, data) {
        const event = { type, data, seq: events.length, time: Date.now() };
        events.push(event);
        return event;
      },
    },
    status: 'idle',
  };
  const scoped = createScope(rootCtx, agent as never);
  agent.ctx = scoped.ctx;
  return agent;
}

/**
 * In-memory gateway recording every drive call. `create` also records the
 * `meta` it received so tests can assert the resolved `cwd` was threaded into
 * the underlying agent create. The created agent is minted under a real scoped
 * context and the optional `setup` is invoked (so the `/new` case has channel
 * commands installed), mirroring the real agent-loop factory.
 */
class FakeGateway implements AgentGateway {
  canResumeValue = true;
  existsValue = false;
  live = new Map<string, GatewayAgentHandle>();
  createCalls: string[] = [];
  resumeCalls: string[] = [];
  createMetas: Record<string, AgentCreateMeta | undefined> = {};
  failCreateWith?: Error;
  followed: string[] = [];
  followups: { sessionId: string; message: unknown }[] = [];
  disposed: string[] = [];

  constructor(private readonly rootCtx: Context) {}

  get(sessionId: string) {
    const agent = this.live.get(sessionId);
    if (!agent) return undefined;
    return { id: agent.id, agent: agent.agent, followup: agent.followup, whenIdle: agent.whenIdle };
  }

  canResume(): boolean {
    return this.canResumeValue;
  }

  async exists(): Promise<boolean> {
    return this.existsValue;
  }

  async create(sessionId: string, route: AgentRouteSpec, setup?: Parameters<AgentGateway['create']>[2], meta?: AgentCreateMeta) {
    this.createCalls.push(sessionId);
    this.createMetas[sessionId] = meta;
    if (this.failCreateWith) throw this.failCreateWith;
    const handle = this.makeHandle(sessionId, setup);
    void route;
    return handle;
  }

  async resume(sessionId: string, route: AgentRouteSpec, setup?: Parameters<AgentGateway['resume']>[2]) {
    this.resumeCalls.push(sessionId);
    return this.makeHandle(sessionId, setup);
  }

  private async makeHandle(sessionId: string, setup?: Parameters<AgentGateway['create']>[2]): Promise<GatewayAgentHandle> {
    const agent = fakeScopedAgent(this.rootCtx, sessionId);
    if (setup) {
      const commit = await setup(agent.ctx as never);
      commit?.commit();
    }
    const handle: GatewayAgentHandle = {
      id: sessionId,
      agent: agent as unknown as Agent,
      followup: (message) => {
        this.followups.push({ sessionId, message });
        this.followed.push(sessionId);
      },
      whenIdle: async () => {},
      dispose: async () => {
        if (!this.disposed.includes(sessionId)) this.disposed.push(sessionId);
        this.live.delete(sessionId);
      },
    };
    this.live.set(sessionId, handle);
    return handle;
  }
}

/**
 * Configurable fake resolver: returns a fixed channel Workspace (path = this.cwd)
 * for every conversation so the SAME Workspace is reused across /new (plan Test
 * 3 "new Session attached to the SAME channel Workspace"). Records attach/detach
 * and can be told to fail `attachSession` (plan Test 4).
 */
class FakeWorkspaceResolver implements ChannelWorkspaceResolver {
  cwd = 'C:\\Users\\test\\.dsh\\workspaces\\channels\\weixin\\1f8a20';
  workspace: ChannelWorkspaceLike;
  attachCalls: string[] = [];
  detachCalls: string[] = [];
  failAttachWith?: Error;

  constructor(channelId = 'weixin', accountId = 'main') {
    const that = this;
    this.workspace = {
      id: `ws-${channelId}-${accountId}`,
      path: this.cwd,
      title: `Channels · ${channelId}`,
      attachSession: async (sessionId) => {
        that.attachCalls.push(String(sessionId));
        if (that.failAttachWith) throw that.failAttachWith;
      },
      detachSession: async (sessionId) => {
        that.detachCalls.push(String(sessionId));
      },
    };
  }

  async resolve(_input: ChannelWorkspaceInput): Promise<ResolvedChannelWorkspace> {
    return { cwd: this.cwd, workspace: this.workspace };
  }
}

/** Bridge over a real CommandRuntime + the injecting resolver (mirrors makeBridge in commands.test.ts + channel-harness). */
function makeBridge(options: {
  resolver?: FakeWorkspaceResolver;
  logger?: ReturnType<typeof capturingLogger>;
  mountSessions?: boolean;
} = {}) {
  const rootCtx = new Context();
  new CommandRuntime(rootCtx);
  if (options.mountSessions) new SessionStore(rootCtx);
  const gateway = new FakeGateway(rootCtx);
  const manager = new AgentManager(gateway, silentLogger, 4);
  const adapter = new FakeAdapter('weixin');
  const bindingStore = new MemoryBindingStore();
  const logger = options.logger ?? silentLogger;
  const resolver = options.resolver ?? new FakeWorkspaceResolver();
  let bridge!: ChannelHarnessBridge;
  bridge = new ChannelHarnessBridge({
    config: baseConfig(),
    bindingStore,
    agentManager: manager,
    agentRouter: new AgentRouter(baseConfig()),
    getAdapter: () => adapter as never,
    replyContexts: new ReplyContextStore(),
    logger,
    ctx: rootCtx,
    commandDeps: { startNewSession: (agent) => bridge.startNewSession(agent) },
    workspaceResolver: resolver,
  });
  return { rootCtx, gateway, manager, bridge, adapter, bindingStore, logger };
}

describe('M5 workspace integration (plan §21)', () => {
  it('does not log expected connection/auth status events as ignored messages', async () => {
    const logger = capturingLogger();
    const { bridge } = makeBridge({ logger });

    await bridge.handleChannelEvent({
      type: 'connection.changed',
      channel: 'telegram' as never,
      accountId: 'main' as never,
      state: 'connecting',
    });
    await bridge.handleChannelEvent({
      type: 'auth.changed',
      channel: 'telegram' as never,
      accountId: 'main' as never,
      state: 'authenticated',
    });

    expect(logger.debug).not.toHaveBeenCalled();
  });

  it('Test 1 — no binding + ordinary first message creates a session at the resolved cwd, attaches, persists, and follows up', async () => {
    const resolver = new FakeWorkspaceResolver();
    const logger = capturingLogger();
    const { gateway, bridge, bindingStore } = makeBridge({ resolver, logger });

    await bridge.handleChannelEvent(makeMessageEvent());

    // New Session created.
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.resumeCalls).toHaveLength(0);
    // ... with the resolved channel workspace path threaded into the create meta.
    const createdSessionId = gateway.createCalls[0]!;
    expect(gateway.createMetas[createdSessionId]?.cwd).toBe(resolver.cwd);
    // Workspace attach called exactly once with the created session.
    expect(resolver.attachCalls).toEqual([createdSessionId]);
    // Binding persisted.
    const binding = await bindingStore.get('weixin:main:user_123');
    expect(binding?.sessionId).toBe(createdSessionId);
    // Followup ran for the ordinary message.
    expect(gateway.followups).toHaveLength(1);
    // Structured success log carries the workspace/cwd identity.
    const createdLog = logger.info.mock.calls.find((c) => c[0] === '[channel-harness] fresh channel session created');
    expect(createdLog).toBeDefined();
    const fields = createdLog![1] as Record<string, unknown>;
    expect(fields).toBeDefined();
    expect(fields).toMatchObject({
      sessionId: createdSessionId,
      channelId: 'weixin',
      workspaceId: resolver.workspace.id,
      cwd: resolver.cwd,
      bindingKey: 'weixin:main:user_123',
    });
    expect(fields.accountIdHash).toBeTruthy();
  });

  it('Test 2 — no binding + /new creates exactly one session, attaches, persists, replies, and never follows up', async () => {
    const resolver = new FakeWorkspaceResolver();
    const { gateway, bridge, adapter, bindingStore } = makeBridge({ resolver });

    await bridge.handleChannelEvent(makeMessageEvent({ message: { id: 'm1', content: [{ type: 'text', text: '/new' }] } }));

    // Exactly one create, one attach, no followup.
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.resumeCalls).toHaveLength(0);
    expect(resolver.attachCalls).toHaveLength(1);
    expect(gateway.followups).toHaveLength(0);
    // One binding persisted.
    const binding = await bindingStore.get('weixin:main:user_123');
    expect(binding?.sessionId).toBe(gateway.createCalls[0]!);
    // Reply notice delivered through the command plane.
    expect(adapter.sent.map((s) => s.text)).toContain('已开启新会话。');
  });

  it('Test 3 — existing binding + /new switches to a NEW session on the SAME workspace and retires the old agent', async () => {
    const resolver = new FakeWorkspaceResolver();
    const { gateway, bridge, bindingStore } = makeBridge({ resolver });

    // First an ordinary message -> session A.
    await bridge.handleChannelEvent(makeMessageEvent({ message: { id: 'm1', content: [{ type: 'text', text: 'hello' }] } }));
    const A = gateway.createCalls[0]!;
    const aFollowupsBefore = gateway.followups.length;

    // Then /new -> session B.
    await bridge.handleChannelEvent(makeMessageEvent({ message: { id: 'm2', content: [{ type: 'text', text: '/new' }] } }));
    expect(gateway.createCalls).toHaveLength(2);
    const B = gateway.createCalls[1]!;
    expect(B).not.toBe(A);

    // New session attached to the SAME channel workspace (stateless resolver returns the same workspace).
    expect(resolver.attachCalls).toContain(B);
    expect(resolver.attachCalls).toContain(A);

    // Binding switched to B.
    const binding = await bindingStore.get('weixin:main:user_123');
    expect(binding?.sessionId).toBe(B);

    // Old agent A retired (post-command retire path).
    expect(gateway.disposed).toContain(A);

    // /new is command-only — no followup.
    expect(gateway.followups.length).toBe(aFollowupsBefore);
  });

  it('Test 4 — workspace.attachSession failure is NON-FATAL: session kept, binding persisted, followup runs, logged ungrouped', async () => {
    const resolver = new FakeWorkspaceResolver();
    resolver.failAttachWith = new Error('attach exploded');
    const logger = capturingLogger();
    const { gateway, bridge, bindingStore } = makeBridge({ resolver, logger });

    // Ordinary first message -> create + attach fails, but does NOT reject:
    // the session stays alive, the binding persists, and followup runs.
    await expect(bridge.handleChannelEvent(makeMessageEvent())).resolves.toBeUndefined();

    // Binding WAS persisted — the soft attach failure does not orphan the session.
    const binding = await bindingStore.get('weixin:main:user_123');
    expect(binding).toBeDefined();
    expect(binding?.sessionId).toBe(gateway.createCalls[0]!);

    // Newly created agent is NOT disposed (soft attach keeps the live session).
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.disposed).not.toContain(gateway.createCalls[0]!);

    // Followup still ran for the ordinary message.
    expect(gateway.followups).toHaveLength(1);

    // Error log carries the session/channel/workspace identity + diagnostic fields.
    const errorLog = logger.error.mock.calls.find(
      (c) => c[0] === '[channel-harness] workspace attach failed; keeping session alive',
    );
    expect(errorLog).toBeDefined();
    const fields = errorLog![1] as Record<string, unknown>;
    expect(fields).toBeDefined();
    expect(fields.sessionId).toBe(gateway.createCalls[0]!);
    expect(fields.workspaceId).toBe(resolver.workspace.id);
    expect(fields.requestedCwd).toBe(resolver.cwd);
    expect(fields.error).toMatchObject({ name: 'Error', message: 'attach exploded' });
  });

  it('Test 5 — existing binding + missing persistence recreates the SAME session at the channel workspace cwd, re-attaches, and keeps the binding', async () => {
    const resolver = new FakeWorkspaceResolver();
    const logger = capturingLogger();
    const { gateway, bridge, bindingStore } = makeBridge({ resolver, logger });
    // This fixture models an ephemeral deployment: no session persistence is
    // mounted when the binding is first created.
    gateway.canResumeValue = false;

    // First message -> fresh session on the channel workspace.
    await bridge.handleChannelEvent(makeMessageEvent({ message: { id: 'm1', content: [{ type: 'text', text: 'hello' }] } }));
    const first = gateway.createCalls[0]!;
    expect(gateway.createMetas[first]?.cwd).toBe(resolver.cwd);
    expect(resolver.attachCalls).toEqual([first]);

    // Process restart: the agent is gone from this process and the persisted
    // session is gone too (no sessionPersistence mounted) — only the binding
    // survives.
    gateway.live.clear();
    gateway.canResumeValue = false;

    await bridge.handleChannelEvent(makeMessageEvent({ message: { id: 'm2', content: [{ type: 'text', text: 'again' }] } }));

    // The recreate re-runs the workspace resolver: SAME session id (binding
    // kept, never a fresh id) recreated at the channel workspace cwd, and the
    // workspace re-attached.
    expect(gateway.createCalls).toHaveLength(2);
    const second = gateway.createCalls[1]!;
    expect(second).toBe(first);
    expect(gateway.createMetas[second]?.cwd).toBe(resolver.cwd);
    expect(resolver.attachCalls).toEqual([first, second]);

    // Binding kept pointing at the same session; followup ran.
    const binding = await bindingStore.get('weixin:main:user_123');
    expect(binding?.sessionId).toBe(first);
    expect(gateway.followups).toHaveLength(2);

    // Structured success log carries the workspace/cwd identity.
    const recreatedLog = logger.info.mock.calls.find(
      (c) => c[0] === '[channel-harness] channel session recreated (binding kept)',
    );
    expect(recreatedLog).toBeDefined();
    expect(recreatedLog![1]).toMatchObject({
      sessionId: second,
      channelId: 'weixin',
      workspaceId: resolver.workspace.id,
      cwd: resolver.cwd,
      bindingKey: 'weixin:main:user_123',
    });
  });

  it('Test 6 — existing binding + missing persistence borrows a LIVE session without recreating', async () => {
    const resolver = new FakeWorkspaceResolver();
    const { gateway, bridge } = makeBridge({ resolver });

    await bridge.handleChannelEvent(makeMessageEvent({ message: { id: 'm1', content: [{ type: 'text', text: 'hello' }] } }));
    const first = gateway.createCalls[0]!;
    const followupsBefore = gateway.followups.length;

    // Persistence is missing but the agent is STILL LIVE in this process: the
    // second message must borrow it — no second create, no attach churn.
    gateway.canResumeValue = false;
    await bridge.handleChannelEvent(makeMessageEvent({ message: { id: 'm2', content: [{ type: 'text', text: 'again' }] } }));

    expect(gateway.createCalls).toHaveLength(1);
    expect(resolver.attachCalls).toEqual([first]);
    expect(gateway.followups.length).toBe(followupsBefore + 1);
  });

  it('logs an agent creation failure with enumerable Error fields and cause', async () => {
    const logger = capturingLogger();
    const { gateway, bridge } = makeBridge({ logger });
    gateway.failCreateWith = new Error('agent create exploded', {
      cause: new TypeError('invalid cwd'),
    });

    await expect(bridge.handleChannelEvent(makeMessageEvent())).rejects.toThrow(
      'agent create exploded',
    );

    const errorLog = logger.error.mock.calls.find((call) =>
      String(call[0]).startsWith('[channel-harness] message handling failed for conversation'),
    );
    expect(errorLog?.[1]).toMatchObject({
      name: 'Error',
      message: 'agent create exploded',
      cause: { name: 'TypeError', message: 'invalid cwd' },
    });
  });

  it('disposes a fresh agent when it was not published to the mounted SessionStore', async () => {
    const resolver = new FakeWorkspaceResolver();
    const { gateway, bridge, bindingStore } = makeBridge({ resolver, mountSessions: true });

    await expect(bridge.handleChannelEvent(makeMessageEvent())).rejects.toThrow(
      /absent from ctx\.sessions/,
    );

    const sessionId = gateway.createCalls[0]!;
    expect(gateway.disposed).toContain(sessionId);
    expect(resolver.attachCalls).toHaveLength(0);
    expect(gateway.followups).toHaveLength(0);
    expect(await bindingStore.get('weixin:main:user_123')).toBeUndefined();
  });

  it('handles a message from a caller fiber without sessions injection', async () => {
    const { rootCtx, gateway, bridge } = makeBridge();
    const caller = rootCtx.plugin(async function uninjectedCaller() {
      await bridge.handleChannelEvent(makeMessageEvent());
    });

    await caller.await();

    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.followups).toHaveLength(1);
    await caller.dispose();
  });
});
