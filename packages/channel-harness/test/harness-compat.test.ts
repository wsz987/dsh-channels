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
  type AgentGateway,
  type GatewayAgentHandle,
} from '../src/agent-manager.ts';

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

    // Type-level: the exact option shapes the bridge passes through the gateway.
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

    // Mirror the startBridge test: install a stub factory and drive the real
    // registry through a HarnessAgentGateway assigned to the AgentGateway port.
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

    const gateway: HarnessAgentGateway = new HarnessAgentGateway(ctx, {
      model: 'deepseek-chat',
    });
    const port: AgentGateway = gateway;

    const createdHandle = await port.create('s-create', 'default');
    expect(created).toEqual(['s-create']);
    await createdHandle.dispose();

    const resumedHandle = await port.resume('s-resume');
    expect(resumed).toEqual(['s-resume']);
    await resumedHandle.dispose();
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
    const wrapped: GatewayAgentHandle = await gateway.create('s-shape', 'default');

    // The pinned AgentHandle contract the gateway relies on.
    expect(produced).toBeDefined();
    expect(produced?.agent.id).toBe(SessionId('s-shape'));
    expect(typeof produced?.agent.followup).toBe('function');
    expect(typeof produced?.agent.steer).toBe('function');
    expect(typeof produced?.agent.inject).toBe('function');
    expect(typeof produced?.agent.whenIdle).toBe('function');
    expect(typeof produced?.dispose).toBe('function');

    // The gateway surface exposes id + the drive methods + dispose.
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
