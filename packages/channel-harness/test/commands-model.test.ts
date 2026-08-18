/*
 * /model + ChannelModelSelectionController coverage (spec §46, §18-§29).
 *
 * The switch path is exercised through a REAL LlmRuntime with a small fake
 * adapter: provider validation via listProviders, EXACT model resolution via
 * resolveModelInfo (catalog membership is advisory - an unlisted but
 * resolvable model must succeed), and reasoning-effort validation via
 * resolveCallConfig (unsupported efforts reject with
 * UNSUPPORTED_REASONING_EFFORT). The selection lands through the controller's
 * SINGLE backend and NEVER touches binding.route.
 *
 * Ownership (the reason /model must not install a second waterfall):
 * - local mode (no apiProxy): the controller owns the ModelSelectionRef and
 *   installs the official hook; a /model switch flows through the REAL
 *   system-prompt/assemble + agent/request waterfalls to the request config.
 * - host mode (apiProxy mounted): the controller installs NOTHING - the host
 *   owns the waterfall (a realistic apiProxy shim replicates the official
 *   selectionFor + installModelSelection). A channel /model switch is routed
 *   through the host RPC, and a later Web-side switch must WIN the next real
 *   waterfall dispatch (with two owners, the first-registered channel
 *   listener would rewrite the request back to the stale channel pick).
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import { LlmAdapter, LlmRuntime, ReasoningEffortId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope';
import { installModelSelection, type ModelSelection } from '@deepseek-ai/dsh-agent';
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
import {
  ChannelModelSelectionBackendError,
  ChannelModelSelectionController,
  type ChannelHostApiProxy,
} from '../src/model-selection.ts';
import { SESSION_BINDING_SCHEMA_VERSION } from '../src/session-router.ts';
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
  /** Per-session logged `request/header` configs (resume-restored selections). */
  requestHeaders = new Map<string, { provider: string; model: string; reasoningEffort?: string }>();
  /** Ordering instrumentation: invoked when the bridge drives a followup. */
  followupHook?: () => void;

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
    const header = this.requestHeaders.get(sessionId);
    if (header) {
      agent.session.requestHeader = () => ({ config: header });
    }
    if (setup) {
      const commit = await setup(agent.ctx);
      commit?.commit();
    }
    this.agents.set(sessionId, agent);
    const handle: GatewayAgentHandle = {
      id: sessionId,
      agent: agent as never,
      followup: (message) => {
        this.followupHook?.();
        this.followups.push({ sessionId, message });
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
  modelSelection: ChannelModelSelectionController;
}

function makeBridge(rootCtx: Context, modelSelection?: ChannelModelSelectionController): Fixture {
  const gateway = new ModelGateway(rootCtx);
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
  return { gateway, bridge, adapter, bindingStore, modelSelection: selection };
}

function lastSent(adapter: FakeAdapter): string {
  return adapter.sent[adapter.sent.length - 1]?.text ?? '';
}

function withLlm(rootCtx: Context, table: ProviderTable): void {
  const llm = new LlmRuntime(rootCtx);
  llm.registerAdapter(Object.keys(table), new FakeLlmAdapter(table));
}

/**
 * Dispatch the REAL system-prompt/assemble waterfall on an agent scope
 * (the same event the official installModelSelection hook couples), returning
 * the final assembly. The final next() yields the seed assembly untouched,
 * so any injected provider/model variables come from a registered hook.
 */
function assembleWaterfall(agent: ModelFakeAgent): Promise<{ variables: Record<string, string> }> {
  const carrier = scopeTarget(agent, agent);
  const assembly = { sections: [], contexts: [], tools: [], variables: {} as Record<string, string> };
  const context = { agent, scope: agent };
  return agent.ctx.waterfall(carrier, 'system-prompt/assemble', assembly, context, () => Promise.resolve(assembly));
}

/**
 * Dispatch the REAL agent/request waterfall (as dsh-agent-loop's
 * buildRequest does), starting from a seed call config. The final next()
 * yields the seed; any provider/model override comes from a registered hook's
 * assembled snapshot.
 */
function requestWaterfall(
  agent: ModelFakeAgent,
  seed: { provider: string; model: string } = { provider: 'base-prov', model: 'base-model' },
): Promise<{ provider: string; model: string }> {
  const carrier = scopeTarget(agent, agent);
  return agent.ctx.waterfall(
    carrier,
    'agent/request',
    { agent, turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve(seed),
  );
}

/**
 * Realistic Web Host shim: replicates the official dsh-host-apiproxy
 * `selectionFor` — a WeakMap<Agent, ref> whose ref is coupled to the agent
 * scope via `installModelSelection` on first access — with the official
 * reading precedence (picked → logged request/header → live default), the
 * official `session.selectModel` semantics (sets `selectionFor(agent).current`
 * AND saves the shared default) and `session.models` (returns the host's
 * current; always resolvable while an agent exists, exactly like the official
 * getter chain).
 */
function makeHostApiProxy(
  agents: Map<string, ModelFakeAgent>,
  saveSelection: (selection: ModelSelection) => Promise<void> | void,
  defaultSelection: () => ModelSelection | undefined,
) {
  const selections = new WeakMap<object, { current: ModelSelection | undefined; assembled: ModelSelection | undefined }>();
  function selectionFor(agent: ModelFakeAgent) {
    let ref = selections.get(agent);
    if (ref) return ref;
    let picked: ModelSelection | undefined;
    ref = {
      get current() {
        if (picked !== undefined) return picked;
        const logged = agent.session.requestHeader?.()?.config;
        if (logged?.provider && logged.model) {
          return {
            provider: logged.provider,
            model: logged.model,
            ...(logged.reasoningEffort ? { reasoningEffort: logged.reasoningEffort } : {}),
          };
        }
        return defaultSelection();
      },
      set current(next) {
        picked = next;
      },
      assembled: undefined,
    };
    installModelSelection(agent.ctx, ref);
    selections.set(agent, ref);
    return ref;
  }
  const selectModel = vi.fn(async (request: {
    payload: { sessionId: string; provider: string; model: string; reasoningEffort?: string };
  }) => {
    const agent = agents.get(request.payload.sessionId);
    if (!agent) return { result: { ok: false, error: { code: 'internal', message: 'agent not found' } } };
    const selected: ModelSelection = {
      provider: request.payload.provider,
      model: request.payload.model,
      ...(request.payload.reasoningEffort
        ? { reasoningEffort: ReasoningEffortId(request.payload.reasoningEffort) }
        : {}),
    };
    selectionFor(agent).current = selected;
    await saveSelection(selected);
    return { result: { ok: true, value: { selected } } };
  });
  const models = vi.fn(async (request: { payload: { sessionId: string } }) => {
    const agent = agents.get(request.payload.sessionId);
    if (!agent) return { result: { ok: false, error: { code: 'internal', message: 'agent not found' } } };
    const current = selectionFor(agent).current;
    if (!current) return { result: { ok: false, error: { code: 'internal', message: 'no selection' } } };
    return {
      result: {
        ok: true,
        value: {
          current: {
            provider: current.provider,
            model: current.model,
            ...(current.reasoningEffort ? { reasoningEffort: String(current.reasoningEffort) } : {}),
          },
        },
      },
    };
  });
  const apiProxy: ChannelHostApiProxy = { sessions: { selectModel, models } };
  return { apiProxy, selectionFor, selectModel, models };
}

describe('/model (spec §46)', () => {
  it('shows the current model with no arguments, or a not-resolved fallback', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { gateway, bridge, adapter, modelSelection } = makeBridge(rootCtx, new ChannelModelSelectionController(rootCtx));
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/model')));
    expect(lastSent(adapter)).toContain('当前模型');
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;
    await modelSelection.select(agent as never, { provider: 'openai', model: 'gpt-5.6' });
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/model')));
    const out = lastSent(adapter);
    expect(out).toContain('Provider: openai');
    expect(out).toContain('Model: gpt-5.6');
  });

  it('switches the selection and reports success without touching binding.route', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { gateway, bridge, adapter, bindingStore, modelSelection } = makeBridge(rootCtx, new ChannelModelSelectionController(rootCtx));
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const sessionId = gateway.createCalls[0]!;
    const agent = gateway.agents.get(sessionId)!;
    const routeBefore = (await bindingStore.get('weixin:main:user_123'))?.route;

    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/model openai gpt-5.6')));
    const out = lastSent(adapter);
    expect(out).toContain('模型已切换：');
    expect(out).toContain('Provider: openai');
    expect(out).toContain('从下一次模型执行步骤开始生效。');
    expect(await modelSelection.current(agent as never)).toEqual({ provider: 'openai', model: 'gpt-5.6' });
    const routeAfter = (await bindingStore.get('weixin:main:user_123'))?.route;
    expect(routeAfter).toEqual(routeBefore);
  });

  it('accepts a supported reasoning effort', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }], reasoningEfforts: ['low', 'high'] } });
    const { gateway, bridge, adapter, modelSelection } = makeBridge(rootCtx, new ChannelModelSelectionController(rootCtx));
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/model openai gpt-5.6 high')));
    expect(lastSent(adapter)).toContain('Reasoning: high');
    expect((await modelSelection.current(agent as never))?.reasoningEffort).toBe('high');
  });

  it('rejects an unsupported reasoning effort and leaves the selection unchanged', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }], reasoningEfforts: ['low', 'high'] } });
    const { gateway, bridge, adapter, modelSelection } = makeBridge(rootCtx, new ChannelModelSelectionController(rootCtx));
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/model openai gpt-5.6 ultra')));
    const out = lastSent(adapter);
    expect(out).toContain('Reasoning effort 不被支持');
    expect(out).toContain('low');
    expect(await modelSelection.current(agent as never)).toBeUndefined();
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
    const { bridge, adapter, modelSelection, gateway } = makeBridge(rootCtx, new ChannelModelSelectionController(rootCtx));
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/model openai ghost-model')));
    expect(lastSent(adapter)).toContain('模型已切换：');
    expect(await modelSelection.current(agent as never)).toEqual({ provider: 'openai', model: 'ghost-model' });
  });

  it('rejects malformed arity with the usage line', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/model openai gpt-5.6 high extra')));
    expect(lastSent(adapter)).toContain('用法：/model');
  });

  it('persists the switch as the Harness-wide default via agentDefaultModel.saveSelection (local mode)', async () => {
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
    // Official headless parity: in local mode the controller also persists the
    // switch to agentDefaultModel (-> settings) so new sessions observe it.
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5.6' });
  });

  it('routes the switch through the host session.selectModel RPC when an apiProxy is mounted (host mode)', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const selectModel = vi.fn(async () => ({
      result: { ok: true, value: { selected: { provider: 'openai', model: 'gpt-5.6' } } },
    }));
    // prepare() needs the host models RPC (the same one /model reads through).
    const models = vi.fn(async () => ({
      result: { ok: true, value: { current: { provider: 'openai', model: 'gpt-5.6' } } },
    }));
    const saveSelection = vi.fn(async () => {});
    rootCtx.provide('apiProxy', { sessions: { selectModel, models } });
    rootCtx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'openai', model: 'gpt-5.6' }),
      saveSelection,
    });
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }], reasoningEfforts: ['low', 'high'] } });
    const { gateway, bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const sessionId = gateway.createCalls[0]!;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/model openai gpt-5.6 high')));
    expect(adapter.sent[adapter.sent.length - 1]?.text).toContain('模型已切换');
    // The host is the sole owner: the switch goes through the official RPC
    // (updates the host's selectionFor(...).current + composer selector)...
    expect(selectModel).toHaveBeenCalledWith({
      payload: { sessionId, provider: 'openai', model: 'gpt-5.6', reasoningEffort: 'high' },
    });
    // ...and the channel must NOT save the default again - the host does it.
    expect(saveSelection).not.toHaveBeenCalled();
  });

  it('surfaces a host session.selectModel rejection instead of half-applying', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    rootCtx.provide('apiProxy', {
      sessions: {
        selectModel: vi.fn(async () => ({
          result: { ok: false, error: { code: 'model-unavailable', message: 'no adapter serves provider "bogus"' } },
        })),
        models: vi.fn(async () => ({
          result: { ok: true, value: { current: { provider: 'openai', model: 'gpt-5.6' } } },
        })),
      },
    });
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { bridge, adapter } = makeBridge(rootCtx);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/model openai gpt-5.6')));
    const out = lastSent(adapter);
    expect(out).toContain('模型切换失败');
    expect(out).toContain('no adapter serves provider "bogus"');
  });
});

describe('model-selection ownership: exactly ONE backend per agent (spec §18-§24)', () => {
  it('local mode: a /model switch flows through the REAL assemble + request waterfalls', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { gateway, bridge, modelSelection } = makeBridge(rootCtx, new ChannelModelSelectionController(rootCtx));
    expect(modelSelection.mode).toBe('local');

    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;

    // Seed baseline: with an empty ref the hook leaves the surfaces untouched.
    let assembled = await assembleWaterfall(agent);
    expect(assembled.variables.provider).toBeUndefined();
    let config = await requestWaterfall(agent);
    expect(config).toEqual({ provider: 'base-prov', model: 'base-model' });

    // /model switch through the LOCAL backend (ref + installModelSelection).
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/model openai gpt-5.6')));
    expect(await modelSelection.current(agent as never)).toEqual({ provider: 'openai', model: 'gpt-5.6' });

    // The NEXT real assemble snapshots the pick into prompt variables...
    assembled = await assembleWaterfall(agent);
    expect(assembled.variables).toMatchObject({ provider: 'openai', model: 'gpt-5.6' });
    // ...and the NEXT real request routes through it.
    config = await requestWaterfall(agent);
    expect(config).toEqual({ provider: 'openai', model: 'gpt-5.6' });
  });

  it('host mode: the channel installs NO waterfall; a Web-side switch wins the next real dispatch', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const saveSelection = vi.fn(async () => {});
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { gateway, bridge, adapter, modelSelection } = makeBridge(rootCtx, new ChannelModelSelectionController(rootCtx));
    const host = makeHostApiProxy(gateway.agents, saveSelection, () => ({ provider: 'openai', model: 'gpt-5.6' }));
    rootCtx.provide('apiProxy', host.apiProxy);
    rootCtx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'openai', model: 'gpt-5.6' }),
      saveSelection,
    });
    expect(modelSelection.mode).toBe('host');

    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const sessionId = gateway.createCalls[0]!;
    const agent = gateway.agents.get(sessionId)!;

    // Channel /model A: routed through the host RPC (the host owns the ref).
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/model openai gpt-5.6')));
    expect(host.selectModel).toHaveBeenCalled();
    expect(host.selectionFor(agent).current).toEqual({ provider: 'openai', model: 'gpt-5.6' });
    // The host (not the channel) persisted the shared default.
    expect(saveSelection).toHaveBeenCalledWith({ provider: 'openai', model: 'gpt-5.6' });

    // The channel installed NOTHING on this agent: with only the host's hook
    // registered, the first real assemble reflects the host's current.
    let assembled = await assembleWaterfall(agent);
    expect(assembled.variables).toMatchObject({ provider: 'openai', model: 'gpt-5.6' });
    let config = await requestWaterfall(agent);
    expect(config).toEqual({ provider: 'openai', model: 'gpt-5.6' });

    // The user switches in Harness Web: B via the same host RPC.
    await host.apiProxy.sessions!.selectModel!({
      payload: { sessionId, provider: 'anthropic', model: 'claude-4.7' },
    });
    expect(host.selectionFor(agent).current).toEqual({ provider: 'anthropic', model: 'claude-4.7' });

    // The NEXT real assemble + request MUST route B. With a competing channel
    // ref still holding A (the pre-fix behavior), the first-registered channel
    // listener would rewrite the request back to A here.
    assembled = await assembleWaterfall(agent);
    expect(assembled.variables).toMatchObject({ provider: 'anthropic', model: 'claude-4.7' });
    config = await requestWaterfall(agent);
    expect(config).toEqual({ provider: 'anthropic', model: 'claude-4.7' });

    // The channel reads the host's authoritative current (same source as the
    // composer model selector), so /model cannot drift from the Web UI.
    expect(await modelSelection.current(agent as never)).toEqual({ provider: 'anthropic', model: 'claude-4.7' });
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m3', '/model')));
    expect(lastSent(adapter)).toContain('Provider: anthropic');
    expect(lastSent(adapter)).toContain('Model: claude-4.7');
  });

  it('host mode: install() pins the host owner and installs NO local waterfall', async () => {
    const rootCtx = new Context();
    rootCtx.provide('apiProxy', { sessions: {} });
    const controller = new ChannelModelSelectionController(rootCtx);
    const agent = fakeScopedAgent(rootCtx, 's-host-pin');
    controller.install(agent.ctx);
    // The pin is recorded (host mode) but no local hook is installed: a real
    // assemble passes through untouched.
    const assembled = await assembleWaterfall(agent);
    expect(assembled.variables.provider).toBeUndefined();
    const config = await requestWaterfall(agent);
    expect(config).toEqual({ provider: 'base-prov', model: 'base-model' });
  });

  it('host mode: prepare() forces the official Host selectionFor BEFORE the first plain-text followup', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const saveSelection = vi.fn(async () => {});
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { gateway, bridge, modelSelection } = makeBridge(rootCtx, new ChannelModelSelectionController(rootCtx));
    const host = makeHostApiProxy(gateway.agents, saveSelection, () => ({ provider: 'openai', model: 'gpt-5.6' }));
    rootCtx.provide('apiProxy', host.apiProxy);
    rootCtx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'openai', model: 'gpt-5.6' }),
      saveSelection,
    });

    // Ordering instrumentation: the host models RPC (prepare) must happen
    // BEFORE the bridge drives the followup — the first turn's request must
    // already route through the Host's ModelSelection.
    const followupSeen = vi.fn();
    gateway.followupHook = followupSeen;

    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;

    // prepare() fired the models RPC once, strictly before the followup.
    expect(host.models).toHaveBeenCalledTimes(1);
    expect(host.models.mock.invocationCallOrder[0]).toBeLessThan(followupSeen.mock.invocationCallOrder[0]);
    // The official selectionFor is now installed on the agent: the first
    // request routes the host's current (picked -> header -> default).
    const assembled = await assembleWaterfall(agent);
    expect(assembled.variables).toMatchObject({ provider: 'openai', model: 'gpt-5.6' });
    const config = await requestWaterfall(agent);
    expect(config).toEqual({ provider: 'openai', model: 'gpt-5.6' });

    // prepare() is idempotent: the next message does NOT re-fire the RPC.
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', 'hello again')));
    expect(host.models).toHaveBeenCalledTimes(1);
    expect(modelSelection.mode).toBe('host');
  });

  it('host mode: resume with a logged header A and global default B keeps A on the first channel message', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    const saveSelection = vi.fn(async () => {});
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { gateway, bridge, modelSelection, bindingStore } = makeBridge(rootCtx, new ChannelModelSelectionController(rootCtx));
    // Session history says A; the shared default is B.
    gateway.canResumeValue = true;
    gateway.existsValue = true;
    gateway.requestHeaders.set('s-resume', { provider: 'provA', model: 'modelA' });
    const host = makeHostApiProxy(gateway.agents, saveSelection, () => ({ provider: 'provB', model: 'modelB' }));
    rootCtx.provide('apiProxy', host.apiProxy);
    rootCtx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'provB', model: 'modelB' }),
      saveSelection,
    });
    await bindingStore.put({
      channelId: 'weixin',
      accountId: 'main',
      conversationId: 'user_123',
      conversationType: 'dm',
      sessionId: 's-resume',
      route: defaultRoute,
      schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
      createdAt: 1,
      updatedAt: 1,
    });

    // First channel message after the restart: prepare() forces the host
    // selectionFor BEFORE the followup, so the logged header (A) wins over
    // the global default (B) — never the route/default fallback.
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    expect(gateway.createCalls).toContain('s-resume');
    const agent = gateway.agents.get('s-resume')!;
    expect(host.models).toHaveBeenCalledTimes(1);
    expect(host.selectionFor(agent).current).toEqual({ provider: 'provA', model: 'modelA' });
    expect(await modelSelection.current(agent as never)).toEqual({ provider: 'provA', model: 'modelA' });
    // The first request config routes A through the Host waterfall.
    await assembleWaterfall(agent);
    const config = await requestWaterfall(agent);
    expect(config).toEqual({ provider: 'provA', model: 'modelA' });
  });

  it('host mode: a host-owned agent fails loud when the Host backend disappears (no silent local downgrade)', async () => {
    const rootCtx = new Context();
    const saveSelection = vi.fn(async () => {});
    const agent = fakeScopedAgent(rootCtx, 's-host-gone');
    const host = makeHostApiProxy(new Map([['s-host-gone', agent]]), saveSelection, () => undefined);
    const disposeHost = rootCtx.provide('apiProxy', host.apiProxy);
    const controller = new ChannelModelSelectionController(rootCtx);
    controller.install(agent.ctx);

    // While the Host is mounted the pinned owner works.
    await controller.select(agent as never, { provider: 'p', model: 'm' });
    expect(host.selectModel).toHaveBeenCalled();

    // The Host unmounts (apiProxy fiber disposed).
    await disposeHost();
    await expect(controller.select(agent as never, { provider: 'p2', model: 'm2' })).rejects.toThrow(
      ChannelModelSelectionBackendError,
    );
    await expect(controller.current(agent as never)).rejects.toThrow(ChannelModelSelectionBackendError);
    // The agent never silently fell back to a local owner: the mode getter is
    // deployment-wide, but the AGENT's own owner is still the (gone) Host.
    expect(controller.mode).toBe('local');
  });

  it('host mode: a replaced Host apiProxy is also a failed backend (identity pinned)', async () => {
    const rootCtx = new Context();
    const saveSelection = vi.fn(async () => {});
    const host = makeHostApiProxy(new Map(), saveSelection, () => undefined);
    const disposeHost = rootCtx.provide('apiProxy', host.apiProxy);
    const controller = new ChannelModelSelectionController(rootCtx);
    const agent = fakeScopedAgent(rootCtx, 's-host-replaced');
    controller.install(agent.ctx);
    expect(controller.mode).toBe('host');

    // Host reload (HMR): the OLD apiProxy goes away, a NEW one mounts.
    await disposeHost();
    const host2 = makeHostApiProxy(new Map(), saveSelection, () => undefined);
    rootCtx.provide('apiProxy', host2.apiProxy);
    // The agent was pinned against the OLD identity — the new Host must not
    // be half-adopted (it would install a second waterfall on a live agent).
    await expect(controller.select(agent as never, { provider: 'p', model: 'm' })).rejects.toThrow(
      ChannelModelSelectionBackendError,
    );
    expect(host2.selectModel).not.toHaveBeenCalled();
    await expect(controller.prepare(agent as never)).rejects.toThrow(ChannelModelSelectionBackendError);
  });

  it('local mode: a local-owned agent NEVER auto-upgrades when a Host mounts later (no second owner)', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const saveSelection = vi.fn(async () => {});
    const controller = new ChannelModelSelectionController(rootCtx);
    const agent = fakeScopedAgent(rootCtx, 's-local-stays');
    controller.install(agent.ctx); // pinned LOCAL (no Host yet)
    expect(controller.mode).toBe('local');

    // The Web Host mounts LATER (startup ordering / HMR).
    const host = makeHostApiProxy(new Map(), saveSelection, () => ({ provider: 'def', model: 'def-model' }));
    rootCtx.provide('apiProxy', host.apiProxy);
    expect(controller.mode).toBe('host'); // deployment-wide mode changed...

    // ...but the AGENT keeps its local owner: the switch never reaches the
    // Host RPC and no host waterfall is installed on this agent.
    await controller.select(agent as never, { provider: 'local-p', model: 'local-m' });
    expect(host.selectModel).not.toHaveBeenCalled();
    expect(await controller.current(agent as never)).toEqual({ provider: 'local-p', model: 'local-m' });
    await assembleWaterfall(agent);
    const config = await requestWaterfall(agent);
    expect(config).toEqual({ provider: 'local-p', model: 'local-m' });
  });

  it('install() returns a disposer that unpins the agent and removes the local waterfall', async () => {
    const rootCtx = new Context();
    const controller = new ChannelModelSelectionController(rootCtx);
    const agent = fakeScopedAgent(rootCtx, 's-disposer');
    const dispose = controller.install(agent.ctx);

    await controller.select(agent as never, { provider: 'p', model: 'm' });
    await assembleWaterfall(agent);
    expect(await requestWaterfall(agent)).toEqual({ provider: 'p', model: 'm' });

    // Disposal removes the two official waterfall listeners (a reloading
    // bridge must release borrowed agents' hooks without disposing the agent).
    dispose();
    await assembleWaterfall(agent);
    expect(await requestWaterfall(agent)).toEqual({ provider: 'base-prov', model: 'base-model' });

    // A re-install (fresh bridge generation) re-pins cleanly and can be
    // disposed again — no listener stacking.
    const dispose2 = controller.install(agent.ctx);
    await controller.select(agent as never, { provider: 'p2', model: 'm2' });
    await assembleWaterfall(agent);
    expect(await requestWaterfall(agent)).toEqual({ provider: 'p2', model: 'm2' });
    dispose2();
    await assembleWaterfall(agent);
    expect(await requestWaterfall(agent)).toEqual({ provider: 'base-prov', model: 'base-model' });
  });

  it('bridge teardown disposes model-selection setups, including borrowed agents', async () => {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    withLlm(rootCtx, { openai: { models: [{ id: 'gpt-5.6', name: 'GPT 5.6' }] } });
    const { gateway, bridge } = makeBridge(rootCtx, new ChannelModelSelectionController(rootCtx));

    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/model openai gpt-5.6')));
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;
    await assembleWaterfall(agent);
    expect(await requestWaterfall(agent)).toEqual({ provider: 'openai', model: 'gpt-5.6' });

    // Bridge HMR: setup teardown removes the channel's model-selection
    // waterfall from the (borrowed / never-disposed) agent.
    await bridge.disposeCommandSetups();
    await assembleWaterfall(agent);
    expect(await requestWaterfall(agent)).toEqual({ provider: 'base-prov', model: 'base-model' });
  });
});

describe('ChannelModelSelectionController reading priority (spec §21)', () => {
  it('picked > request header > agent options', async () => {
    const rootCtx = new Context();
    const controller = new ChannelModelSelectionController(rootCtx);
    const agent = fakeScopedAgent(rootCtx, 's-priority');
    controller.install(agent.ctx);

    // ③ options only.
    agent.options = { provider: 'route-prov', model: 'route-model' };
    expect(await controller.current(agent as never)).toEqual({ provider: 'route-prov', model: 'route-model' });

    // ② header beats options.
    agent.session.requestHeader = () => ({ config: { provider: 'hdr', model: 'hdr-model' } });
    expect(await controller.current(agent as never)).toEqual({ provider: 'hdr', model: 'hdr-model' });

    // ① picked beats header.
    await controller.select(agent as never, { provider: 'picked', model: 'picked-model' });
    expect(await controller.current(agent as never)).toEqual({ provider: 'picked', model: 'picked-model' });

    // Re-picking clears the header fallback.
    await controller.select(agent as never, { provider: 'picked2', model: 'picked2-model', reasoningEffort: ReasoningEffortId('high') });
    expect(await controller.current(agent as never)).toEqual({ provider: 'picked2', model: 'picked2-model', reasoningEffort: ReasoningEffortId('high') });
  });

  it('falls back to the Harness-wide default model selection as the last resort', async () => {
    const rootCtx = new Context();
    rootCtx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'def', model: 'def-model', reasoningEffort: ReasoningEffortId('high') }),
    });
    const controller = new ChannelModelSelectionController(rootCtx);
    const agent = fakeScopedAgent(rootCtx, 's-default');
    controller.install(agent.ctx);
    // options empty + no header -> the root-provided default wins.
    expect(await controller.current(agent as never)).toEqual({ provider: 'def', model: 'def-model', reasoningEffort: ReasoningEffortId('high') });

    // options still win over the default (routing snapshot is nearer).
    agent.options = { provider: 'route-prov', model: 'route-model' };
    expect(await controller.current(agent as never)).toEqual({ provider: 'route-prov', model: 'route-model' });
  });

  it('returns undefined when nothing is resolvable', async () => {
    const rootCtx = new Context();
    const controller = new ChannelModelSelectionController(rootCtx);
    const agent = fakeScopedAgent(rootCtx, 's-empty');
    controller.install(agent.ctx);
    expect(await controller.current(agent as never)).toBeUndefined();
  });
});
