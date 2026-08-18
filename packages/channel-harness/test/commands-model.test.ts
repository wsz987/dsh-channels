/*
 * /model + ChannelModelSelectionManager coverage (spec §46, §18-§29).
 *
 * The switch path is exercised through a REAL LlmRuntime with a small fake
 * adapter: provider validation via listProviders, EXACT model resolution via
 * resolveModelInfo (catalog membership is advisory — an unlisted but
 * resolvable model must succeed), and reasoning-effort validation via
 * resolveCallConfig (unsupported efforts reject with
 * UNSUPPORTED_REASONING_EFFORT). The selection lands in the manager ref and
 * NEVER touches binding.route.
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
import { ChannelModelSelectionManager } from '../src/model-selection.ts';
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

interface ModelFakeAgent {
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

function fakeScopedAgent(ctx: Context, id: string): ModelFakeAgent {
  const events: ModelFakeAgent['session']['events'] = [];
  const agent: ModelFakeAgent = {
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

class ModelGateway implements AgentGateway {
  canResumeValue = true;
  existsValue = false;
  live = new Map<string, GatewayAgentHandle>();
  createCalls: string[] = [];
  disposed: string[] = [];
  followups: { sessionId: string; message: unknown }[] = [];
  agents = new Map<string, ModelFakeAgent>();

  constructor(private readonly rootCtx: Context) {}

  get(sessionId: string) {
    const handle = this.live.get(sessionId);
    if (!handle) return undefined;
    return { id: handle.id, agent: handle.agent, followup: handle.followup, whenIdle: handle.whenIdle };
  }
  canResume(): boolean { return this.canResumeValue; }
  async exists(): Promise<boolean> { return this.existsValue; }

  async create(sessionId: string, route: AgentRouteSpec, setup?: Parameters<AgentGateway['create']>[2]) {
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

type ProviderTable = Record<string, {
  models: { id: string; name: string }[];
  reasoningEfforts?: string[];
}>;

class FakeLlmAdapter extends LlmAdapter {
  constructor(private readonly table: ProviderTable) { super(); }
  listModels(provider: string): Promise<{ provider: string; id: string; name: string }[]> {
    const entry = this.table[provider];
    if (!entry) return Promise.resolve([]);
    return Promise.resolve(entry.models.map((m) => ({ ...m, provider })));
  }
  resolveModel(provider: string, model: string) {
    const entry = this.table[provider];
    // Exact resolution accepts ANY model id for a known provider (catalog
    // membership is advisory) and validates reasoning efforts via metadata.
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
  gateway: ModelGateway;
  bridge: ChannelHarnessBridge;
  adapter: FakeAdapter;
  bindingStore: MemoryBindingStore;
  modelSelection: ChannelModelSelectionManager;
}

function makeBridge(rootCtx: Context, modelSelection?: ChannelModelSelectionManager): Fixture {
  const gateway = new ModelGateway(rootCtx);
  const manager = new AgentManager(gateway, silentLogger, 4);
  const adapter = new FakeAdapter('weixin');
  const bindingStore = new MemoryBindingStore();
  const selection = modelSelection ?? new ChannelModelSelectionManager();
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
  return { gateway, bridge, adapter, bindingStore, modelSelection: selection };
}

function lastSent(adapter: FakeAdapter): string {
  return adapter.sent[adapter.sent.length - 1]?.text ?? '';
}

function withLlm(rootCtx: Context, table: ProviderTable): void {
  const llm = new LlmRuntime(rootCtx);
  llm.registerAdapter(Object.keys(table), new FakeLlmAdapter(table));
}

describe('/model (spec §46)', () => {
  it('shows the current model with no arguments, or a not-resolved fallback', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { gateway, bridge, adapter, modelSelection } = makeBridge(rootCtx, new ChannelModelSelectionManager());
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/model')));
    expect(lastSent(adapter)).toContain('当前模型');
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;
    modelSelection.select(agent as never, { provider: 'openai', model: 'gpt-5.6' });
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/model')));
    const out = lastSent(adapter);
    expect(out).toContain('Provider: openai');
    expect(out).toContain('Model: gpt-5.6');
  });

  it('switches the selection and reports success without touching binding.route', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { gateway, bridge, adapter, bindingStore, modelSelection } = makeBridge(rootCtx, new ChannelModelSelectionManager());
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const sessionId = gateway.createCalls[0]!;
    const agent = gateway.agents.get(sessionId)!;
    const routeBefore = (await bindingStore.get('weixin:main:user_123'))?.route;

    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/model openai gpt-5.6')));
    const out = lastSent(adapter);
    expect(out).toContain('模型已切换：');
    expect(out).toContain('Provider: openai');
    expect(out).toContain('从下一次模型执行步骤开始生效。');
    expect(modelSelection.current(agent as never)).toEqual({ provider: 'openai', model: 'gpt-5.6' });
    const routeAfter = (await bindingStore.get('weixin:main:user_123'))?.route;
    expect(routeAfter).toEqual(routeBefore);
  });

  it('accepts a supported reasoning effort', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }], reasoningEfforts: ['low', 'high'] } });
    const { gateway, bridge, adapter, modelSelection } = makeBridge(rootCtx, new ChannelModelSelectionManager());
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/model openai gpt-5.6 high')));
    expect(lastSent(adapter)).toContain('Reasoning: high');
    expect(modelSelection.current(agent as never)?.reasoningEffort).toBe('high');
  });

  it('rejects an unsupported reasoning effort and leaves the selection unchanged', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }], reasoningEfforts: ['low', 'high'] } });
    const { gateway, bridge, adapter, modelSelection } = makeBridge(rootCtx, new ChannelModelSelectionManager());
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/model openai gpt-5.6 ultra')));
    const out = lastSent(adapter);
    expect(out).toContain('Reasoning effort 不被支持');
    expect(out).toContain('low');
    expect(modelSelection.current(agent as never)).toBeUndefined();
  });

  it('rejects an unknown provider', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/model bogus gpt-5.6')));
    const out = lastSent(adapter);
    expect(out).toContain('未找到 Provider: bogus');
    expect(out).toContain('openai');
  });

  it('accepts an exact model that is NOT in the advisory catalog', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    // Catalog advertises gpt-5.6 only; exact resolution accepts any id.
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { bridge, adapter, modelSelection, gateway } = makeBridge(rootCtx, new ChannelModelSelectionManager());
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/model openai ghost-model')));
    expect(lastSent(adapter)).toContain('模型已切换：');
    expect(modelSelection.current(agent as never)).toEqual({ provider: 'openai', model: 'ghost-model' });
  });

  it('rejects malformed arity with the usage line', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/model openai gpt-5.6 high extra')));
    expect(lastSent(adapter)).toContain('用法：/model');
  });

  it('persists the switch as the Harness-wide default via agentDefaultModel.saveSelection', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const saveSelection = vi.fn(async () => {});
    rootCtx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'openai', model: 'gpt-5.6' }),
      saveSelection,
    });
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/model openai gpt-5.6')));
    expect(adapter.sent[adapter.sent.length - 1]?.text).toContain('模型已切换');
    // Official host-apiproxy parity: the switch also lands in agentDefaultModel
    // (-> settings) so Web surfaces and new sessions observe it without refresh.
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5.6' });
  });

  it('routes the switch through the host session.selectModel RPC when an apiProxy is mounted', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const selectModel = vi.fn(async () => ({ result: { ok: true } }));
    rootCtx.provide('apiProxy', { sessions: { selectModel } });
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }], reasoningEfforts: ['low', 'high'] } });
    const { gateway, bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const sessionId = gateway.createCalls[0]!;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/model openai gpt-5.6 high')));
    expect(adapter.sent[adapter.sent.length - 1]?.text).toContain('模型已切换');
    // The composer model selector renders the HOST's selectionFor(...).current;
    // routing the switch through the official RPC keeps it live without a refresh.
    expect(selectModel).toHaveBeenCalledWith({
      payload: { sessionId, provider: 'openai', model: 'gpt-5.6', reasoningEffort: 'high' },
    });
  });
});

describe('ChannelModelSelectionManager reading priority (spec §21)', () => {
  it('picked > request header > agent options', async () => {
    const rootCtx = new Context();
    const manager = new ChannelModelSelectionManager();
    const agent = fakeScopedAgent(rootCtx, 's-priority');
    manager.install(agent.ctx);

    // ③ options only.
    agent.options = { provider: 'route-prov', model: 'route-model' };
    expect(manager.current(agent as never)).toEqual({ provider: 'route-prov', model: 'route-model' });

    // ② header beats options.
    agent.session.requestHeader = () => ({ config: { provider: 'hdr', model: 'hdr-model' } });
    expect(manager.current(agent as never)).toEqual({ provider: 'hdr', model: 'hdr-model' });

    // ① picked beats header.
    manager.select(agent as never, { provider: 'picked', model: 'picked-model' });
    expect(manager.current(agent as never)).toEqual({ provider: 'picked', model: 'picked-model' });

    // Re-picking clears the header fallback.
    manager.select(agent as never, { provider: 'picked2', model: 'picked2-model', reasoningEffort: ReasoningEffortId('high') });
    expect(manager.current(agent as never)).toEqual({ provider: 'picked2', model: 'picked2-model', reasoningEffort: ReasoningEffortId('high') });
  });

  it('falls back to the Harness-wide default model selection as the last resort', async () => {
    const rootCtx = new Context();
    rootCtx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'def', model: 'def-model', reasoningEffort: ReasoningEffortId('high') }),
    });
    const manager = new ChannelModelSelectionManager();
    const agent = fakeScopedAgent(rootCtx, 's-default');
    manager.install(agent.ctx);
    // options empty + no header -> the root-provided default wins.
    expect(manager.current(agent as never)).toEqual({ provider: 'def', model: 'def-model', reasoningEffort: ReasoningEffortId('high') });

    // options still win over the default (routing snapshot is nearer).
    agent.options = { provider: 'route-prov', model: 'route-model' };
    expect(manager.current(agent as never)).toEqual({ provider: 'route-prov', model: 'route-model' });
  });

  it('returns undefined when nothing is resolvable', async () => {
    const rootCtx = new Context();
    const manager = new ChannelModelSelectionManager();
    const agent = fakeScopedAgent(rootCtx, 's-empty');
    manager.install(agent.ctx);
    expect(manager.current(agent as never)).toBeUndefined();
  });
});