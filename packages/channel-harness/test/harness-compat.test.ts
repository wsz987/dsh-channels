/**
 * Real-contract Harness compatibility regression (pinned rc.6).
 *
 * This is a *pinned-contract* regression, not a live dsh loop: it pins the
 * exact rc.6 type/runtime surfaces the bridge consumes — `AgentRegistry`
 * (`get`/`create`/`resume`/`list`, `create`/`resume` option shapes, the
 * `AgentHandle` the gateway wraps) and the `session/event` vocabulary
 * (`KNOWN_SESSION_EVENT_TYPES`) — mirroring Phase 14's intent as far as this
 * repo can without the dsh runtime.
 */
import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import CommandRuntime, { parseCommand, type CommandResult } from '@deepseek-ai/dsh-commands';
import { createScope } from '@deepseek-ai/dsh-scope';
import type { Agent } from '@deepseek-ai/dsh-agent';
import {
  AgentRegistry,
  type AgentFactory,
  type AgentHandle,
  type AgentOptions,
  type CreateAgentOptions,
  type ResumeAgentOptions,
} from '@deepseek-ai/dsh-agent';
import { KNOWN_SESSION_EVENT_TYPES, SessionId } from '@deepseek-ai/dsh-session';
import {
  HarnessAgentGateway,
  resolveRoute,
  type AgentGateway,
  type AgentRouteSpec,
  type DefaultModelSelection,
  type GatewayAgentHandle,
} from '../src/agent-manager.ts';
import type { AgentRouteSpec as RouteSpec } from '../src/agent-router.ts';

/** Stub `AgentHandle` shaped like the pinned rc.6 contract. */
function makeHandle(id: SessionId): AgentHandle {
  return {
    agent: {
      id,
      followup: () => {},
      steer: () => {},
      inject: () => {},
      whenIdle: async () => {},
    } as never,
    dispose: async () => {},
  };
}

const route: AgentRouteSpec = { preset: 'coding', provider: 'deepseek', model: 'deepseek-reasoner' };

describe('Harness compatibility (pinned rc.6 contract)', () => {
  it('AgentRegistry exposes get/create/resume/list', () => {
    const ctx = new Context();
    const agents = new AgentRegistry(ctx);
    expect(typeof agents.get).toBe('function');
    expect(typeof agents.create).toBe('function');
    expect(typeof agents.resume).toBe('function');
    expect(typeof agents.list).toBe('function');
  });

  it('create accepts { sessionId, agentOptions } and resume accepts { resumeSessionId }', async () => {
    const ctx = new Context();
    const agents = new AgentRegistry(ctx);

    const createOptions: CreateAgentOptions = {
      sessionId: SessionId('s-create'),
      agentOptions: { model: 'deepseek-chat' } satisfies AgentOptions,
    };
    const resumeOptions: ResumeAgentOptions = {
      resumeSessionId: SessionId('s-resume'),
    };
    expect(createOptions.sessionId).toBeDefined();
    expect(createOptions.agentOptions?.model).toBe('deepseek-chat');
    expect(resumeOptions.resumeSessionId).toBeDefined();

    const created: string[] = [];
    const resumed: string[] = [];
    agents.setFactory({
      createAgent: async (_owner, options) => {
        created.push(String(options.sessionId));
        return makeHandle(options.sessionId);
      },
      resume: async (_owner, options) => {
        resumed.push(String(options.resumeSessionId));
        return makeHandle(options.resumeSessionId);
      },
    } satisfies AgentFactory);

    const gateway: HarnessAgentGateway = new HarnessAgentGateway(ctx);
    const port: AgentGateway = gateway;

    const createdHandle = await port.create('s-create', route);
    expect(created).toEqual(['s-create']);
    await createdHandle.dispose();

    const resumedHandle = await port.resume('s-resume', route);
    expect(resumed).toEqual(['s-resume']);
    await resumedHandle.dispose();
  });

  it('create and resume route parity: the SAME route reaches both paths', async () => {
    const ctx = new Context();
    const agents = new AgentRegistry(ctx);
    const observed: { kind: 'create' | 'resume'; options?: AgentOptions }[] = [];
    agents.setFactory({
      createAgent: async (_owner, options) => {
        observed.push({ kind: 'create', options: options.agentOptions });
        return makeHandle(options.sessionId);
      },
      resume: async (_owner, options) => {
        observed.push({ kind: 'resume', options: options.agentOptions });
        return makeHandle(options.resumeSessionId);
      },
    } satisfies AgentFactory);

    const gateway = new HarnessAgentGateway(ctx);
    await gateway.create('s-parity', route);
    await gateway.resume('s-parity', route);
    expect(observed).toHaveLength(2);
    expect(observed[0]?.kind).toBe('create');
    expect(observed[1]?.kind).toBe('resume');
    // provider/model/maxTokens identical on both paths.
    expect(observed[0]?.options).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' });
    expect(observed[1]?.options).toEqual(observed[0]?.options);
  });

  it('create maps the preset into meta.agentPreset and leaves cwd to the caller', async () => {
    const ctx = new Context();
    const agents = new AgentRegistry(ctx);
    const createdMeta: { cwd?: string; agentPreset?: string }[] = [];
    agents.setFactory({
      createAgent: async (_owner, options) => {
        createdMeta.push(options.meta ?? {});
        return makeHandle(options.sessionId);
      },
      resume: async (_owner, options) => makeHandle(options.resumeSessionId),
    } satisfies AgentFactory);

    const gateway = new HarnessAgentGateway(ctx);
    await gateway.create('s-meta', { preset: 'coding' });
    // `{{cwd}}` reads session.header.cwd, but the cwd is the CALLER's concern
    // (the bridge picks it) — the gateway only maps the route preset into
    // meta.agentPreset and emits no cwd when none is supplied.
    expect(createdMeta).toEqual([{ agentPreset: 'coding' }]);
  });

  it('create with no meta emits no cwd field', async () => {
    const ctx = new Context();
    const agents = new AgentRegistry(ctx);
    const createdMeta: { cwd?: string; agentPreset?: string }[] = [];
    agents.setFactory({
      createAgent: async (_owner, options) => {
        createdMeta.push(options.meta ?? {});
        return makeHandle(options.sessionId);
      },
      resume: async (_owner, options) => makeHandle(options.resumeSessionId),
    } satisfies AgentFactory);

    const gateway = new HarnessAgentGateway(ctx);
    await gateway.create('s-meta', {});
    expect(createdMeta).toEqual([{}]);
  });

  it('create uses the caller-supplied cwd from meta when provided', async () => {
    const ctx = new Context();
    const agents = new AgentRegistry(ctx);
    const createdMeta: { cwd?: string }[] = [];
    agents.setFactory({
      createAgent: async (_owner, options) => {
        createdMeta.push(options.meta ?? {});
        return makeHandle(options.sessionId);
      },
      resume: async (_owner, options) => makeHandle(options.resumeSessionId),
    } satisfies AgentFactory);

    const gateway = new HarnessAgentGateway(ctx);
    await gateway.create('s-cwd', {}, undefined, { cwd: 'D:\\workspace\\dsh-channels' });
    expect(createdMeta).toEqual([{ cwd: 'D:\\workspace\\dsh-channels' }]);
  });

  it('create combines a caller-supplied cwd and the route preset', async () => {
    const ctx = new Context();
    const agents = new AgentRegistry(ctx);
    const createdMeta: { cwd?: string; agentPreset?: string }[] = [];
    agents.setFactory({
      createAgent: async (_owner, options) => {
        createdMeta.push(options.meta ?? {});
        return makeHandle(options.sessionId);
      },
      resume: async (_owner, options) => makeHandle(options.resumeSessionId),
    } satisfies AgentFactory);

    const gateway = new HarnessAgentGateway(ctx);
    await gateway.create('s-both', { preset: 'coding' }, undefined, { cwd: 'X' });
    expect(createdMeta).toEqual([{ cwd: 'X', agentPreset: 'coding' }]);
  });

  it('the AgentHandle shape the gateway wraps is { agent: { id, followup, steer, inject, whenIdle }, dispose }', async () => {
    const ctx = new Context();
    const agents = new AgentRegistry(ctx);
    let produced: AgentHandle | undefined;
    agents.setFactory({
      createAgent: async (_owner, options) => {
        const handle = makeHandle(options.sessionId);
        produced = handle;
        return handle;
      },
      resume: async (_owner, options) => makeHandle(options.resumeSessionId),
    } satisfies AgentFactory);

    const gateway = new HarnessAgentGateway(ctx);
    const wrapped: GatewayAgentHandle = await gateway.create('s-shape', route);

    expect(produced).toBeDefined();
    expect(produced?.agent.id).toBe(SessionId('s-shape'));
    expect(typeof produced?.agent.followup).toBe('function');
    expect(typeof produced?.agent.steer).toBe('function');
    expect(typeof produced?.agent.inject).toBe('function');
    expect(typeof produced?.agent.whenIdle).toBe('function');
    expect(typeof produced?.dispose).toBe('function');

    expect(wrapped.id).toBe(SessionId('s-shape'));
    expect(typeof wrapped.followup).toBe('function');
    expect(typeof wrapped.whenIdle).toBe('function');
    expect(typeof wrapped.dispose).toBe('function');
    await wrapped.dispose();
  });

  it('KNOWN_SESSION_EVENT_TYPES covers the event names ReplyRouter consumes', () => {
    for (const type of ['turn/start', 'assistant/chunk', 'assistant/message', 'turn/end']) {
      expect(KNOWN_SESSION_EVENT_TYPES.has(type)).toBe(true);
    }
  });
});

describe('resolveRoute (Harness default-model fallback)', () => {
  const fallback: DefaultModelSelection = { provider: 'deepseek', model: 'deepseek-chat' };

  it('keeps an explicit provider+model route', () => {
    const explicit = { provider: 'openai', model: 'gpt-5' };
    expect(resolveRoute(explicit, fallback)).toBe(explicit);
  });

  it('inherits the default model when both provider and model are unset', () => {
    expect(resolveRoute({}, fallback)).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
    expect(resolveRoute({ preset: 'standard' }, fallback)).toEqual({
      preset: 'standard',
      provider: 'deepseek',
      model: 'deepseek-chat',
    });
  });

  it('leaves the route unchanged when no default selection is available', () => {
    expect(resolveRoute({}, undefined)).toEqual({});
    expect(resolveRoute({ preset: 'x' }, undefined)).toEqual({ preset: 'x' });
  });

  it('keeps a model-only route unchanged (model already resolves {{model}})', () => {
    expect(resolveRoute({ model: 'weixin-agent' }, fallback)).toEqual({ model: 'weixin-agent' });
  });

  it('fills the model from the default when only a provider is pinned', () => {
    expect(resolveRoute({ provider: 'openai' }, fallback)).toEqual({
      provider: 'openai',
      model: 'deepseek-chat',
    });
  });
});

describe('HarnessAgentGateway default-model wiring', () => {
  it('applies the default model to agentOptions when the route omits provider/model', async () => {
    const ctx = new Context();
    const agents = new AgentRegistry(ctx);
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    });

    const observed: AgentOptions[] = [];
    agents.setFactory({
      createAgent: async (_owner, options) => {
        observed.push(options.agentOptions ?? {});
        return makeHandle(options.sessionId);
      },
      resume: async (_owner, options) => makeHandle(options.resumeSessionId),
    } satisfies AgentFactory);

    const gateway = new HarnessAgentGateway(ctx);
    await gateway.create('s-default', { preset: 'standard' });

    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
  });
});

describe('dsh-commands pinned contract (rc.6)', () => {
  it('parseCommand returns the official ParsedCommand shape and honors rawInput', () => {
    const parsed = parseCommand('/compact --deep');
    expect(parsed).toEqual({ name: 'compact', rawInput: ' --deep' });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parseCommand('plain text')).toBeUndefined();
    expect(parseCommand('/UPPER')).toBeUndefined();
  });

  it('CommandRuntime registers, lists, finds and executes the lifecycle', async () => {
    const ctx = new Context();
    new CommandRuntime(ctx);
    const registry = ctx.commands;
    const agent = scopedAgentFor(ctx, 's-commands');
    const disposer = registry.register({
      name: 'compact',
      description: 'Collect the session',
      handler: () => ({ kind: 'success', text: 'compacted' } as CommandResult),
    });
    expect(registry.find(agent, 'compact')).toBeDefined();
    expect(registry.list(agent).some((d) => d.name === 'compact')).toBe(true);
    const execution = await registry.execute(agent, '/compact', new AbortController().signal);
    expect(execution?.result).toEqual({ kind: 'success', text: 'compacted' });
    expect(execution?.commandId).toBeTruthy();
    expect(agentSessionEvents(agent)).toEqual(['command/run', 'command/done']);
    disposer();
  });

  it('execute resolves undefined for an unknown command and appends no lifecycle', async () => {
    const ctx = new Context();
    new CommandRuntime(ctx);
    const agent = scopedAgentFor(ctx, 's-unknown');
    const execution = await ctx.commands.execute(agent, '/missing', new AbortController().signal);
    expect(execution).toBeUndefined();
    expect(agentSessionEvents(agent)).toEqual([]);
  });

  it('normalizes success and error CommandResults at the registry boundary', async () => {
    const ctx = new Context();
    new CommandRuntime(ctx);
    const agent = scopedAgentFor(ctx, 's-norm');
    ctx.commands.register({ name: 'ok', description: 'x', handler: () => ({ kind: 'success' }) });
    ctx.commands.register({ name: 'fail', description: 'y', handler: () => ({ kind: 'error', text: 'nope' }) });
    const ok = await ctx.commands.execute(agent, '/ok', new AbortController().signal);
    const fail = await ctx.commands.execute(agent, '/fail', new AbortController().signal);
    expect(ok?.result).toEqual({ kind: 'success' });
    expect(fail?.result).toEqual({ kind: 'error', text: 'nope' });
  });

  it('AgentRegistry create/resume option shapes accept the setup field', () => {
    const ctx = new Context();
    new AgentRegistry(ctx);
    type SetupSpan = { setup?: (agentCtx: Context) => void | { commit(): void } };
    const createOptions = { sessionId: SessionId('s-setup'), setup: () => {} } as CreateAgentOptions & SetupSpan;
    const resumeOptions = { resumeSessionId: SessionId('s-setup'), setup: () => {} } as ResumeAgentOptions & SetupSpan;
    expect(typeof createOptions.setup).toBe('function');
    expect(typeof resumeOptions.setup).toBe('function');
  });
});

/** Mint an agent under a real scoped context so scoped command sighting works. */
function scopedAgentFor(ctx: Context, id: string) {
  const events: { type: string; data: unknown }[] = [];
  const agent = {
    id: SessionId(id),
    session: { id, append(type: string, data: unknown) { const e = { type, data }; events.push(e); return e; } },
    status: 'idle',
    ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    send: () => {},
    whenIdle: async () => {},
    options: {},
  } as unknown as Agent;
  const scoped = createScope(ctx, agent);
  agent.ctx = scoped.ctx;
  return Object.assign(agent, { __events: events });
}

function agentSessionEvents(agent: Agent): string[] {
  return (agent as unknown as { __events: { type: string }[] }).__events.map((e) => e.type);
}
