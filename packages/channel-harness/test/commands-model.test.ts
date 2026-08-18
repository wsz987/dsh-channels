/*
 * Harness-owned model semantics.
 *
 * Channel sessions are created/resumed with the model resolved by Harness.
 * The channel command only validates and updates the shared default used by
 * future Sessions; it does not install an Agent waterfall or mutate a live
 * Session behind Harness's back.
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
const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const noopResolver: ChannelWorkspaceResolver = { resolve: async () => ({}) };

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

class FakeAdapter {
  id = 'weixin';
  capabilities = { text: true, image: false, file: false, audio: false, video: false, markdown: true, cards: false, reactions: false, threads: false, streaming: 'buffered' } as const;
  sent: { text?: string }[] = [];
  async start() {}
  async stop() {}
  async send(_target: ChannelTarget, message: { text?: string }) {
    this.sent.push(message);
    return { delivered: true };
  }
}

function makeMessageEvent(text: string, id = 'm1'): MessageReceived {
  return {
    type: 'message.received',
    channel: 'weixin',
    accountId: 'main',
    conversation: { id: 'user_123', type: 'dm' },
    sender: { id: 'user_123', name: 'Alice' },
    message: { id, content: [{ type: 'text', text }] },
  };
}

interface ModelAgent {
  id: SessionId;
  session: {
    id: string;
    append(type: string, data: unknown): { type: string; data: unknown };
    requestHeader?(): { config: { provider: string; model: string; reasoningEffort?: string } } | undefined;
  };
  status: 'idle' | 'running';
  options: { provider?: string; model?: string };
  ctx: Context;
}

function fakeAgent(ctx: Context, id: string): ModelAgent {
  const agent = {
    id: SessionId(id),
    session: {
      id,
      append: (type, data) => ({ type, data }),
    },
    status: 'idle' as const,
    options: {},
    ctx: new Context(),
  } as ModelAgent;
  agent.ctx = createScope(ctx, agent as never).ctx;
  return agent;
}

class ModelGateway implements AgentGateway {
  canResumeValue = true;
  existsValue = false;
  live = new Map<string, GatewayAgentHandle>();
  agents = new Map<string, ModelAgent>();

  constructor(private readonly rootCtx: Context) {}

  get(sessionId: string) {
    const handle = this.live.get(sessionId);
    return handle ? { id: handle.id, agent: handle.agent, followup: handle.followup, whenIdle: handle.whenIdle } : undefined;
  }
  canResume() { return this.canResumeValue; }
  async exists() { return this.existsValue; }

  async create(sessionId: string, _route: AgentRouteSpec, setup?: Parameters<AgentGateway['create']>[2]) {
    const agent = fakeAgent(this.rootCtx, sessionId);
    if (setup) await setup(agent.ctx);
    this.agents.set(sessionId, agent);
    const handle: GatewayAgentHandle = {
      id: sessionId,
      agent: agent as never,
      followup: () => {},
      whenIdle: async () => {},
      dispose: async () => { this.live.delete(sessionId); },
    };
    this.live.set(sessionId, handle);
    return handle;
  }

  async resume(sessionId: string, route: AgentRouteSpec, setup?: Parameters<AgentGateway['resume']>[2]) {
    return this.create(sessionId, route, setup);
  }
}

type ProviderTable = Record<string, { models: { id: string; name: string }[]; reasoningEfforts?: string[] }>;

class FakeLlmAdapter extends LlmAdapter {
  constructor(private readonly table: ProviderTable) { super(); }
  listModels(provider: string) {
    return Promise.resolve((this.table[provider]?.models ?? []).map((model) => ({ ...model, provider })));
  }
  resolveModel(provider: string, model: string) {
    const efforts = this.table[provider]?.reasoningEfforts;
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...(efforts ? { reasoning: { efforts: efforts.map((id) => ({ id: ReasoningEffortId(id), name: id })) } } : {}),
    });
  }
  async *stream(): AsyncGenerator<StreamChunk> { return; }
}

interface Fixture {
  gateway: ModelGateway;
  bridge: ChannelHarnessBridge;
  adapter: FakeAdapter;
  modelSelection: ChannelModelSelectionController;
}

function makeBridge(rootCtx: Context, modelSelection = new ChannelModelSelectionController(rootCtx)): Fixture {
  const gateway = new ModelGateway(rootCtx);
  const manager = new AgentManager(gateway, silentLogger, 4);
  const adapter = new FakeAdapter();
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
    commandDeps: { startNewSession: (agent) => bridge.startNewSession(agent), modelSelection },
    workspaceResolver: noopResolver,
  });
  return { gateway, bridge, adapter, modelSelection };
}

function withLlm(rootCtx: Context, table: ProviderTable): void {
  const llm = new LlmRuntime(rootCtx);
  llm.registerAdapter(Object.keys(table), new FakeLlmAdapter(table));
}

function lastSent(adapter: FakeAdapter): string {
  return adapter.sent.at(-1)?.text ?? '';
}

describe('/model', () => {
  it('reads the Harness default when a new Session has no header/options', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    rootCtx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'openai', model: 'gpt-5.6' }) });
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent('/model'));
    expect(lastSent(adapter)).toContain('Provider: openai');
    expect(lastSent(adapter)).toContain('Model: gpt-5.6');
  });

  it('switches the current Session and persists the same choice as the default', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const saveSelection = vi.fn(async () => {});
    rootCtx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'old', model: 'old-model' }),
      saveSelection,
    });
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { bridge, adapter, gateway } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent('hello'));
    await bridge.handleChannelEvent(makeMessageEvent('/model openai gpt-5.6', 'm2'));
    expect(lastSent(adapter)).toContain('模型已切换');
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5.6' });
    await bridge.handleChannelEvent(makeMessageEvent('/model', 'm3'));
    expect(lastSent(adapter)).toContain('Provider: openai');
    expect(lastSent(adapter)).toContain('Model: gpt-5.6');
  });

  it('preserves and stores a supported reasoning effort', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const saveSelection = vi.fn(async () => {});
    rootCtx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'openai', model: 'base' }), saveSelection });
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }], reasoningEfforts: ['high'] } });
    const { bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent('/model openai gpt-5.6 high'));
    expect(lastSent(adapter)).toContain('Reasoning: high');
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5.6', reasoningEffort: ReasoningEffortId('high') });
  });

  it('rejects unsupported reasoning effort and unknown providers', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }], reasoningEfforts: ['low'] } });
    const { bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent('/model openai gpt-5.6 high'));
    expect(lastSent(adapter)).toContain('Reasoning effort 不被支持');
    await bridge.handleChannelEvent(makeMessageEvent('/model bogus gpt-5.6', 'm2'));
    expect(lastSent(adapter)).toContain('未找到 Provider: bogus');
  });

  it('accepts a resolvable model outside the advisory catalog', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const saveSelection = vi.fn(async () => {});
    rootCtx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'openai', model: 'base' }), saveSelection });
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent('/model openai ghost-model'));
    expect(lastSent(adapter)).toContain('Model: ghost-model');
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'openai', model: 'ghost-model' });
  });

  it('delegates a live-session switch and read to the official Host API when present', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const selectModel = vi.fn(async () => ({
      result: { ok: true, value: { selected: { provider: 'openai', model: 'gpt-5.6' } } },
    }));
    const models = vi.fn(async () => ({
      result: { ok: true, value: { current: { provider: 'openai', model: 'gpt-5.6' } } },
    }));
    rootCtx.provide('apiProxy', { sessions: { selectModel, models } });
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { bridge, adapter, gateway } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent('hello'));
    const sessionId = gateway.agents.keys().next().value as string;
    await bridge.handleChannelEvent(makeMessageEvent('/model openai gpt-5.6', 'm2'));
    expect(selectModel).toHaveBeenCalledWith({
      payload: { sessionId, provider: 'openai', model: 'gpt-5.6' },
    });
    await bridge.handleChannelEvent(makeMessageEvent('/model', 'm3'));
    expect(models).toHaveBeenCalledWith({ payload: { sessionId } });
    expect(lastSent(adapter)).toContain('Provider: openai');
  });
});

describe('ChannelModelSelectionController', () => {
  it('reads session header, then options, then Harness default', async () => {
    const rootCtx = new Context();
    const controller = new ChannelModelSelectionController(rootCtx);
    rootCtx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'default', model: 'default-model' }) });
    const agent = fakeAgent(rootCtx, 's1');
    expect(await controller.current(agent as never)).toEqual({ provider: 'default', model: 'default-model' });
    agent.options = { provider: 'route', model: 'route-model' };
    expect(await controller.current(agent as never)).toEqual({ provider: 'route', model: 'route-model' });
    agent.session.requestHeader = () => ({ config: { provider: 'header', model: 'header-model', reasoningEffort: 'high' } });
    expect(await controller.selectionForStep(agent as never)).toEqual({ provider: 'header', model: 'header-model', reasoningEffort: ReasoningEffortId('high') });
  });

  it('uses the headless hook without a first-turn RPC', async () => {
    const rootCtx = new Context();
    const controller = new ChannelModelSelectionController(rootCtx);
    const agent = fakeAgent(rootCtx, 's2');
    const dispose = controller.install(agent.ctx);
    dispose();
    expect(controller.mode).toBe('local');
  });

  it('keeps a local Agent owner when the Host mounts later', async () => {
    const rootCtx = new Context();
    const controller = new ChannelModelSelectionController(rootCtx);
    const agent = fakeAgent(rootCtx, 's-late-host');
    const dispose = controller.install(agent.ctx);
    const selectModel = vi.fn(async () => ({ result: { ok: true } }));
    rootCtx.provide('apiProxy', { sessions: { selectModel } });

    await controller.select(agent as never, { provider: 'local', model: 'local-model' });

    expect(selectModel).not.toHaveBeenCalled();
    expect(await controller.current(agent as never)).toEqual({ provider: 'local', model: 'local-model' });
    dispose();
  });

  it('keeps a Host Agent owner while the Host implementation is replaced', async () => {
    const rootCtx = new Context();
    const hostOneSelect = vi.fn(async () => ({ result: { ok: true } }));
    const hostOneDispose = rootCtx.provide('apiProxy', { sessions: { selectModel: hostOneSelect } });
    const controller = new ChannelModelSelectionController(rootCtx);
    const agent = fakeAgent(rootCtx, 's-host-hmr');
    const dispose = controller.install(agent.ctx);
    hostOneDispose();
    const hostTwoSelect = vi.fn(async () => ({ result: { ok: true } }));
    rootCtx.provide('apiProxy', { sessions: { selectModel: hostTwoSelect } });

    await controller.select(agent as never, { provider: 'host', model: 'host-model' });

    expect(hostOneSelect).not.toHaveBeenCalled();
    expect(hostTwoSelect).toHaveBeenCalledOnce();
    dispose();
  });
});
