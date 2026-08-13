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
  isPersistenceError,
  type AgentGateway,
  type GatewayAgentHandle,
} from '../src/agent-manager.ts';
import { AgentRouter } from '../src/agent-router.ts';
import { FileBindingStore, MemoryBindingStore } from '../src/binding-store.ts';
import { ChannelHarnessBridge } from '../src/bridge.ts';
import { Config } from '../src/config.ts';
import { ReplyRouter, splitMessage } from '../src/reply-router.ts';
import { bindingKey, sessionKey, type SessionBinding } from '../src/session-router.ts';
import { partsToText, toHarnessUserMessage } from '../src/message-converter.ts';
import { startBridge } from '../src/lifecycle.ts';

function baseConfig(): Config {
  return Config({
    defaultAgentId: 'default',
    routing: {
      mode: 'global',
      overrides: {
        channel: { 'weixin': 'weixin-agent' },
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
    agentOptions: undefined,
  });
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Minimal in-memory gateway recording every drive call. */
class FakeGateway implements AgentGateway {
  supportsResume = true;
  live = new Map<string, GatewayAgentHandle>();
  createCalls: string[] = [];
  resumeCalls: string[] = [];
  disposed: string[] = [];
  followups: { sessionId: string; message: unknown }[] = [];
  failResumeWith?: Error;

  get(sessionId: string) {
    const agent = this.live.get(sessionId);
    if (!agent) return undefined;
    return { id: agent.id, followup: agent.followup, whenIdle: agent.whenIdle };
  }

  async create(sessionId: string, agentId: string) {
    this.createCalls.push(sessionId);
    return this.makeHandle(sessionId);
  }

  async resume(sessionId: string) {
    if (this.failResumeWith) throw this.failResumeWith;
    this.resumeCalls.push(sessionId);
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
    expect(bindingKey({ channelId: 'qq', accountId: 'a', conversationId: 'g' } as SessionBinding)).toBe(
      'qq:a:g',
    );
  });

  it('MemoryBindingStore round-trips', async () => {
    const store = new MemoryBindingStore();
    const binding: SessionBinding = {
      channelId: 'weixin',
      accountId: 'main',
      conversationId: 'u1',
      sessionId: 'ch-1',
      createdAt: 1,
      updatedAt: 1,
    };
    await store.put(binding);
    expect(await store.get('weixin:main:u1')).toEqual(binding);
    await store.delete('weixin:main:u1');
    expect(await store.get('weixin:main:u1')).toBeUndefined();
  });

  it('FileBindingStore persists across instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-binding-'));
    try {
      const file = join(dir, 'bindings.json');
      const store = new FileBindingStore(file);
      const binding: SessionBinding = {
        channelId: 'weixin',
        accountId: 'main',
        conversationId: 'u1',
        sessionId: 'ch-1',
        createdAt: 1,
        updatedAt: 1,
      };
      await store.put(binding);

      const reopened = new FileBindingStore(file);
      expect(await reopened.get('weixin:main:u1')).toEqual(binding);
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
    const manager = new AgentManager(gateway, silentLogger);
    const ref = await manager.resolve('s1', 'default');
    expect(ref.sessionId).toBe('s1');
    expect(gateway.createCalls).toEqual([]);
    expect(gateway.resumeCalls).toEqual([]);
    await manager.disposeAll();
    expect(gateway.disposed).toEqual([]); // live agents are never disposed
  });

  it('single-flights concurrent resolve for the same session', async () => {
    const manager = new AgentManager(gateway, silentLogger);
    const [a, b] = await Promise.all([
      manager.resolve('s1', 'default'),
      manager.resolve('s1', 'default'),
    ]);
    // FakeGateway.supportsResume is true, so resolve takes the resume path.
    expect(gateway.resumeCalls).toEqual(['s1']);
    expect(gateway.createCalls).toEqual([]);
    expect(a.sessionId).toBe(b.sessionId);
  });

  it('resumes persisted sessions and falls back to create on persistence errors', async () => {
    const manager = new AgentManager(gateway, silentLogger);
    await manager.resolve('s1', 'default');
    expect(gateway.resumeCalls).toEqual(['s1']);
    expect(gateway.createCalls).toEqual([]);

    gateway.resumeCalls = [];
    gateway.failResumeWith = new Error('sessionPersistence not configured');
    await manager.resolve('s2', 'default');
    expect(gateway.createCalls).toContain('s2');
  });

  it('disposes owned handles exactly once on disposeAll', async () => {
    const manager = new AgentManager(gateway, silentLogger);
    await manager.resolve('s1', 'default');
    await manager.resolve('s2', 'default');
    await manager.disposeAll();
    expect(gateway.disposed.sort()).toEqual(['s1', 's2']);
    await manager.disposeAll();
    expect(gateway.disposed.filter((id) => id === 's1')).toHaveLength(1);
  });

  it('rejects resolution after close', async () => {
    const manager = new AgentManager(gateway, silentLogger);
    await manager.disposeAll();
    await expect(manager.resolve('s1', 'default')).rejects.toThrow(/closed/);
  });

  it('isPersistenceError classifies persistence messages', () => {
    expect(isPersistenceError(new Error('session persistence unavailable'))).toBe(true);
    expect(isPersistenceError(new Error('boom'))).toBe(false);
    expect(isPersistenceError('nope')).toBe(false);
  });
});

describe('AgentRouter', () => {
  it('prioritizes binding > overrides > default', () => {
    const router = new AgentRouter(baseConfig());
    expect(
      router.resolve({ channelId: 'weixin', accountId: 'main', conversationId: 'u1' }),
    ).toBe('weixin-agent');
    expect(
      router.resolve({
        channelId: 'weixin',
        accountId: 'main',
        conversationId: 'u1',
        bindingAgentId: 'bound-agent',
      }),
    ).toBe('bound-agent');
    expect(
      router.resolve({ channelId: 'lark', accountId: 'main', conversationId: 'u1' }),
    ).toBe('default');
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
    const binding: SessionBinding = {
      channelId: 'fake',
      accountId: 'main',
      conversationId: 'u1',
      sessionId: 's1',
      createdAt: 1,
      updatedAt: 1,
    };
    const router = new ReplyRouter({
      config: baseConfig().reply,
      getAdapter: () => adapter as never,
      getBinding: () => binding,
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
    const binding: SessionBinding = {
      channelId: 'native',
      accountId: 'main',
      conversationId: 'u1',
      sessionId: 's1',
      createdAt: 1,
      updatedAt: 1,
    };
    const router = new ReplyRouter({
      config: { ...baseConfig().reply, updateIntervalMs: 0 },
      getAdapter: () => adapter as never,
      getBinding: () => binding,
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
    const binding: SessionBinding = {
      channelId: 'fake',
      accountId: 'main',
      conversationId: 'u1',
      sessionId: 's1',
      createdAt: 1,
      updatedAt: 1,
    };
    const router = new ReplyRouter({
      config: { ...baseConfig().reply, maxTextLength: 10 },
      getAdapter: () => adapter as never,
      getBinding: () => binding,
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

    // A fence that fits within maxLength stays whole.
    const fenced = splitMessage(
      'para one.\n\n```js\nlet x = 1;\n```\n\npara two with padding',
      40,
      cfg,
    );
    expect(fenced.some((p) => p.startsWith('```js') && p.endsWith('```'))).toBe(true);

    // finalFlush: false drops a trailing partial piece.
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
    const manager = new AgentManager(gateway, silentLogger);
    const router = new AgentRouter(baseConfig());
    const bindingStore = new MemoryBindingStore();
    const bridge = new ChannelHarnessBridge({
      config: baseConfig(),
      bindingStore,
      agentManager: manager,
      agentRouter: router,
      getAdapter: () => new FakeAdapter('weixin') as never,
      logger: silentLogger,
    });

    const event = makeMessageEvent();
    await bridge.handleChannelEvent(event);

    // FakeGateway.supportsResume is true, so resolution goes through resume.
    expect(gateway.resumeCalls).toHaveLength(1);
    expect(gateway.followups).toHaveLength(1);
    const binding = await bindingStore.get('weixin:main:user_123');
    expect(binding?.sessionId).toBe(gateway.resumeCalls[0]);
    expect(binding?.agentId).toBe('weixin-agent');
    expect(manager.bindingFor(binding!.sessionId)).toEqual(binding);
  });

  it('reuses the same session for the same conversation', async () => {
    const gateway = new FakeGateway();
    const manager = new AgentManager(gateway, silentLogger);
    const bridge = new ChannelHarnessBridge({
      config: baseConfig(),
      bindingStore: new MemoryBindingStore(),
      agentManager: manager,
      agentRouter: new AgentRouter(baseConfig()),
      getAdapter: () => new FakeAdapter('weixin') as never,
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
    // A real AgentRegistry with a stub factory makes `ctx.agents` usable
    // without a full Harness loop.
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
});

describe('HarnessAgentGateway against real dsh types', () => {
  it('maps agent methods onto the gateway surface (compile + basic shape)', () => {
    const ctx = new Context();
    new AgentRegistry(ctx);
    const gateway = new HarnessAgentGateway(ctx, { model: 'deepseek-chat' });
    expect(gateway.supportsResume).toBe(true);
    // No live agents in a bare registry — get returns undefined.
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
    const manager = new AgentManager(gateway, silentLogger);
    const bridge = new ChannelHarnessBridge({
      config: baseConfig(),
      bindingStore: new MemoryBindingStore(),
      agentManager: manager,
      agentRouter: new AgentRouter(baseConfig()),
      getAdapter: (id) => service.get(id),
      logger: silentLogger,
    });

    const stopInbound = service.on((event: ChannelEvent) => {
      void bridge.handleChannelEvent(event);
    });

    // Simulate the platform delivering a message through the adapter context.
    const event = makeMessageEvent();
    await service.emit(event);
    await vi.waitFor(() => {
      expect(gateway.followups).toHaveLength(1);
    });
    expect(gateway.followups[0]?.sessionId).toBeTruthy();
    stopInbound();
  });
});
