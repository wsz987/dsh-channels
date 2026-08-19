/*
 * Access Gate integration tests (execution plan §32, §33, §54).
 *
 * Verifies that the FAIL-CLOSED Access Gate runs before EVERY side effect:
 * agent.followup, session create/resume, binding writes, command plane
 * (/new, /agent), and the /stop fast path (no cancel, no generation bump).
 * Also covers missing/corrupt policy (no agent side effect), the reserved
 * /dsh-claim suppression, that authorized messages preserve the existing
 * behavior, and the §33 regression that an authorized /stop still works.
 *
 * Fixture mirrors channel-harness.test.ts / stop.test.ts (FakeGateway +
 * MemoryBindingStore + no-op workshop) with a configurable stub resolver.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import type { ChannelAccessPolicy, MessageReceived } from '@wsz987/channel-core';
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
import type { ChannelAccessPolicyResolver, ResolvedAccessPolicy } from '../src/access/resolver.ts';

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

const openDm: ChannelAccessPolicy = {
  version: 1,
  preset: 'owner-only',
  dmPolicy: 'open',
  allowFrom: [],
  groupPolicy: 'disabled',
  groups: {},
};
const denyDm: ChannelAccessPolicy = {
  version: 1,
  preset: 'owner-only',
  dmPolicy: 'disabled',
  allowFrom: [],
  groupPolicy: 'disabled',
  groups: {},
};
/** Allowlist that does NOT include the default sender `user_123`. */
const denyAllowlist: ChannelAccessPolicy = {
  version: 1,
  preset: 'allowlist',
  dmPolicy: 'allowlist',
  allowFrom: ['other-user'],
  groupPolicy: 'disabled',
  groups: {},
};

class StubResolver implements ChannelAccessPolicyResolver {
  resolveState: ResolvedAccessPolicy = { state: 'present', policy: openDm };
  resolve = vi.fn(async (_channelId: string, _accountId: string): Promise<ResolvedAccessPolicy> => {
    return this.resolveState;
  });
}

class FakeAdapter {
  id = 'weixin';
  capabilities = { text: true, image: false, file: false, audio: false, video: false, markdown: true, cards: false, reactions: false, threads: false, streaming: 'buffered' } as const;
  sent: { text?: string }[] = [];
  async start() {}
  async stop() {}
  async send(_target: unknown, message: { text?: string }) {
    this.sent.push(message);
    return { delivered: true };
  }
}

/** Minimal gateway recording every create and every followup. */
class FakeGateway implements AgentGateway {
  canResumeValue = false;
  existsValue = false;
  live = new Map<string, GatewayAgentHandle>();
  createCalls: string[] = [];
  resumeCalls: string[] = [];
  followups: { sessionId: string; message: unknown }[] = [];
  cancels: string[] = [];
  disposed: string[] = [];

  get(sessionId: string) {
    const h = this.live.get(sessionId);
    if (!h) return undefined;
    return { id: h.id, agent: h.agent, followup: h.followup, whenIdle: h.whenIdle };
  }
  canResume(): boolean { return this.canResumeValue; }
  async exists(): Promise<boolean> { return this.existsValue; }
  async create(sessionId: string, _route: AgentRouteSpec) {
    this.createCalls.push(sessionId);
    return this.handle(sessionId);
  }
  async resume(sessionId: string, _route: AgentRouteSpec) {
    this.resumeCalls.push(sessionId);
    return this.handle(sessionId);
  }
  private handle(sessionId: string): GatewayAgentHandle {
    const handle: GatewayAgentHandle = {
      id: sessionId,
      agent: {
        id: sessionId,
        cancel: (opts?: unknown) => {
          this.cancels.push(sessionId);
          void opts;
        },
      } as never,
      followup: (message) => { this.followups.push({ sessionId, message }); },
      whenIdle: () => Promise.resolve(),
      dispose: async () => {
        this.disposed.push(sessionId);
        this.live.delete(sessionId);
      },
    };
    this.live.set(sessionId, handle);
    return handle;
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

function textEvent(id: string, text: string): Partial<MessageReceived> {
  return { message: { id, content: [{ type: 'text', text }] } };
}

interface Fixture {
  gateway: FakeGateway;
  bindingStore: MemoryBindingStore;
  resolver: StubResolver;
  adapter: FakeAdapter;
  bridge: ChannelHarnessBridge;
}

function makeFixture(resolver: StubResolver): Fixture {
  const gateway = new FakeGateway();
  const manager = new AgentManager(gateway, silentLogger, 4);
  const bindingStore = new MemoryBindingStore();
  const adapter = new FakeAdapter();
  const bridge = new ChannelHarnessBridge({
    config: baseConfig(),
    bindingStore,
    agentManager: manager,
    agentRouter: new AgentRouter(baseConfig()),
    getAdapter: () => adapter as never,
    replyContexts: new ReplyContextStore(),
    logger: silentLogger,
    accessResolver: resolver,
    accessLogger: silentLogger,
    ctx: new Context(),
    commandDeps: { startNewSession: async () => {} },
    workspaceResolver: noopResolver,
  });
  return { gateway, bindingStore, resolver, adapter, bridge };
}

describe('Fail-closed Access Gate (plan §54)', () => {
  it('unauthorized plain message -> NO agent side effect (no followup, no session)', async () => {
    const { gateway, bindingStore, resolver, bridge } = makeFixture(new StubResolver());
    resolver.resolveState = { state: 'present', policy: denyDm };
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    expect(gateway.followups).toHaveLength(0);
    expect(gateway.createCalls).toHaveLength(0);
    expect(gateway.resumeCalls).toHaveLength(0);
    expect(await bindingStore.get('weixin:main:user_123')).toBeUndefined();
  });

  it('unauthorized /new -> NO session create, NO binding write', async () => {
    const { gateway, bindingStore, resolver, bridge } = makeFixture(new StubResolver());
    resolver.resolveState = { state: 'present', policy: denyDm };
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/new')));
    expect(gateway.createCalls).toHaveLength(0);
    expect(await bindingStore.get('weixin:main:user_123')).toBeUndefined();
  });

  it('unauthorized /agent -> NO agent switch/create', async () => {
    const { gateway, bindingStore, resolver, bridge } = makeFixture(new StubResolver());
    resolver.resolveState = { state: 'present', policy: denyDm };
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/agent')));
    expect(gateway.createCalls).toHaveLength(0);
    expect(gateway.resumeCalls).toHaveLength(0);
    expect(gateway.followups).toHaveLength(0);
    expect(await bindingStore.get('weixin:main:user_123')).toBeUndefined();
  });

  it('unauthorized /stop -> NO cancel, NO generation bump, NO ack notice (plan §33)', async () => {
    // Establish a live agent as an authorized user first.
    const { gateway, bindingStore, resolver, adapter, bridge } = makeFixture(new StubResolver());
    resolver.resolveState = { state: 'present', policy: openDm };
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m0', 'hello')));
    expect(gateway.followups).toHaveLength(1);
    const sessionId = gateway.createCalls[0]!;
    expect(gateway.cancels).toHaveLength(0);

    // Now the SAME sender is unauthorized -> the /stop must not cancel.
    resolver.resolveState = { state: 'present', policy: denyDm };
    const sentBefore = adapter.sent.length;
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/stop')));
    expect(gateway.cancels).toHaveLength(0);
    expect(adapter.sent.length).toBe(sentBefore); // no "已停止" ack
    expect(await bindingStore.get('weixin:main:user_123')).toBeTruthy(); // binding untouched
    void sessionId;

    // Authorization restored -> an ordinary message is still handled (proves the
    // unauthorized /stop did not poison the generation / chain).
    resolver.resolveState = { state: 'present', policy: openDm };
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', 'still here')));
    expect(gateway.followups.length).toBeGreaterThanOrEqual(2);
  });

  it('missing policy -> NO agent side effect', async () => {
    const { gateway, bindingStore, resolver, bridge } = makeFixture(new StubResolver());
    resolver.resolveState = { state: 'missing' };
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/new')));
    expect(gateway.createCalls).toHaveLength(0);
    expect(gateway.followups).toHaveLength(0);
    expect(await bindingStore.get('weixin:main:user_123')).toBeUndefined();
  });

  it('corrupt/invalid policy -> NO agent side effect', async () => {
    const { gateway, bindingStore, resolver, bridge } = makeFixture(new StubResolver());
    resolver.resolveState = { state: 'invalid', error: 'bad' };
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/new')));
    expect(gateway.createCalls).toHaveLength(0);
    expect(gateway.followups).toHaveLength(0);
    expect(await bindingStore.get('weixin:main:user_123')).toBeUndefined();
  });

  it('unidentified sender / unknown identity -> dropped before anything', async () => {
    const { gateway, bindingStore, bridge } = makeFixture(new StubResolver());
    await bridge.handleChannelEvent(
      makeMessageEvent({ sender: { id: 'unknown', name: 'x' } as never, ...textEvent('m1', '/new') }),
    );
    // /stop must also be dropped for an unidentified sender.
    await bridge.handleChannelEvent(
      makeMessageEvent({ sender: { id: '', name: 'x' } as never, ...textEvent('m2', '/stop') }),
    );
    expect(gateway.createCalls).toHaveLength(0);
    expect(gateway.followups).toHaveLength(0);
    expect(gateway.cancels).toHaveLength(0);
    expect(await bindingStore.get('weixin:main:user_123')).toBeUndefined();
  });

  it('authorized message preserves the existing behavior (create + followup + binding)', async () => {
    const { gateway, bindingStore, resolver, bridge } = makeFixture(new StubResolver());
    resolver.resolveState = { state: 'present', policy: openDm };
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.followups).toHaveLength(1);
    const binding = await bindingStore.get('weixin:main:user_123');
    expect(binding?.sessionId).toBe(gateway.createCalls[0]);
  });

  it('reserved /dsh-claim never reaches agent/command/session/binding (plan §20, §34)', async () => {
    const { gateway, bindingStore, resolver, adapter, bridge } = makeFixture(new StubResolver());
    resolver.resolveState = { state: 'present', policy: openDm };
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', '/dsh-claim SECRETCODE123')));
    expect(gateway.createCalls).toHaveLength(0);
    expect(gateway.followups).toHaveLength(0);
    expect(await bindingStore.get('weixin:main:user_123')).toBeUndefined();
    // Never emitted as a command notice either.
    expect(adapter.sent).toHaveLength(0);
  });

  it('authorized /stop still works (plan §33 regression)', async () => {
    const { gateway, resolver, adapter, bridge } = makeFixture(new StubResolver());
    resolver.resolveState = { state: 'present', policy: openDm };
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m1', 'hello')));
    expect(gateway.cancels).toHaveLength(0);
    await bridge.handleChannelEvent(makeMessageEvent(textEvent('m2', '/stop')));
    // The /stop FAST PATH ran (fallback cancel + the stop barrier re-cancel),
    // so the live agent is cancelled at least once and the user is acknowledged
    // immediately — i.e. authorized /stop keeps its scheduling semantics.
    expect(gateway.cancels.length).toBeGreaterThan(0);
    expect(adapter.sent.map((s) => s.text)).toContain('已停止当前任务。');
  });
});
