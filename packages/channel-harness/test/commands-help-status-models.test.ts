/*
 * /help, /status and /models coverage (spec §44-§45).
 *
 * /help reads the effective command view live from the official registry.
 * /status is pure Human Plane (session identity + lifecycle + model block).
 * /models uses a REAL LlmRuntime mounted on the root context with a small fake
 * adapter, so the advisory-catalog and per-provider-failure semantics are the
 * genuine rc.6 behavior.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import { LlmAdapter, LlmRuntime, ReasoningEffortId, type StreamChunk } from '@deepseek-ai/dsh-llm';
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
import { ChannelModelSelectionController } from '../src/model-selection.ts';
import type { ChannelWorkspaceResolver } from '../src/workspace-resolver.ts';

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

interface HsmFakeAgent {
  id: SessionId;
  session: {
    id: string;
    events: { type: string; data: unknown }[];
    append(type: string, data: unknown): { type: string; data: unknown };
    requestHeader?(): { config: { provider: string; model: string; reasoningEffort?: string } } | undefined;
  };
  status: 'idle' | 'running';
  options: { provider?: string; model?: string };
  cancel: ReturnType<typeof vi.fn>;
  ctx: Context;
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
}

function fakeScopedAgent(ctx: Context, id: string): HsmFakeAgent {
  const events: HsmFakeAgent['session']['events'] = [];
  const agent: HsmFakeAgent = {
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

class HsmGateway implements AgentGateway {
  canResumeValue = true;
  existsValue = false;
  live = new Map<string, GatewayAgentHandle>();
  createCalls: string[] = [];
  createStarted: string[] = [];
  disposed: string[] = [];
  followups: { sessionId: string; message: unknown }[] = [];
  agents = new Map<string, HsmFakeAgent>();

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

/** Minimal provider table: models + optional listing failure + optional reasoning efforts. */
type ProviderTable = Record<string, {
  models: { id: string; name: string }[];
  failListing?: boolean;
  reasoningEfforts?: string[];
}>;

class FakeLlmAdapter extends LlmAdapter {
  constructor(private readonly table: ProviderTable) { super(); }
  listModels(provider: string): Promise<{ provider: string; id: string; name: string }[]> {
    const entry = this.table[provider];
    if (!entry) return Promise.resolve([]);
    if (entry.failListing) return Promise.reject(new Error('listing exploded'));
    // LlmRuntime.listModels validates catalog rows: every row must carry the
    // owning provider route (LlmModelInfo.provider).
    return Promise.resolve(entry.models.map((m) => ({ ...m, provider })));
  }
  resolveModel(provider: string, model: string) {
    const entry = this.table[provider];
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...(entry?.reasoningEfforts
        ? { reasoning: { efforts: entry.reasoningEfforts.map((id) => ({ id: ReasoningEffortId(id), name: id })) } }
        : {}),
    });
  }
  async *stream(): AsyncGenerator<StreamChunk> {
    return;
  }
}

interface Fixture {
  gateway: HsmGateway;
  manager: AgentManager;
  bridge: ChannelHarnessBridge;
  adapter: FakeAdapter;
  bindingStore: MemoryBindingStore;
  modelSelection: ChannelModelSelectionController;
}

function makeBridge(rootCtx: Context, modelSelection?: ChannelModelSelectionController): Fixture {
  const gateway = new HsmGateway(rootCtx);
  const manager = new AgentManager(gateway, silentLogger, 4);
  const adapter = new FakeAdapter('weixin');
  const bindingStore = new MemoryBindingStore();
  const selection = modelSelection ?? new ChannelModelSelectionController(rootCtx);
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
    commandDeps: { startNewSession: (agent) => bridge.startNewSession(agent), modelSelection: selection },
    workspaceResolver: noopResolver,
  });
  return { gateway, manager, bridge, adapter, bindingStore, modelSelection: selection };
}

function lastSent(adapter: FakeAdapter): string {
  return adapter.sent[adapter.sent.length - 1]?.text ?? '';
}

describe('/help (spec §44)', () => {
  it('lists channel commands and global plugin commands; a first-message /help creates one session', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    rootCtx.commands.register({
      name: 'compact',
      description: 'Compact older conversation history',
      handler: () => ({ kind: 'success', text: 'compacted' }),
    });
    const { gateway, bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/help')));
    const out = lastSent(adapter);
    for (const name of ['/stop', '/new', '/help', '/status', '/models', '/model']) {
      expect(out).toContain(name);
    }
    expect(out).toContain('/compact');
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.followups).toEqual([]);
  });

  it('reflects dynamic registration and disposal of global commands', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/help')));
    const dispose = rootCtx.commands.register({
      name: 'feedback',
      description: 'record feedback',
      handler: () => ({ kind: 'success', text: 'ok' }),
    });
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/help')));
    expect(lastSent(adapter)).toContain('/feedback');
    dispose();
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m3', '/help')));
    expect(lastSent(adapter)).not.toContain('/feedback');
  });

  it('shows usage for one command and errors on unknown names', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/help')));
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/help model')));
    expect(lastSent(adapter)).toContain('/model');
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m3', '/help nope')));
    expect(lastSent(adapter)).toContain('未知指令：/nope');
  });
});

describe('/status (spec §14)', () => {
  it('shows session id and lifecycle status without a model block when nothing is resolvable', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const sessionId = gateway.createCalls[0]!;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/status')));
    const out = lastSent(adapter);
    expect(out).toContain('ID: ' + sessionId);
    expect(out).toContain('Status: idle');
  });

  it('shows the picked model selection in the model block', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, adapter, modelSelection } = makeBridge(rootCtx, new ChannelModelSelectionController(rootCtx));
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;
    await modelSelection.select(agent as never, { provider: 'openai', model: 'gpt-5.6' });
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/status')));
    const out = lastSent(adapter);
    expect(out).toContain('Provider: openai');
    expect(out).toContain('Model: gpt-5.6');
  });
});

describe('/models (spec §45)', () => {
  function withLlm(table: ProviderTable): Context {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const llm = new LlmRuntime(rootCtx);
    llm.registerAdapter(Object.keys(table), new FakeLlmAdapter(table));
    return rootCtx;
  }

  it('lists every provider and their models', async () => {
    const rootCtx = withLlm({
      openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }, { id: 'gpt-5.6-mini', name: 'GPT 5.6 mini' }] },
      deepseek: { models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }] },
    });
    const { bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/models')));
    const out = lastSent(adapter);
    expect(out).toContain('openai');
    expect(out).toContain('gpt-5.6');
    expect(out).toContain('deepseek');
    expect(out).toContain('deepseek-reasoner');
  });

  it('keeps listing other providers when one provider listing fails', async () => {
    const rootCtx = withLlm({
      openai: { models: [], failListing: true },
      deepseek: { models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
    });
    const { bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/models')));
    const out = lastSent(adapter);
    expect(out).toContain('模型目录获取失败');
    expect(out).toContain('deepseek-chat');
  });

  it('renders the header for a provider with an empty model list', async () => {
    const rootCtx = withLlm({ empty: { models: [] } });
    const { bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/models')));
    expect(lastSent(adapter)).toContain('empty');
  });

  it('filters by provider and rejects unknown providers', async () => {
    const rootCtx = withLlm({ openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/models openai')));
    expect(lastSent(adapter)).toContain('gpt-5.6');
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/models bogus')));
    expect(lastSent(adapter)).toContain('未找到 Provider: bogus');
    expect(lastSent(adapter)).toContain('openai');
  });
});

describe('real-env agent scoped context (no injected services)', () => {
  // Regression: the agent-loop scoped context does NOT inject root services.
  // Reading `ctx.commands` / `ctx.llm` on it throws "cannot get property ...
  // without inject". Command handlers must reach services through deps
  // (bridged from the plugin ctx), never through invocation.agent.ctx.
  it('/help resolves the registry through deps, not invocation.agent.ctx', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const { gateway, bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;
    // The agent-loop scoped context does NOT inject root services. Swapping in
    // a bare context makes agent.ctx unable to provide commands/llm; handlers
    // must still work through deps (bridged from the plugin ctx).
    agent.ctx = new Context() as never;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/help')));
    expect(adapter.sent[adapter.sent.length - 1]?.text).toContain('/stop');
  });

  it('/models and /model resolve the llm seam through deps, not invocation.agent.ctx', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const llm = new LlmRuntime(rootCtx);
    llm.registerAdapter(['openai'], new FakeLlmAdapter({ openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } }));
    const { gateway, bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;
    agent.ctx = new Context() as never;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/models')));
    expect(adapter.sent[adapter.sent.length - 1]?.text).toContain('openai');
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m3', '/model openai gpt-5.6')));
    expect(adapter.sent[adapter.sent.length - 1]?.text).toContain('模型已切换');
  });
});