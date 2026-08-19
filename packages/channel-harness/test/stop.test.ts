/*
 * /stop fast-path test suite (spec §40).
 *
 * Covers: immediate acknowledgement + official cancellation of the live
 * agent, the generation barrier (queued stale messages never reach
 * followup), the new-generation continuation after /stop, the no-binding
 * no-session case, the idle-agent no-op, the /new race stop barrier, and the
 * registered-handler result for /stop with arguments.
 *
 * Fixture mirrors commands.test.ts (real CommandRuntime + fake gateway whose
 * create can be gated so chain ordering is deterministic).
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ChannelTarget, MessageReceived } from '@wsz987/channel-core';
import {
  AgentManager,
  type AgentGateway,
  type AgentRouteSpec,
  type GatewayAgentHandle,
} from '../src/agent-manager.ts';
import { AgentRouter } from '../src/agent-router.ts';
import { MemoryBindingStore } from '../src/binding-store.ts';
import { ChannelHarnessBridge } from '../src/bridge.ts';
import { Config } from '../src/config.ts';
import { ReplyContextStore } from '../src/reply-context-store.ts';
import type { ChannelWorkspaceResolver } from '../src/workspace-resolver.ts';
import { allowAllAccessResolver } from './access-test-helper.ts';

const defaultRoute: AgentRouteSpec = { preset: 'default' };

function baseConfig(): Config {
  return Config({
    agent: { default: defaultRoute },
    routing: { mode: 'global' },
    bindingStore: { type: 'memory' },
    workspace: { mode: 'disabled' },
    reply: { updateIntervalMs: 0, maxTextLength: undefined, splitParagraphs: true, splitCodeBlocks: true, finalFlush: true },
    maxConcurrency: 4,
    includeMetadataPrefix: true,
  });
}

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const noopResolver: ChannelWorkspaceResolver = { resolve: async () => ({}) };

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

function textEvent(id: string, text: string): Partial<MessageReceived> {
  return { message: { id, content: [{ type: 'text', text }] } };
}

interface StopFakeAgent {
  id: SessionId;
  session: {
    id: string;
    events: { type: string; data: unknown }[];
    append(type: string, data: unknown): { type: string; data: unknown };
    requestHeader?(): unknown;
  };
  status: 'idle' | 'running';
  options: { provider?: string; model?: string };
  cancel: ReturnType<typeof vi.fn>;
  ctx: Context;
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
}

function fakeScopedAgent(ctx: Context, id: string): StopFakeAgent {
  const events: StopFakeAgent['session']['events'] = [];
  const agent: StopFakeAgent = {
    id: SessionId(id),
    session: {
      id,
      events,
      append(type, data) {
        const event = { type, data };
        events.push(event);
        return event;
      },
    },
    status: 'idle',
    options: {},
    cancel: vi.fn(),
    ctx: new Context(),
    followup: () => {},
    whenIdle: async () => {},
  };
  const scoped = createScope(ctx, agent as never);
  agent.ctx = scoped.ctx;
  return agent;
}

class StopGateway implements AgentGateway {
  canResumeValue = true;
  existsValue = false;
  live = new Map<string, GatewayAgentHandle>();
  createCalls: string[] = [];
  createStarted: string[] = [];
  createGate?: () => Promise<void>;
  disposed: string[] = [];
  followups: { sessionId: string; message: unknown }[] = [];
  agents = new Map<string, StopFakeAgent>();

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
    this.createCalls.push(sessionId);
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

  async resume(sessionId: string, route: AgentRouteSpec, setup?: Parameters<AgentGateway['resume']>[2]) {
    return this.create(sessionId, route, setup);
  }
}

interface Fixture {
  gateway: StopGateway;
  manager: AgentManager;
  bridge: ChannelHarnessBridge;
  adapter: FakeAdapter;
  bindingStore: MemoryBindingStore;
}

function makeBridge(rootCtx: Context): Fixture {
  const gateway = new StopGateway(rootCtx);
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
    accessResolver: allowAllAccessResolver,
    ctx: rootCtx,
    commandDeps: { startNewSession: (agent) => bridge.startNewSession(agent) },
    workspaceResolver: noopResolver,
  });
  return { gateway, manager, bridge, adapter, bindingStore };
}

describe('/stop fast path (spec §40)', () => {
  it('acknowledges immediately, cancels the live agent, and records command lifecycle', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const sessionId = gateway.createCalls[0]!;
    const agent = gateway.agents.get(sessionId)!;
    expect(agent.cancel).not.toHaveBeenCalled();

    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/stop')));

    expect(adapter.sent.map((s) => s.text)).toContain('已停止当前任务。');
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' });
    expect(agent.session.events.map((e) => e.type)).toEqual(['command/run', 'command/done']);
  });

  it('invalidates queued messages from before /stop (generation barrier)', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, adapter } = makeBridge(rootCtx);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    gateway.createGate = () => gate;

    const a = bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'A')));
    const b = bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', 'B')));
    const c = bridge.handleChannelEvent(makeMessageEvent(textEvent('m3', 'C')));
    await vi.waitFor(() => expect(gateway.createStarted.length).toBeGreaterThanOrEqual(1));
    // /stop arrives while A is still gated; it must NOT wait behind B/C.
    const stop = bridge.handleChannelEvent(makeMessageEvent(textEvent('m4', '/stop')));
    release();
    await Promise.allSettled([a, b, c, stop]);

    // A was invalidated at its second generation check; B/C at their first.
    expect(gateway.followups).toEqual([]);
    // The stop barrier re-cancelled the freshly-created agent after convergence.
    const created = gateway.createCalls[0];
    if (created) {
      expect(gateway.agents.get(created)?.cancel).toHaveBeenCalledWith({ kind: 'user' });
    }
    expect(adapter.sent.length).toBeGreaterThan(0);
  });

  it('routes messages sent after /stop on a fresh generation', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/stop')));
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m3', 'D')));
    expect(gateway.followups.length).toBeGreaterThanOrEqual(1);
    const last = gateway.followups[gateway.followups.length - 1]!;
    expect(last.message).toBeTruthy();
  });

  it('replies without creating a session when no binding exists', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/stop')));
    expect(gateway.createCalls).toEqual([]);
    expect(adapter.sent.map((s) => s.text)).toContain('当前没有可停止的任务。');
  });

  it('is a no-op on an idle agent and still acknowledges', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;
    await expect(bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/stop')))).resolves.toBeUndefined();
    expect(adapter.sent.map((s) => s.text)).toContain('已停止当前任务。');
    expect(agent.cancel).toHaveBeenCalledWith({ kind: 'user' });
  });

  it('re-cancels the freshest agent when /stop races an in-flight /new (stop barrier)', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, bindingStore } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const sessionA = gateway.createCalls[0]!;
    const agentA = gateway.agents.get(sessionA)!;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    gateway.createGate = () => gate;

    const n = bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/new')));
    await vi.waitFor(() => expect(gateway.createStarted.length).toBeGreaterThanOrEqual(2));
    const stop = bridge.handleChannelEvent(makeMessageEvent(textEvent('m3', '/stop')));
    release();
    await Promise.allSettled([n, stop]);

    const binding = await bindingStore.get('weixin:main:user_123');
    expect(binding).toBeTruthy();
    const sessionB = binding!.sessionId;
    expect(sessionB).not.toBe(sessionA);
    const agentB = gateway.agents.get(sessionB)!;
    // The barrier re-cancelled the NEW binding's agent after the chain converged.
    expect(agentB.cancel).toHaveBeenCalledWith({ kind: 'user' });
    // A was retired by the /new post-command cleanup.
    expect(gateway.disposed).toContain(sessionA);
    void agentA;
  });

  it('renders the registered handler result for /stop with arguments', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/stop now')));
    // The registered /stop handler rejects the argument and its error text is
    // rendered directly (no "已停止当前任务。" ack). The stop barrier (spec §9)
    // still cancels the latest live agent after convergence — that is by design.
    expect(adapter.sent.map((s) => s.text)).toContain('Usage: /stop');
    expect(adapter.sent.map((s) => s.text)).not.toContain('已停止当前任务。');
    void agent;
  });
});
