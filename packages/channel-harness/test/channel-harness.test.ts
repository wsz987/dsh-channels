import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { AgentRegistry } from '@deepseek-ai/dsh-agent';
import { ChannelService, type ChannelEvent, type MessageReceived } from '@dsh/channel-core';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import {
  AgentManager,
  HarnessAgentGateway,
  type AgentGateway,
  type AgentRouteSpec,
  type GatewayAgentHandle,
} from '../src/agent-manager.ts';
import { AgentRouter } from '../src/agent-router.ts';
import { FileBindingStore, MemoryBindingStore } from '../src/binding-store.ts';
import { ChannelHarnessBridge } from '../src/bridge.ts';
import { Config } from '../src/config.ts';
import { ReplyRouter, splitMessage } from '../src/reply-router.ts';
import { ReplyContextStore } from '../src/reply-context-store.ts';
import { SESSION_BINDING_SCHEMA_VERSION, bindingKey, sessionKey, type SessionBinding } from '../src/session-router.ts';
import { partsToText, toHarnessUserMessage } from '../src/message-converter.ts';
import { startBridge } from '../src/lifecycle.ts';

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

/** Minimal in-memory gateway recording every drive call and its route. */
class FakeGateway implements AgentGateway {
  canResumeValue = true;
  existsValue = false;
  failsPersistenceWith?: Error;
  live = new Map<string, GatewayAgentHandle>();
  createCalls: string[] = [];
  resumeCalls: string[] = [];
  createRoutes: (AgentRouteSpec | undefined)[] = [];
  resumeRoutes: (AgentRouteSpec | undefined)[] = [];
  createStarts: string[] = [];
  resumeStarts: string[] = [];
  disposed: string[] = [];
  followups: { sessionId: string; message: unknown }[] = [];
  failResumeWith?: Error;
  createGate?: () => Promise<void>;
  resumeGate?: () => Promise<void>;

  get(sessionId: string) {
    const agent = this.live.get(sessionId);
    if (!agent) return undefined;
    return { id: agent.id, followup: agent.followup, whenIdle: agent.whenIdle };
  }

  canResume(): boolean {
    return this.canResumeValue;
  }

  async exists(_sessionId: string): Promise<boolean> {
    if (this.failsPersistenceWith) throw this.failsPersistenceWith;
    return this.existsValue;
  }

  async create(sessionId: string, route: AgentRouteSpec) {
    this.createStarts.push(sessionId);
    if (this.createGate) await this.createGate();
    this.createCalls.push(sessionId);
    this.createRoutes.push(route);
    return this.makeHandle(sessionId);
  }

  async resume(sessionId: string, route: AgentRouteSpec) {
    if (this.failResumeWith) throw this.failResumeWith;
    this.resumeStarts.push(sessionId);
    if (this.resumeGate) await this.resumeGate();
    this.resumeCalls.push(sessionId);
    this.resumeRoutes.push(route);
    return this.makeHandle(sessionId);
  }

  private makeHandle(sessionId: string): GatewayAgentHandle {
    const handle: GatewayAgentHandle = {
      id: sessionId,
      followup: (message) => {
        this.followups.push({ sessionId, message });
      },
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

/** Minimal channel adapter recording outbound sends (buffered streaming). */
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
  stopped = false;

  constructor(id = 'fake') {
    this.id = id;
  }

  async start() {}
  async stop() {
    this.stopped = true;
  }
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
    message: {
      id: 'm1',
      content: [{ type: 'text', text: 'hello harness' }],
    },
    ...overrides,
  };
}

function fakeSession(id: string): Session {
  return { id } as unknown as Session;
}

function turnStartEvent(turn: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq: 0, time: Date.now(), data: { turn } };
}

function chunkEvent(turn: number, text: string): SessionEvent<'assistant/chunk'> {
  return {
    type: 'assistant/chunk',
    seq: 1,
    time: Date.now(),
    data: { turn, step: 0, chunk: { type: 'text-delta', index: 0, text } },
  };
}

function turnEndEvent(turn: number): SessionEvent<'turn/end'> {
  return {
    type: 'turn/end',
    seq: 2,
    time: Date.now(),
    data: { turn, reason: { kind: 'completed' } },
  };
}

function makeBinding(overrides: Partial<SessionBinding> = {}): SessionBinding {
  return {
    channelId: 'weixin',
    accountId: 'main',
    conversationId: 'user_123',
    sessionId: 's1',
    route: defaultRoute,
    schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** Seed a channel-inbound ReplyContext (register + claim) for one turn. */
function seededContext(store: ReplyContextStore, turn = 0, sessionId = 's1'): ReplyContextStore {
  store.register(`harness_${turn}`, {
    sessionId,
    context: { conversationType: 'dm', replyToMessageId: `qq_${turn}` },
  });
  store.claim({ sessionId, messageId: `harness_${turn}`, turn });
  return store;
}


describe('session binding', () => {
  it('builds canonical channel:account:conversation[:thread] keys', () => {
    expect(sessionKey({ channelId: 'weixin', accountId: 'main', conversationId: 'u1' })).toBe(
      'weixin:main:u1',
    );
    expect(
      sessionKey({
        channelId: 'lark',
        accountId: 't1',
        conversationId: 'c1',
        threadId: 'th1',
      }),
    ).toBe('lark:t1:c1:th1');
    expect(bindingKey(makeBinding({ channelId: 'qq', accountId: 'a', conversationId: 'g' }))).toBe(
      'qq:a:g',
    );
  });

  it('MemoryBindingStore round-trips', async () => {
    const store = new MemoryBindingStore();
    const binding = makeBinding();
    await store.put(binding);
    expect(await store.get('weixin:main:user_123')).toEqual(binding);
    await store.delete('weixin:main:user_123');
    expect(await store.get('weixin:main:user_123')).toBeUndefined();
  });

  it('FileBindingStore persists across instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-binding-'));
    try {
      const file = join(dir, 'bindings.json');
      const store = new FileBindingStore(file);
      const binding = makeBinding();
      await store.put(binding);

      const reopened = new FileBindingStore(file);
      expect(await reopened.get('weixin:main:user_123')).toEqual(binding);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('AgentManager', () => {
  let gateway: FakeGateway;

  beforeEach(() => {
    gateway = new FakeGateway();
  });

  it('resolves live agents without owning them', async () => {
    gateway.live.set('s1', {
      id: 's1',
      followup: () => {},
      whenIdle: () => Promise.resolve(),
      dispose: async () => {},
    });
    const manager = new AgentManager(gateway, silentLogger, 4);
    const ref = await manager.resolve('s1', defaultRoute);
    expect(ref.sessionId).toBe('s1');
    expect(gateway.createCalls).toEqual([]);
    expect(gateway.resumeCalls).toEqual([]);
    await manager.disposeAll();
    expect(gateway.disposed).toEqual([]); // live agents are never disposed
  });

  it('single-flights concurrent resolve for the same session', async () => {
    const manager = new AgentManager(gateway, silentLogger, 4);
    const [a, b] = await Promise.all([
      manager.resolve('s1', defaultRoute),
      manager.resolve('s1', defaultRoute),
    ]);
    expect(gateway.resumeCalls).toEqual(['s1']);
    expect(gateway.createCalls).toEqual([]);
    expect(a.sessionId).toBe(b.sessionId);
  });

  it('resumes persisted sessions via resolve (existing conversation)', async () => {
    const manager = new AgentManager(gateway, silentLogger, 4);
    await manager.resolve('s1', defaultRoute);
    expect(gateway.resumeCalls).toEqual(['s1']);
    expect(gateway.createCalls).toEqual([]);
  });

  it('create opens a NEW session directly (no resume)', async () => {
    const manager = new AgentManager(gateway, silentLogger, 4);
    await manager.create('s1', defaultRoute);
    expect(gateway.createCalls).toEqual(['s1']);
    expect(gateway.resumeCalls).toEqual([]);
  });

  it('existing binding + resume failure rejects loudly (no create fallback)', async () => {
    const manager = new AgentManager(gateway, silentLogger, 4);
    gateway.failResumeWith = new Error('session corruption: unsupported format');
    await expect(manager.resolve('s1', defaultRoute)).rejects.toThrow(/unsupported format/);
    expect(gateway.createCalls).toEqual([]);
  });

  it('existing binding + live agent resolves via get (no create, no resume)', async () => {
    gateway.live.set('s1', {
      id: 's1',
      followup: () => {},
      whenIdle: () => Promise.resolve(),
      dispose: async () => {},
    });
    const manager = new AgentManager(gateway, silentLogger, 4);
    const ref = await manager.resolve('s1', defaultRoute);
    expect(ref.sessionId).toBe('s1');
    expect(gateway.createCalls).toEqual([]);
    expect(gateway.resumeCalls).toEqual([]);
  });

  it('disposes owned handles exactly once on disposeAll', async () => {
    const manager = new AgentManager(gateway, silentLogger, 4);
    await manager.resolve('s1', defaultRoute);
    await manager.resolve('s2', defaultRoute);
    await manager.disposeAll();
    expect(gateway.disposed.sort()).toEqual(['s1', 's2']);
    await manager.disposeAll();
    expect(gateway.disposed.filter((id) => id === 's1')).toHaveLength(1);
  });

  it('rejects resolution after close', async () => {
    const manager = new AgentManager(gateway, silentLogger, 4);
    await manager.disposeAll();
    await expect(manager.resolve('s1', defaultRoute)).rejects.toThrow(/closed/);
  });

  it('serializes gateway create/resume across sessions with maxConcurrency: 1', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    gateway.resumeGate = () => gate;
    const manager = new AgentManager(gateway, silentLogger, 1);

    const first = manager.resolve('s1', defaultRoute);
    const second = manager.resolve('s2', defaultRoute);
    await vi.waitFor(() => {
      expect(gateway.resumeStarts).toEqual(['s1']);
    });
    expect(gateway.resumeStarts).toEqual(['s1']);
    expect(gateway.createStarts).toEqual([]);

    release();
    const [ref1, ref2] = await Promise.all([first, second]);
    expect(gateway.resumeStarts).toEqual(['s1', 's2']);
    expect(gateway.resumeCalls).toEqual(['s1', 's2']);
    expect(ref1.sessionId).toBe('s1');
    expect(ref2.sessionId).toBe('s2');
  });

  it('rejects queued resolves with a closed error when disposeAll runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    gateway.resumeGate = () => gate;
    const manager = new AgentManager(gateway, silentLogger, 1);

    const first = manager.resolve('s1', defaultRoute);
    const second = manager.resolve('s2', defaultRoute);
    await vi.waitFor(() => {
      expect(gateway.resumeStarts).toEqual(['s1']);
    });

    await manager.disposeAll();
    await expect(second).rejects.toThrow(/closed/);

    release();
    await expect(first).resolves.toBeDefined();
  });
});

describe('AgentRouter', () => {
  it('resolves to AgentRouteSpec with priority overrides > default, no agentId', () => {
    const router = new AgentRouter(baseConfig());
    expect(
      router.resolve({ channelId: 'weixin', accountId: 'main', conversationId: 'u1' }),
    ).toEqual({ model: 'weixin-agent' });
    expect(
      router.resolve({ channelId: 'lark', accountId: 'main', conversationId: 'u1' }),
    ).toEqual(defaultRoute);
  });
});
describe('message conversion', () => {
  it('converts structured parts to text and folds metadata', () => {
    const event = makeMessageEvent({
      message: {
        id: 'm1',
        content: [
          { type: 'text', text: 'look at ' },
          { type: 'image', url: 'https://x/a.png', alt: 'chart' },
        ],
      },
    });
    const message = toHarnessUserMessage(event);
    const text = message.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    expect(text).toContain('[channel=weixin sender=user_123 message=m1]');
    expect(text).toContain('look at ');
    expect(text).toContain('[image: chart]');
    expect(message.source).toEqual({ kind: 'plugin', plugin: 'channel-harness' });
  });

  it('maps every part kind without embedding raw payloads', () => {
    const text = partsToText([
      { type: 'audio', durationMs: 500 },
      { type: 'file', name: 'a.pdf' },
      { type: 'location', latitude: 1, longitude: 2 },
      { type: 'card', kind: 'ai' },
      { type: 'unsupported', reason: 'x' },
    ]);
    expect(text).toBe('[audio: 500ms][file: a.pdf][location: 1,2][card: ai][unsupported content]');
  });
});

describe('ReplyRouter', () => {
  it('buffers text-delta chunks and delivers once at turn/end', async () => {
    const adapter = new FakeAdapter('fake');
    const binding = makeBinding({ channelId: 'fake' });
    const router = new ReplyRouter({
      config: baseConfig().reply,
      getAdapter: () => adapter as never,
      getBinding: () => binding,
      replyContexts: seededContext(new ReplyContextStore(), 0),
      logger: silentLogger,
    });
    const session = fakeSession('s1');

    router.onSessionEvent(session, chunkEvent(0, 'hello '));
    router.onSessionEvent(session, chunkEvent(0, 'world'));
    router.onSessionEvent(session, turnEndEvent(0));

    await vi.waitFor(() => {
      expect(adapter.sent).toHaveLength(1);
    });
    expect(adapter.sent[0]?.text).toBe('hello world');
  });

  it('does not route a non-channel turn back to channel', async () => {
    const adapter = new FakeAdapter('fake');
    const binding = makeBinding({ channelId: 'fake' });
    // SessionBinding exists, but there is no ReplyContext: the turn was
    // triggered by another surface, so nothing may be delivered.
    const router = new ReplyRouter({
      config: baseConfig().reply,
      getAdapter: () => adapter as never,
      getBinding: () => binding,
      replyContexts: new ReplyContextStore(),
      logger: silentLogger,
    });
    const session = fakeSession('s1');

    router.onSessionEvent(session, chunkEvent(0, 'hello'));
    router.onSessionEvent(session, turnEndEvent(0));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.sent).toHaveLength(0);
  });

  it('flushes native/edit previews through createReply and finishes', async () => {
    const created: { finished: boolean; replaced: string }[] = [];
    const adapter = {
      id: 'native',
      capabilities: {
        text: true,
        image: false,
        file: false,
        audio: false,
        video: false,
        markdown: true,
        cards: true,
        reactions: false,
        threads: false,
        streaming: 'native',
      },
      start: async () => {},
      stop: async () => {},
      send: async () => ({ delivered: true }),
      createReply: async () => {
        const entry = { finished: false, replaced: '' };
        created.push(entry);
        return {
          append: async (delta: string) => {
            entry.replaced += delta;
          },
          replace: async (message: { text?: string }) => {
            entry.replaced = message.text ?? '';
          },
          finish: async () => {
            entry.finished = true;
          },
          fail: async () => {},
        };
      },
    };
    const binding = makeBinding({ channelId: 'native' });
    const router = new ReplyRouter({
      config: { ...baseConfig().reply, updateIntervalMs: 0 },
      getAdapter: () => adapter as never,
      getBinding: () => binding,
      replyContexts: seededContext(new ReplyContextStore(), 0),
      logger: silentLogger,
    });
    const session = fakeSession('s1');

    router.onSessionEvent(session, chunkEvent(0, 'hi'));
    await vi.waitFor(() => {
      expect(created).toHaveLength(1);
    });
    router.onSessionEvent(session, turnEndEvent(0));
    await vi.waitFor(() => {
      expect(created[0]?.finished).toBe(true);
    });
    expect(created[0]?.replaced).toBe('hi');
  });

  it('splits oversized messages across sends', async () => {
    const adapter = new FakeAdapter('fake');
    const binding = makeBinding({ channelId: 'fake' });
    const router = new ReplyRouter({
      config: { ...baseConfig().reply, maxTextLength: 10 },
      getAdapter: () => adapter as never,
      getBinding: () => binding,
      replyContexts: seededContext(new ReplyContextStore(), 0),
      logger: silentLogger,
    });
    const session = fakeSession('s1');
    router.onSessionEvent(session, chunkEvent(0, 'abcdefghij klmnopqrst'));
    router.onSessionEvent(session, turnEndEvent(0));
    await vi.waitFor(() => {
      expect(adapter.sent.length).toBeGreaterThan(1);
    });
  });

  it('clears timers on dispose', () => {
    const router = new ReplyRouter({
      config: { ...baseConfig().reply, updateIntervalMs: 1000 },
      getAdapter: () => new FakeAdapter('fake') as never,
      getBinding: () => undefined,
      replyContexts: new ReplyContextStore(),
      logger: silentLogger,
    });
    const session = fakeSession('s1');
    router.onSessionEvent(session, chunkEvent(0, 'x'));
    router.dispose();
    expect(router.activeSessions()).toEqual([]);
  });

  it('splitMessage keeps code fences intact and respects finalFlush', () => {
    const cfg = { splitParagraphs: true, splitCodeBlocks: true, finalFlush: true };
    const pieces = splitMessage('a'.repeat(100), 20, cfg);
    expect(pieces.every((p) => p.length <= 20)).toBe(true);
    expect(pieces.join('')).toBe('a'.repeat(100));

    const fenced = splitMessage(
      'para one.\n\n```js\nlet x = 1;\n```\n\npara two with padding',
      40,
      cfg,
    );
    expect(fenced.some((p) => p.startsWith('```js') && p.endsWith('```'))).toBe(true);

    const trimmed = splitMessage('a'.repeat(30), 20, {
      ...cfg,
      finalFlush: false,
    });
    expect(trimmed.join('')).toBe('a'.repeat(20));
  });
});
describe('ChannelHarnessBridge end-to-end', () => {
  it('routes message.received to followup and registers a binding', async () => {
    const gateway = new FakeGateway();
    const manager = new AgentManager(gateway, silentLogger, 4);
    const router = new AgentRouter(baseConfig());
    const bindingStore = new MemoryBindingStore();
    const bridge = new ChannelHarnessBridge({
      config: baseConfig(),
      bindingStore,
      agentManager: manager,
      agentRouter: router,
      getAdapter: () => new FakeAdapter('weixin') as never,
      replyContexts: new ReplyContextStore(),
      logger: silentLogger,
    });

    const event = makeMessageEvent();
    await bridge.handleChannelEvent(event);

    // New conversation (no binding) -> create, then persist the binding.
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.resumeCalls).toHaveLength(0);
    expect(gateway.followups).toHaveLength(1);
    const binding = await bindingStore.get('weixin:main:user_123');
    expect(binding?.sessionId).toBe(gateway.createCalls[0]);
    expect(binding?.route).toEqual({ model: 'weixin-agent' });
    expect(binding?.schemaVersion).toBe(2);
    expect(manager.bindingFor(binding!.sessionId)).toEqual(binding);
  });

  it('reuses the same session for the same conversation', async () => {
    const gateway = new FakeGateway();
    const manager = new AgentManager(gateway, silentLogger, 4);
    const bridge = new ChannelHarnessBridge({
      config: baseConfig(),
      bindingStore: new MemoryBindingStore(),
      agentManager: manager,
      agentRouter: new AgentRouter(baseConfig()),
      getAdapter: () => new FakeAdapter('weixin') as never,
      replyContexts: new ReplyContextStore(),
      logger: silentLogger,
    });
    await bridge.handleChannelEvent(makeMessageEvent({ message: { id: 'm1', content: [{ type: 'text', text: 'a' }] } }));
    await bridge.handleChannelEvent(makeMessageEvent({ message: { id: 'm2', content: [{ type: 'text', text: 'b' }] } }));
    expect([...gateway.resumeCalls, ...gateway.createCalls]).toHaveLength(1);
    expect(gateway.followups).toHaveLength(2);
  });

  it('startBridge wires a Cordis context and drains on dispose', async () => {
    const ctx = new Context();
    new ChannelService(ctx);
    const agents = new AgentRegistry(ctx);
    agents.setFactory({
      createAgent: async (_owner, options) => ({
        agent: {
          id: options.sessionId,
          followup: () => {},
          whenIdle: async () => {},
        } as never,
        dispose: async () => {},
      }),
      resume: async (_owner, options) => ({
        agent: {
          id: options.resumeSessionId,
          followup: () => {},
          whenIdle: async () => {},
        } as never,
        dispose: async () => {},
      }),
    });

    const adapter = new FakeAdapter('fake');
    ctx.channels.register(adapter as never);

    const lifecycle = startBridge(ctx, baseConfig());
    await lifecycle.handleChannelEvent(makeMessageEvent({ channel: 'fake' as never }));
    await lifecycle.dispose();
    expect(adapter.stopped).toBe(false); // adapter owned by its own plugin fiber
  });

  it('keeps the session/event listener attached while draining so in-flight replies finalize', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-drain-'));
    try {
      const file = join(dir, 'bindings.json');
      const seed = new FileBindingStore(file);
      await seed.put(makeBinding({ conversationId: 'user_123', sessionId: 'seed-session' }));

      const ctx = new Context();
      new ChannelService(ctx);
      const agents = new AgentRegistry(ctx);
      const idleResolvers: Array<() => void> = [];
      let harnessMessageId: string | undefined;
      const followup = (message: { id: string }) => {
        harnessMessageId = message.id;
      };
      agents.setFactory({
        createAgent: async (_owner, options) => ({
          agent: {
            id: options.sessionId,
            followup,
            whenIdle: () =>
              new Promise<void>((resolve) => idleResolvers.push(resolve)),
          } as never,
          dispose: async () => {},
        }),
        resume: async (_owner, options) => ({
          agent: {
            id: options.resumeSessionId,
            followup,
            whenIdle: () =>
              new Promise<void>((resolve) => idleResolvers.push(resolve)),
          } as never,
          dispose: async () => {},
        }),
      });
      const adapter = new FakeAdapter('weixin');
      ctx.channels.register(adapter as never);

      const lifecycle = startBridge(ctx, {
        ...baseConfig(),
        bindingStore: { type: 'file', path: file },
      });
      await lifecycle.handleChannelEvent(makeMessageEvent());

      // Model the agent's `agent/inbox/claimed`: move the registered context
      // into the active `seed-session`+turn 0 slot so the reply router has a
      // channel ReplyContext.
      ctx.emit('agent/inbox/claimed', {
        agent: { session: { id: 'seed-session' } },
        message: { id: harnessMessageId },
        turn: 0,
      });

      const session = fakeSession('seed-session');
      ctx.emit('session/event', session, turnStartEvent(0));
      ctx.emit('session/event', session, chunkEvent(0, 'hello '));

      const disposePromise = lifecycle.dispose();
      await vi.waitFor(() => {
        expect(idleResolvers).toHaveLength(1);
      });
      ctx.emit('session/event', session, turnEndEvent(0));
      await vi.waitFor(() => {
        expect(adapter.sent).toHaveLength(1);
      });
      idleResolvers[0]?.();
      await disposePromise;

      expect(adapter.sent[0]?.text).toBe('hello ');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('flushAll delivers buffered content for turns that never ended at dispose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-flush-'));
    try {
      const file = join(dir, 'bindings.json');
      const seed = new FileBindingStore(file);
      await seed.put(makeBinding({ conversationId: 'user_123', sessionId: 'seed-session' }) satisfies SessionBinding);

      const ctx = new Context();
      new ChannelService(ctx);
      const agents = new AgentRegistry(ctx);
      let harnessMessageId: string | undefined;
      const followup = (message: { id: string }) => {
        harnessMessageId = message.id;
      };
      agents.setFactory({
        createAgent: async (_owner, options) => ({
          agent: {
            id: options.sessionId,
            followup,
            whenIdle: async () => {},
          } as never,
          dispose: async () => {},
        }),
        resume: async (_owner, options) => ({
          agent: {
            id: options.resumeSessionId,
            followup,
            whenIdle: async () => {},
          } as never,
          dispose: async () => {},
        }),
      });
      const adapter = new FakeAdapter('weixin');
      ctx.channels.register(adapter as never);

      const lifecycle = startBridge(ctx, {
        ...baseConfig(),
        bindingStore: { type: 'file', path: file },
      });
      await lifecycle.handleChannelEvent(makeMessageEvent());

      // Model the agent's `agent/inbox/claimed` for turn 0.
      ctx.emit('agent/inbox/claimed', {
        agent: { session: { id: 'seed-session' } },
        message: { id: harnessMessageId },
        turn: 0,
      });

      const session = fakeSession('seed-session');
      ctx.emit('session/event', session, turnStartEvent(0));
      ctx.emit('session/event', session, chunkEvent(0, 'partial reply'));
      await lifecycle.dispose();

      expect(adapter.sent[0]?.text).toBe('partial reply');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('startBridge reuses the persisted session binding across restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-restart-'));
    try {
      const file = join(dir, 'bindings.json');

      async function runBridge(): Promise<string> {
        const ctx = new Context();
        new ChannelService(ctx);
        const agents = new AgentRegistry(ctx);
        agents.setFactory({
          createAgent: async (_owner, options) => ({
            agent: {
              id: options.sessionId,
              followup: () => {},
              whenIdle: async () => {},
            } as never,
            dispose: async () => {},
          }),
          resume: async (_owner, options) => ({
            agent: {
              id: options.resumeSessionId,
              followup: () => {},
              whenIdle: async () => {},
            } as never,
            dispose: async () => {},
          }),
        });
        const adapter = new FakeAdapter('weixin');
        ctx.channels.register(adapter as never);
        const lifecycle = startBridge(ctx, {
          ...baseConfig(),
          bindingStore: { type: 'file', path: file },
        });
        await lifecycle.handleChannelEvent(makeMessageEvent());
        await lifecycle.dispose();
        const store = new FileBindingStore(file);
        const binding = await store.get('weixin:main:user_123');
        return binding?.sessionId ?? '';
      }

      const firstSessionId = await runBridge();
      const secondSessionId = await runBridge();

      expect(firstSessionId).toBeTruthy();
      expect(secondSessionId).toBe(firstSessionId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('HarnessAgentGateway against real dsh types', () => {
  it('maps agent methods onto the gateway surface (compile + basic shape)', () => {
    const ctx = new Context();
    new AgentRegistry(ctx);
    const gateway = new HarnessAgentGateway(ctx);
    expect(gateway.canResume()).toBe(false); // no persistence service mounted
    expect(gateway.get('s1')).toBeUndefined();
  });
});

describe('bridge integration with ChannelService events', () => {
  it('forwards adapter events into the bridge', async () => {
    const ctx = new Context();
    const service = new ChannelService(ctx);
    const adapter = new FakeAdapter('weixin');
    service.register(adapter as never);

    const gateway = new FakeGateway();
    const manager = new AgentManager(gateway, silentLogger, 4);
    const bridge = new ChannelHarnessBridge({
      config: baseConfig(),
      bindingStore: new MemoryBindingStore(),
      agentManager: manager,
      agentRouter: new AgentRouter(baseConfig()),
      getAdapter: (id) => service.get(id),
      replyContexts: new ReplyContextStore(),
      logger: silentLogger,
    });

    const stopInbound = service.on((event: ChannelEvent) => {
      void bridge.handleChannelEvent(event);
    });

    const event = makeMessageEvent();
    await service.emit(event);
    await vi.waitFor(() => {
      expect(gateway.followups).toHaveLength(1);
    });
    expect(gateway.followups[0]?.sessionId).toBeTruthy();
    stopInbound();
  });
});
