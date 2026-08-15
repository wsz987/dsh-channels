/*
 * Command-plane test suite (plan §27, specs A–L).
 *
 * Exercises the official @deepseek-ai/dsh-commands command plane wired into
 * the channel bridge: parseCommand admission, direct CommandResult rendering,
 * the Agent-scoped /new flow (fresh session, binding switch, busy guard,
 * rollback, bootstrap, repeated /new, serialization), unknown-command
 * rejection, global-command passthrough, and multi-channel / multi-conversation
 * isolation.
 *
 * Fake design notes:
 * - Each test mounts the REAL registry: `new CommandRuntime(ctx)` makes
 *   ctx.commands available. The fake gateway mints a scoped agent context via
 *   createScope(ctx, agent) (the agent object IS the dsh-scope key), so
 *   agent-scoped command registrations resolve through the official runtime.
 * - The real CommandRuntime.execute() appends command/run + command/done to
 *   agent.session synchronously, so each fake agent carries a fake session
 *   implementing append(type, data).
 * - The fake gateway INVOKES the optional setup on create/resume so the owned
 *   path gets channel commands installed; the borrowed path is covered by
 *   AgentManager.ensureBorrowedSetup (asserted exactly once).
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import CommandRuntime, { parseCommand } from '@deepseek-ai/dsh-commands';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SessionId } from '@deepseek-ai/dsh-session';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { ChannelTarget, MessageReceived } from '@wsz987/channel-core';
import {
  AgentManager,
  HarnessAgentGateway,
  type AgentGateway,
  type AgentRouteSpec,
  type GatewayAgentHandle,
} from '../src/agent-manager.ts';
import { AgentRouter } from '../src/agent-router.ts';
import { MemoryBindingStore } from '../src/binding-store.ts';
import { ChannelHarnessBridge } from '../src/bridge.ts';
import { Config } from '../src/config.ts';
import { installChannelCommands } from '../src/commands/index.ts';
import { ReplyContextStore } from '../src/reply-context-store.ts';
import type { ChannelWorkspaceResolver } from '../src/workspace-resolver.ts';

const defaultRoute: AgentRouteSpec = { preset: 'default' };

function baseConfig(overrides: Partial<Config> = {}): Config {
  return Config({
    agent: { default: defaultRoute },
    routing: {
      mode: 'global',
      overrides: { channel: { weixin: { model: 'weixin-agent' } } },
    },
    bindingStore: { type: 'memory' },
    workspace: { mode: 'disabled' },
    reply: { updateIntervalMs: 0, maxTextLength: undefined, splitParagraphs: true, splitCodeBlocks: true, finalFlush: true },
    maxConcurrency: 4,
    includeMetadataPrefix: true,
    ...overrides,
  });
}

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Hermetic no-op workspace resolver: no workspace, no cwd (bridge falls back to config.cwd ?? process.cwd()). */
const noopResolver: ChannelWorkspaceResolver = {
  resolve: async () => ({}),
};

class FakeAdapter {
  id: string;
  capabilities = { text: true, image: false, file: false, audio: false, video: false, markdown: true, cards: false, reactions: false, threads: false, streaming: 'buffered' } as const;
  sent: { text?: string }[] = [];
  targets: ChannelTarget[] = [];
  constructor(id = 'fake') { this.id = id; }
  async start() {}
  async stop() {}
  async send(target: ChannelTarget, message: { text?: string }) {
    this.targets.push(target);
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
    message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] },
    ...overrides,
  };
}

interface FakeSessionLog {
  id: string;
  events: { type: string; data: unknown; seq: number; time: number }[];
  append(type: string, data: unknown): { type: string; data: unknown; seq: number; time: number };
}

export interface CommandFakeAgent {
  id: SessionId;
  session: FakeSessionLog;
  status: 'idle' | 'running';
  ctx: Context;
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
}

/** Mint a fake agent under a real scoped context (the agent object is the scope key). */
function fakeScopedAgent(ctx: Context, id: string): CommandFakeAgent {
  const events: FakeSessionLog['events'] = [];
  const agent: CommandFakeAgent = {
    id: SessionId(id),
    session: {
      id,
      events,
      append(type, data) {
        const event = { type, data, seq: events.length, time: Date.now() };
        events.push(event);
        return event;
      },
    },
    status: 'idle',
    ctx: new Context(),
    followup: () => {},
    whenIdle: async () => {},
  };
  const scoped = createScope(ctx, agent as never);
  agent.ctx = scoped.ctx;
  return agent;
}

class CommandGateway implements AgentGateway {
  canResumeValue = true;
  existsValue = false;
  live = new Map<string, GatewayAgentHandle>();
  createCalls: string[] = [];
  createRoutes: (AgentRouteSpec | undefined)[] = [];
  disposed: string[] = [];
  followups: { sessionId: string; message: unknown }[] = [];
  agents = new Map<string, CommandFakeAgent>();
  failCreateWith?: Error;
  createGate?: () => Promise<void>;
  createStarted: string[] = [];

  constructor(private readonly rootCtx: Context) {}

  get(sessionId: string) {
    const handle = this.live.get(sessionId);
    if (!handle) return undefined;
    return { id: handle.id, agent: handle.agent, followup: handle.followup, whenIdle: handle.whenIdle };
  }
  canResume(): boolean { return this.canResumeValue; }
  async exists(): Promise<boolean> { return this.existsValue; }

  async create(sessionId: string, route: AgentRouteSpec, setup?: Parameters<AgentGateway['create']>[2]) {
    this.createStarted.push(sessionId);
    if (this.createGate) await this.createGate();
    if (this.failCreateWith) throw this.failCreateWith;
    this.createCalls.push(sessionId);
    this.createRoutes.push(route);
    return this.makeHandle(sessionId, setup);
  }

  async resume(sessionId: string, route: AgentRouteSpec, setup?: Parameters<AgentGateway['resume']>[2]) {
    this.createCalls.push(sessionId);
    this.createRoutes.push(route);
    return this.makeHandle(sessionId, setup);
  }

  private async makeHandle(sessionId: string, setup?: Parameters<AgentGateway['create']>[2]): Promise<GatewayAgentHandle> {
    const agent = fakeScopedAgent(this.rootCtx, sessionId);
    if (setup) {
      const commit = await setup(agent.ctx);
      commit?.commit();
    }
    this.agents.set(sessionId, agent);
    const handle: GatewayAgentHandle = {
      id: sessionId,
      agent: agent as never,
      followup: (message) => { this.followups.push({ sessionId, message }); },
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

interface BridgeFixture {
  gateway: CommandGateway;
  manager: AgentManager;
  bridge: ChannelHarnessBridge;
  adapter: FakeAdapter;
  bindingStore: MemoryBindingStore;
}

function makeBridge(
  rootCtx: Context,
  config: Config = baseConfig(),
  workspaceResolver: ChannelWorkspaceResolver = noopResolver,
): BridgeFixture {
  const gateway = new CommandGateway(rootCtx);
  const manager = new AgentManager(gateway, silentLogger, 4);
  const adapter = new FakeAdapter('weixin');
  const bindingStore = new MemoryBindingStore();
  let bridge!: ChannelHarnessBridge;
  bridge = new ChannelHarnessBridge({
    config,
    bindingStore,
    agentManager: manager,
    agentRouter: new AgentRouter(config),
    getAdapter: () => adapter as never,
    replyContexts: new ReplyContextStore(),
    logger: silentLogger,
    ctx: rootCtx,
    commandDeps: { startNewSession: (agent) => bridge.startNewSession(agent) },
    workspaceResolver,
  });
  return { gateway, manager, bridge, adapter, bindingStore };
}

function textEvent(id: string, text: string): Partial<MessageReceived> {
  return { message: { id, content: [{ type: 'text', text }] } };
}

/**
 * Build a bridge over the REAL HarnessAgentGateway + AgentRegistry with a
 * capturing self-registering stub factory, so we can assert the honest cwd /
 * default-model / preset contract on the fresh session /new mints. The stub
 * factory mints a scoped agent context, runs setup+commit, and registers the
 * agent so the bridge's borrowed `get()` path stays live — mirroring the real
 * agent-loop factory.
 */
function makeRealGatewayBridge(defaultSelection?: { provider: string; model: string } | undefined) {
  const rootCtx = new Context();
  new CommandRuntime(rootCtx);
  const agents = new AgentRegistry(rootCtx);
  if (defaultSelection) {
    rootCtx.provide('agentDefaultModel', { currentSelection: () => defaultSelection });
  }
  const created: { kind: 'create' | 'resume'; meta?: Record<string, unknown>; options?: Record<string, unknown> }[] = [];
  const makeAgent = (id: string): CommandFakeAgent => {
    const agent = fakeScopedAgent(rootCtx, id);
    return agent;
  };
  const registerAndReturn = async (agent: CommandFakeAgent, setup: unknown, meta: Record<string, unknown>, options: Record<string, unknown>) => {
    if (setup) {
      const commit = await (setup as (c: Context) => Promise<{ commit(): void } | void> | { commit(): void } | void)(agent.ctx);
      commit?.commit();
    }
    agents.register(agent as never);
    return { agent: agent as never, dispose: async () => {} };
  };
  agents.setFactory({
    async createAgent(_owner, options) {
      const flat = { ...options };
      created.push({ kind: 'create', meta: (flat.meta ?? {}) as Record<string, unknown>, options: (flat.agentOptions ?? {}) as Record<string, unknown> });
      const agent = makeAgent(String(options.sessionId));
      return registerAndReturn(agent, options.setup, (flat.meta ?? {}) as Record<string, unknown>, (flat.agentOptions ?? {}) as Record<string, unknown>);
    },
    async resume(_owner, options) {
      created.push({ kind: 'resume', options: (options.agentOptions ?? {}) as Record<string, unknown> });
      const agent = makeAgent(String(options.resumeSessionId));
      return registerAndReturn(agent, options.setup, {}, (options.agentOptions ?? {}) as Record<string, unknown>);
    },
  } as never);
  const gateway = new HarnessAgentGateway(rootCtx);
  const manager = new AgentManager(gateway, silentLogger, 4);
  const adapter = new FakeAdapter('weixin');
  const bindingStore = new MemoryBindingStore();
  let bridge!: ChannelHarnessBridge;
  bridge = new ChannelHarnessBridge({
    config: baseConfig(),
    bindingStore,
    agentManager: manager,
    agentRouter: new AgentRouter(baseConfig()),
    getAdapter: () => adapter as never,
    replyContexts: new ReplyContextStore(),
    logger: silentLogger,
    ctx: rootCtx,
    commandDeps: { startNewSession: (agent) => bridge.startNewSession(agent) },
    workspaceResolver: noopResolver,
  });
  return { rootCtx, agents, gateway, manager, bridge, adapter, bindingStore, created };
}

describe('A. official dsh-commands compatibility', () => {
  it('parseCommand recognizes /new, rejects non-commands, and is case-sensitive', () => {
    expect(parseCommand('/new')).toEqual({ name: 'new', rawInput: '' });
    expect(parseCommand('hello')).toBeUndefined();
    expect(parseCommand('/New')).toBeUndefined();
    expect(parseCommand('/foo bar')).toEqual({ name: 'foo', rawInput: ' bar' });
  });

  it('CommandRuntime registers, lists, finds, and executes a scoped command', async () => {
    const ctx = new Context();
    new CommandRuntime(ctx);
    const agent = fakeScopedAgent(ctx, 's1');
    const disposer = agent.ctx.commands.register({
      name: 'new',
      description: 'Start a new channel session',
      handler: async () => ({ kind: 'success', text: 'ok' }),
    });
    expect(ctx.commands.find(agent as never, 'new')).toBeDefined();
    expect(ctx.commands.list(agent as never).map((d) => d.name)).toContain('new');
    const execution = await ctx.commands.execute(agent as never, '/new', new AbortController().signal);
    expect(execution?.result).toEqual({ kind: 'success', text: 'ok' });
    expect(agent.session.events.map((e) => e.type)).toEqual(['command/run', 'command/done']);
    disposer();
  });

  it('commands.execute returns undefined for an unknown command (no lifecycle events)', async () => {
    const ctx = new Context();
    new CommandRuntime(ctx);
    const agent = fakeScopedAgent(ctx, 's1');
    const execution = await ctx.commands.execute(agent as never, '/nope', new AbortController().signal);
    expect(execution).toBeUndefined();
    expect(agent.session.events).toEqual([]);
  });

  it('installs Agent-scoped commands from a caller fiber without commands injection', async () => {
    const ctx = new Context();
    new CommandRuntime(ctx);
    const agent = fakeScopedAgent(ctx, 's-injected');
    const caller = ctx.plugin(async function uninjectedCaller() {
      await installChannelCommands(agent.ctx, { startNewSession: async () => {} });
    });

    await caller.await();

    expect(ctx.commands.find(agent as never, 'new')).toBeDefined();
    await caller.dispose();
  });
});
describe('B. ordinary message regression', () => {
  it('sends hello to toHarnessUserMessage -> followup with no adapter send and no command events', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.followups).toHaveLength(1);
    expect(adapter.sent).toEqual([]);
    const agent = gateway.agents.get(gateway.createCalls[0]!);
    expect(agent?.session.events.filter((e) => e.type === 'command/run' || e.type === 'command/done')).toEqual([]);
  });

  it('a slash-looking line that is not a valid command parses as ordinary text', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/Foo args')));
    expect(gateway.followups).toHaveLength(1);
    expect(adapter.sent).toEqual([]);
  });
});

describe('C. /new flow', () => {
  it('creates B !== A, switches the binding, routes the next message to B, and records A lifecycle', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, adapter, bindingStore } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const A = gateway.createCalls[0]!;
    const aAgent = gateway.agents.get(A)!;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/new')));
    const B = gateway.createCalls[1]!;
    expect(B).not.toBe(A);
    expect(adapter.sent.map((s) => s.text)).toContain('已开启新会话。');
    expect(gateway.followups).toHaveLength(1); // only the original hello
    expect(aAgent.session.events.map((e) => e.type)).toEqual(['command/run', 'command/done']);
    const binding = await bindingStore.get('weixin:main:user_123');
    expect(binding?.sessionId).toBe(B);
    // Next ordinary message routes to B.
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m3', 'more')));
    expect(gateway.followups[gateway.followups.length - 1]!.sessionId).toBe(B);
  });

  it('resolves the same route for B as it did for A (route propagation)', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/new')));
    expect(gateway.createRoutes[0]).toEqual({ model: 'weixin-agent' });
    expect(gateway.createRoutes[1]).toEqual({ model: 'weixin-agent' });
  });

  it('fresh /new session inherits cwd from the Harness process (real gateway captures)', async () => {
    const { bridge, created } = makeRealGatewayBridge();
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/new')));
    expect(created).toHaveLength(2);
    expect((created[1]?.meta as { cwd?: string })?.cwd).toBe(process.cwd());
    expect((created[0]?.meta as { cwd?: string })?.cwd).toBe(process.cwd());
  });

  it('fresh /new session uses the default model when the route omits it (real gateway)', async () => {
    const { bridge, created } = makeRealGatewayBridge({ provider: 'deepseek', model: 'deepseek-chat' });
    const larkEvent = makeMessageEvent({ channel: 'lark' as never, conversation: { id: 'user_123', type: 'dm' }, ...textEvent('m1', 'hello') });
    await bridge.handleChannelEvent(larkEvent);
    await bridge.handleChannelEvent(makeMessageEvent({ channel: 'lark' as never, conversation: { id: 'user_123', type: 'dm' }, ...textEvent('m2', '/new') }));
    const lastTwo = created.slice(-2);
    for (const entry of lastTwo) {
      expect((entry.options as { model?: string; provider?: string })?.model).toBe('deepseek-chat');
    }
  });

  it('honors an explicitly pinned model on /new (never overridden)', async () => {
    const { bridge, created } = makeRealGatewayBridge({ provider: 'deepseek', model: 'deepseek-chat' });
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/new')));
    expect(created).toHaveLength(2);
    for (const entry of created) {
      expect((entry.options as { model?: string })?.model).toBe('weixin-agent');
    }
  });

  it('preset flows into meta.agentPreset on the fresh /new session (real gateway)', async () => {
    const { bridge, created } = makeRealGatewayBridge();
    const ev1 = makeMessageEvent({ channel: 'lark' as never, conversation: { id: 'user_123', type: 'dm' }, ...textEvent('m1', 'hello') });
    const ev2 = makeMessageEvent({ channel: 'lark' as never, conversation: { id: 'user_123', type: 'dm' }, ...textEvent('m2', '/new') });
    await bridge.handleChannelEvent(ev1);
    await bridge.handleChannelEvent(ev2);
    const lastTwo = created.slice(-2);
    expect(lastTwo).toHaveLength(2);
    for (const entry of lastTwo) {
      expect((entry.meta as { agentPreset?: string })?.agentPreset).toBe('default');
    }
  });

  it('pushes the routing preset to a preset-carrying route over /new (real gateway)', async () => {
    const { bridge, created } = makeRealGatewayBridge();
    await bridge.handleChannelEvent(makeMessageEvent({ channel: 'lark' as never, conversation: { id: 'user_123', type: 'dm' }, ...textEvent('m1', 'hello') }));
    await bridge.handleChannelEvent(makeMessageEvent({ channel: 'lark' as never, conversation: { id: 'user_123', type: 'dm' }, ...textEvent('m2', '/new') }));
    const lastTwo = created.slice(-2);
    for (const entry of lastTwo) {
      expect((entry.meta as { agentPreset?: string })?.agentPreset).toBe('default');
    }
  });
});

describe('C2. archived binding rollover', () => {
  it('routes the next ordinary message into a fresh visible session', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const archived = new Set<string>();
    const resolver: ChannelWorkspaceResolver = {
      resolve: async () => ({}),
      isSessionArchived: (sessionId) => archived.has(sessionId),
    };
    const { gateway, bridge, bindingStore } = makeBridge(rootCtx, baseConfig(), resolver);

    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const A = gateway.createCalls[0]!;
    archived.add(A);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', 'after archive')));

    const B = gateway.createCalls[1]!;
    expect(B).not.toBe(A);
    expect(gateway.followups.map((entry) => entry.sessionId)).toEqual([A, B]);
    expect(gateway.disposed).toContain(A);
    expect((await bindingStore.get('weixin:main:user_123'))?.sessionId).toBe(B);
  });

  it('handles /new on an archived binding without resuming the hidden session', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const archived = new Set<string>();
    const resolver: ChannelWorkspaceResolver = {
      resolve: async () => ({}),
      isSessionArchived: (sessionId) => archived.has(sessionId),
    };
    const { gateway, bridge, adapter, bindingStore } = makeBridge(rootCtx, baseConfig(), resolver);

    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const A = gateway.createCalls[0]!;
    archived.add(A);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/new')));

    const B = gateway.createCalls[1]!;
    expect(B).not.toBe(A);
    expect(gateway.followups).toHaveLength(1);
    expect(gateway.disposed).toContain(A);
    expect(adapter.sent.map((entry) => entry.text)).toContain('已开启新会话。');
    expect((await bindingStore.get('weixin:main:user_123'))?.sessionId).toBe(B);
  });

  it('preserves the archived binding when replacement creation fails', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const archived = new Set<string>();
    const resolver: ChannelWorkspaceResolver = {
      resolve: async () => ({}),
      isSessionArchived: (sessionId) => archived.has(sessionId),
    };
    const { gateway, bridge, bindingStore } = makeBridge(rootCtx, baseConfig(), resolver);

    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const A = gateway.createCalls[0]!;
    archived.add(A);
    gateway.failCreateWith = new Error('replacement failed');

    await expect(
      bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', 'after archive'))),
    ).rejects.toThrow('replacement failed');
    expect((await bindingStore.get('weixin:main:user_123'))?.sessionId).toBe(A);
    expect(gateway.disposed).not.toContain(A);
  });
});

describe('D. /new busy guard', () => {
  it('returns the busy error, keeps binding A, and creates no B when the agent is running', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, adapter, bindingStore } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const A = gateway.createCalls[0]!;
    (gateway.agents.get(A) as unknown as { status: string }).status = 'running';
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/new')));
    expect(adapter.sent.map((s) => s.text)).toContain('当前会话仍在运行，请稍后再执行 /new。');
    expect(gateway.createCalls).toHaveLength(1);
    const binding = await bindingStore.get('weixin:main:user_123');
    expect(binding?.sessionId).toBe(A);
  });
});

describe('E. rollback', () => {
  it('disposes the fresh session and preserves binding A when the binding write fails', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const gateway = new CommandGateway(rootCtx);
    const manager = new AgentManager(gateway, silentLogger, 4);
    const adapter = new FakeAdapter('weixin');
    const bindingStore = new FailingPutAfterFirstStore();
    let bridge!: ChannelHarnessBridge;
    bridge = new ChannelHarnessBridge({
      config: baseConfig(),
      bindingStore,
      agentManager: manager,
      agentRouter: new AgentRouter(baseConfig()),
      getAdapter: () => adapter as never,
      replyContexts: new ReplyContextStore(),
      logger: silentLogger,
      ctx: rootCtx,
      commandDeps: { startNewSession: (agent) => bridge.startNewSession(agent) },
      workspaceResolver: noopResolver,
    });
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const A = gateway.createCalls[0]!;
    bindingStore.failNext = true;
    await expect(bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/new')))).rejects.toThrow(/store write failed/);
    expect(gateway.disposed).toContain(gateway.createCalls[1]!);
    const binding = await bindingStore.get('weixin:main:user_123');
    expect(binding?.sessionId).toBe(A);
  });

  it('leaves binding A untouched when agent creation itself fails', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const gateway = new CommandGateway(rootCtx);
    const manager = new AgentManager(gateway, silentLogger, 4);
    const adapter = new FakeAdapter('weixin');
    const bindingStore = new MemoryBindingStore();
    let bridge!: ChannelHarnessBridge;
    bridge = new ChannelHarnessBridge({
      config: baseConfig(),
      bindingStore,
      agentManager: manager,
      agentRouter: new AgentRouter(baseConfig()),
      getAdapter: () => adapter as never,
      replyContexts: new ReplyContextStore(),
      logger: silentLogger,
      ctx: rootCtx,
      commandDeps: { startNewSession: (agent) => bridge.startNewSession(agent) },
      workspaceResolver: noopResolver,
    });
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const A = gateway.createCalls[0]!;
    gateway.failCreateWith = new Error('agent create exploded');
    await expect(bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/new')))).rejects.toThrow(/agent create exploded/);
    const binding = await bindingStore.get('weixin:main:user_123');
    expect(binding?.sessionId).toBe(A);
  });
});
/** Binding store that fails exactly on the configured put (used for rollback). */
class FailingPutAfterFirstStore implements SessionBindingStore {
  private readonly inner = new MemoryBindingStore();
  failNext = false;
  get(key: string) { return this.inner.get(key); }
  delete(key: string) { return this.inner.delete(key); }
  async put(binding: Parameters<SessionBindingStore['put']>[0]) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('store write failed');
    }
    return this.inner.put(binding);
  }
}

describe('F. command result rendering', () => {
  it('delivers success and error CommandResults via the adapter, never via followup', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const beforeFollowups = gateway.followups.length;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/new')));
    expect(adapter.sent.map((s) => s.text)).toContain('已开启新会话。');
    const current = gateway.createCalls[gateway.createCalls.length - 1]!;
    (gateway.agents.get(current) as unknown as { status: string }).status = 'running';
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m3', '/new')));
    expect(adapter.sent.map((s) => s.text)).toContain('当前会话仍在运行，请稍后再执行 /new。');
    expect(gateway.followups.length).toBe(beforeFollowups);
  });

  it('preserves message-scoped reply context for direct command replies', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { bridge, adapter } = makeBridge(rootCtx);
    const raw = { sessionWebhook: 'https://example.dingtalk.com/session/reply' };

    await bridge.handleChannelEvent(makeMessageEvent({
      ...textEvent('m1', '/not-exist'),
      raw,
    }));

    expect(adapter.targets).toHaveLength(1);
    expect(adapter.targets[0]?.raw).toBe(raw);
  });
});

describe('G. unknown command', () => {
  it('rejects an unregistered command and never calls followup', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const before = gateway.followups.length;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/not-exist')));
    expect(adapter.sent.map((s) => s.text)).toContain('未知指令：/not-exist');
    expect(gateway.followups.length).toBe(before);
  });
});

describe('H. other registered (global) commands', () => {
  it('routes a registered global command through the same channel plane', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    rootCtx.commands.register({
      name: 'compact',
      description: 'x',
      handler: () => ({ kind: 'success', text: 'compacted' }),
    });
    const { gateway, bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const before = gateway.followups.length;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/compact')));
    expect(adapter.sent.map((s) => s.text)).toContain('compacted');
    expect(gateway.followups.length).toBe(before);
  });
});

describe('I. multi-channel sharing one command plane', () => {
  it('routes /new for weixin/qq/dingtalk/lark through the SAME bridge', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const gateway = new CommandGateway(rootCtx);
    const manager = new AgentManager(gateway, silentLogger, 4);
    const adapters: Record<string, FakeAdapter> = {
      weixin: new FakeAdapter('weixin'),
      qq: new FakeAdapter('qq'),
      dingtalk: new FakeAdapter('dingtalk'),
      lark: new FakeAdapter('lark'),
    };
    const bindingStore = new MemoryBindingStore();
    let bridge!: ChannelHarnessBridge;
    bridge = new ChannelHarnessBridge({
      config: baseConfig(),
      bindingStore,
      agentManager: manager,
      agentRouter: new AgentRouter(baseConfig()),
      getAdapter: (id) => adapters[id] as never,
      replyContexts: new ReplyContextStore(),
      logger: silentLogger,
      ctx: rootCtx,
      commandDeps: { startNewSession: (agent) => bridge.startNewSession(agent) },
      workspaceResolver: noopResolver,
    });
    for (const channel of ['weixin', 'qq', 'dingtalk', 'lark'] as const) {
      await bridge.handleChannelEvent(makeMessageEvent({ channel, conversation: { id: 'c-' + channel, type: 'dm' }, accountId: 'main', ...textEvent('1', 'hi') }));
      await bridge.handleChannelEvent(makeMessageEvent({ channel, conversation: { id: 'c-' + channel, type: 'dm' }, accountId: 'main', ...textEvent('2', '/new') }));
    }
    for (const channel of ['weixin', 'qq', 'dingtalk', 'lark'] as const) {
      expect(adapters[channel].sent.map((s) => s.text)).toContain('已开启新会话。');
      const b = await bindingStore.get('' + channel + ':main:c-' + channel);
      expect(b?.sessionId).toBeTruthy();
    }
    expect(gateway.createCalls).toHaveLength(8);
  });
});

describe('J. concurrency / serialization', () => {
  it('serializes /new before the next message on the SAME conversation', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, bindingStore } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hi')));
    const A = gateway.createCalls[0]!;
    await Promise.all([
      bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/new'))),
      bridge.handleChannelEvent(makeMessageEvent(textEvent('m3', 'hello'))),
    ]);
    const binding = await bindingStore.get('weixin:main:user_123');
    expect(binding?.sessionId).not.toBe(A);
    const last = gateway.followups[gateway.followups.length - 1]!;
    expect(last.sessionId).toBe(binding?.sessionId);
    void A;
  });

  it('runs different conversations in parallel (gated create shows interleaving)', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const gateway = new CommandGateway(rootCtx);
    const manager = new AgentManager(gateway, silentLogger, 4);
    const adapter = new FakeAdapter('weixin');
    const bindingStore = new MemoryBindingStore();
    let bridge!: ChannelHarnessBridge;
    bridge = new ChannelHarnessBridge({
      config: baseConfig(),
      bindingStore,
      agentManager: manager,
      agentRouter: new AgentRouter(baseConfig()),
      getAdapter: () => adapter as never,
      replyContexts: new ReplyContextStore(),
      logger: silentLogger,
      ctx: rootCtx,
      commandDeps: { startNewSession: (agent) => bridge.startNewSession(agent) },
      workspaceResolver: noopResolver,
    });
    // Hold every create behind one gate so we can observe BOTH conversations enter
    // create before either finishes — proving distinct conversations run in parallel
    // (no global mutex serializes them).
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    gateway.createGate = () => gate;
    const a = bridge.handleChannelEvent(makeMessageEvent({ channel: 'weixin', conversation: { id: 'convA', type: 'dm' }, ...textEvent('1', 'hi') }));
    const b = bridge.handleChannelEvent(makeMessageEvent({ channel: 'qq', conversation: { id: 'convB', type: 'dm' }, ...textEvent('1', 'hi') }));
    await vi.waitFor(() => {
      expect(gateway.createStarted.length).toBeGreaterThanOrEqual(2);
    });
    // Both creates are in flight at once (they are NOT serialized).
    expect(gateway.createStarted.length).toBeGreaterThanOrEqual(2);
    release();
    await Promise.all([a, b]);
    const aBinding = await bindingStore.get('weixin:main:convA');
    const bBinding = await bindingStore.get('qq:main:convB');
    expect(aBinding?.sessionId).toBeTruthy();
    expect(bBinding?.sessionId).toBeTruthy();
    expect(aBinding?.sessionId).not.toBe(bBinding?.sessionId);
  });
});

describe('K. repeated /new', () => {
  it('A -> B -> C -> D with old owned agents disposed and history preserved', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, bindingStore } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('1', 'hi')));
    const A = gateway.createCalls[0]!;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('2', '/new')));
    const B = gateway.createCalls[1]!;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('3', '/new')));
    const C = gateway.createCalls[2]!;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('4', '/new')));
    const D = gateway.createCalls[3]!;
    expect(new Set([A, B, C, D]).size).toBe(4);
    const binding = await bindingStore.get('weixin:main:user_123');
    expect(binding?.sessionId).toBe(D);
    expect(gateway.disposed).toEqual(expect.arrayContaining([A, B, C]));
    expect(gateway.live.has(D)).toBe(true);
    expect(await bindingStore.get('weixin:main:user_123')).toBeTruthy();
  });
});

describe('L. bootstrap', () => {
  it('creates exactly one session for a first-message /new and replies', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, adapter, bindingStore } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/new')));
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.followups).toEqual([]);
    expect(adapter.sent.map((s) => s.text)).toContain('已开启新会话。');
    const binding = await bindingStore.get('weixin:main:user_123');
    expect(binding?.sessionId).toBe(gateway.createCalls[0]!);
  });
});

describe('AgentManager borrowed setup runs exactly once', () => {
  it('does not duplicate-register channel commands on a second resolve of the same live agent', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const gateway = new CommandGateway(rootCtx);
    const initial = createScope(rootCtx, {} as never);
    const agent: CommandFakeAgent = {
      id: SessionId('borrowed'),
      session: { id: 'borrowed', events: [], append(type, data) { const e = { type, data, seq: this.events.length, time: Date.now() }; this.events.push(e); return e; } },
      status: 'idle',
      ctx: initial.ctx,
      followup: () => {},
      whenIdle: async () => {},
    };
    const resealed = createScope(rootCtx, agent as never);
    agent.ctx = resealed.ctx;
    let setupCount = 0;
    gateway.live.set('borrowed', {
      id: 'borrowed',
      agent: agent as never,
      followup: () => {},
      whenIdle: async () => {},
      dispose: async () => { gateway.live.delete('borrowed'); },
    });
    const manager = new AgentManager(gateway, silentLogger, 4);
    const setup = () => { setupCount += 1; };
    const r1 = await manager.resolve('borrowed', defaultRoute, setup as never);
    const r2 = await manager.resolve('borrowed', defaultRoute, setup as never);
    expect(setupCount).toBe(1);
    expect(r1.sessionId).toBe('borrowed');
    expect(r2.sessionId).toBe('borrowed');
  });
});
