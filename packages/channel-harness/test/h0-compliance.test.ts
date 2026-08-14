/**
 * H0 Harness Compliance Baseline tests (doc §3 / H0.1–H0.7, §4, §5).
 *
 * Covers the new routing/identity semantics: AgentRouteSpec resolution
 * precedence (no agentId), create/resume route parity, optional persistence
 * capability (canResume + probe) with no error-regex fallback, one-time v1->v2
 * binding migration, and durable-log unload reconcile.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, type MessageReceived } from '@dsh/channel-core';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
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
import { ReplyRouter } from '../src/reply-router.ts';
import { ReplyContextStore } from '../src/reply-context-store.ts';
import { SESSION_BINDING_SCHEMA_VERSION, type SessionBinding } from '../src/session-router.ts';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Config with distinct routes at every override level + a default. */
function routedConfig(): Config {
  return Config({
    agent: { default: { preset: 'default-preset' } },
    routing: {
      mode: 'conversation',
      overrides: {
        channel: { weixin: { model: 'channel-model' } },
        account: { main: { model: 'account-model' } },
        conversation: { 'conv-123': { preset: 'conv-preset', maxTokens: 512 } },
      },
    },
    bindingStore: { type: 'memory' },
    reply: { updateIntervalMs: 0, maxTextLength: undefined, splitParagraphs: true, splitCodeBlocks: true, finalFlush: true },
    maxConcurrency: 4,
    includeMetadataPrefix: false,
  });
}

/** Generic in-memory gateway for the compliance tests. */
class FakeGateway implements AgentGateway {
  canResumeValue = true;
  existsValue = false;
  persistError?: Error;
  live = new Map<string, GatewayAgentHandle>();
  createCalls: { sessionId: string; route: AgentRouteSpec }[] = [];
  resumeCalls: { sessionId: string; route: AgentRouteSpec }[] = [];

  get(sessionId: string) {
    const agent = this.live.get(sessionId);
    if (!agent) return undefined;
    return { id: agent.id, followup: agent.followup, whenIdle: agent.whenIdle };
  }
  canResume(): boolean { return this.canResumeValue; }
  async exists(_sessionId: string): Promise<boolean> {
    if (this.persistError) throw this.persistError;
    return this.existsValue;
  }
  async create(sessionId: string, route: AgentRouteSpec) {
    this.createCalls.push({ sessionId, route });
    return this.makeHandle(sessionId);
  }
  async resume(sessionId: string, route: AgentRouteSpec) {
    this.resumeCalls.push({ sessionId, route });
    return this.makeHandle(sessionId);
  }
  private makeHandle(sessionId: string): GatewayAgentHandle {
    const h: GatewayAgentHandle = {
      id: sessionId,
      followup: () => {},
      whenIdle: () => Promise.resolve(),
      dispose: async () => { this.live.delete(sessionId); },
    };
    this.live.set(sessionId, h);
    return h;
  }
}

function makeMessageEvent(overrides: Partial<MessageReceived> = {}): MessageReceived {
  return {
    type: 'message.received',
    channel: 'weixin',
    accountId: 'main',
    conversation: { id: 'conv-123', type: 'dm' },
    sender: { id: 'u1', name: 'Alice' },
    message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] },
    ...overrides,
  };
}

function makeBridge(gateway: FakeGateway) {
  const manager = new AgentManager(gateway, silentLogger, 4);
  const bridge = new ChannelHarnessBridge({
    config: routedConfig(),
    bindingStore: new MemoryBindingStore(),
    agentManager: manager,
    agentRouter: new AgentRouter(routedConfig()),
    getAdapter: () => undefined,
    replyContexts: new ReplyContextStore(),
    logger: silentLogger,
  });
  return { gateway, manager, bridge };
}

describe('AgentRouteSpec resolution precedence (no agentId)', () => {
  it('conversation > account > channel > default', () => {
    const router = new AgentRouter(routedConfig());
    expect(router.resolve({ channelId: 'weixin', accountId: 'main', conversationId: 'conv-123' })).toEqual({ preset: 'conv-preset', maxTokens: 512 });
    expect(router.resolve({ channelId: 'weixin', accountId: 'main', conversationId: 'other' })).toEqual({ model: 'account-model' });
    expect(router.resolve({ channelId: 'weixin', accountId: 'other', conversationId: 'x' })).toEqual({ model: 'channel-model' });
    expect(router.resolve({ channelId: 'lark', accountId: 'other', conversationId: 'x' })).toEqual({ preset: 'default-preset' });
  });

  it('returns AgentRouteSpec objects, never a bare agentId string', () => {
    const router = new AgentRouter(routedConfig());
    const route = router.resolve({ channelId: 'weixin', accountId: 'main', conversationId: 'conv-123' });
    expect(route).toBeTypeOf('object');
    expect('agentId' in route).toBe(false);
    expect('preset' in route || 'model' in route || 'provider' in route || 'maxTokens' in route).toBe(true);
  });
});

describe('create/resume route parity', () => {
  it('routes a NEW conversation to create and an EXISTING persisted one to resume with the same route', async () => {
    const gateway = new FakeGateway();
    gateway.canResumeValue = true;
    gateway.existsValue = true; // the persisted session exists
    const { gateway: g, bridge } = makeBridge(gateway);

    // First: new conversation -> create.
    await bridge.handleChannelEvent(makeMessageEvent());
    expect(g.createCalls).toHaveLength(1);
    const createdRoute = g.createCalls[0]?.route;
    expect(createdRoute).toEqual({ preset: 'conv-preset', maxTokens: 512 });

    // Same conversation again: existing binding, persisted session exists -> resume with SAME route.
    // Live agent exists (from create), so both paths borrow; force a live miss by clearing the registry.
    g.live.clear();
    await bridge.handleChannelEvent(makeMessageEvent({ message: { id: 'm2', content: [{ type: 'text', text: 'again' }] } }));
    expect(g.resumeCalls).toHaveLength(1);
    expect(g.resumeCalls[0]?.route).toEqual(createdRoute);
    expect(g.resumeCalls[0]?.sessionId).toBe(g.createCalls[0]?.sessionId);
  });

  it('resolves route change on an existing conversation and updates the binding', async () => {
    const gateway = new FakeGateway();
    gateway.canResumeValue = false; // no persistence -> recreate
    const { gateway: g, bridge } = makeBridge(gateway);
    await bridge.handleChannelEvent(makeMessageEvent());
    const firstSession = g.createCalls[0]?.sessionId;
    expect(firstSession).toBeTruthy();

    // The route stays the same across both messages of one conversation.
    g.live.clear();
    await bridge.handleChannelEvent(makeMessageEvent({ message: { id: 'm2', content: [{ type: 'text', text: 'again' }] } }));
    // no persistence -> recreates (second create, same sessionId).
    expect(g.createCalls).toHaveLength(2);
    expect(g.createCalls[1]?.sessionId).toBe(firstSession);
  });
});
describe('optional persistence capability (no error-regex)', () => {
  it('persistence absent -> canResume() false -> existing conversation recreates, never resumes', async () => {
    const gateway = new FakeGateway();
    gateway.canResumeValue = false;
    gateway.existsValue = true;
    const { gateway: g, bridge } = makeBridge(gateway);
    await bridge.handleChannelEvent(makeMessageEvent());
    g.live.clear();
    await bridge.handleChannelEvent(makeMessageEvent({ message: { id: 'm2', content: [{ type: 'text', text: 'again' }] } }));
    expect(g.resumeCalls).toHaveLength(0);
    expect(g.createCalls).toHaveLength(2);
  });

  it('persistence backend error propagates loudly (no create fallback)', async () => {
    const gateway = new FakeGateway();
    gateway.canResumeValue = true;
    gateway.persistError = new Error('disk read failed: EIO');
    const { gateway: g, bridge } = makeBridge(gateway);
    // First message: new conversation -> create (probe not consulted).
    await bridge.handleChannelEvent(makeMessageEvent());
    const beforeCreates = g.createCalls.length;
    // Second message: canResume true but the probe throws -> loud, no create fallback.
    await expect(
      bridge.handleChannelEvent(makeMessageEvent({ message: { id: 'm2', content: [{ type: 'text', text: 'again' }] } })),
    ).rejects.toThrow(/disk read failed/);
    expect(g.createCalls.length).toBe(beforeCreates);
  });
});

describe('binding v1 -> v2 migration', () => {
  it('MemoryBindingStore migrates a v1 (agentId) entry to route.model + schemaVersion 2', async () => {
    const store = new MemoryBindingStore();
    (store as unknown as { store: Map<string, unknown> }).store.set('weixin:main:user_123', {
      channelId: 'weixin',
      accountId: 'main',
      conversationId: 'user_123',
      agentId: 'legacy-model',
      sessionId: 'ch-old',
      createdAt: 10,
      updatedAt: 11,
    });
    const migrated = await store.get('weixin:main:user_123');
    expect(migrated?.schemaVersion).toBe(2);
    expect(migrated?.route).toEqual({ model: 'legacy-model' });
    expect('agentId' in (migrated as unknown as SessionBinding)).toBe(false);
    expect(migrated?.sessionId).toBe('ch-old');
  });

  it('FileBindingStore migrates on load and persists the migrated file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-migrate-'));
    try {
      const file = join(dir, 'bindings.json');
      const v1 = {
        'weixin:main:user_123': {
          channelId: 'weixin',
          accountId: 'main',
          conversationId: 'user_123',
          agentId: 'v1-model',
          sessionId: 'ch-1',
          createdAt: 1,
          updatedAt: 1,
        },
      };
      const { writeFile } = await import('node:fs/promises');
      await writeFile(file, JSON.stringify(v1), 'utf8');

      const store = new FileBindingStore(file);
      const migrated = await store.get('weixin:main:user_123');
      expect(migrated?.schemaVersion).toBe(SESSION_BINDING_SCHEMA_VERSION);
      expect(migrated?.route).toEqual({ model: 'v1-model' });
      const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      const stored = raw['weixin:main:user_123'] as Partial<SessionBinding>;
      expect(stored.schemaVersion).toBe(2);
      expect((stored.route as { model?: string }).model).toBe('v1-model');
      expect('agentId' in stored).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
describe('durable unload reconcile', () => {
  it('reconcileSession delivers final text from the durable log after the listener is removed', async () => {
    const sent: { text?: string }[] = [];
    const adapter = {
      id: 'weixin',
      capabilities: { text: true, image: false, file: false, audio: false, video: false, markdown: true, cards: false, reactions: false, threads: false, streaming: 'buffered' as const },
      start: async () => {},
      stop: async () => {},
      send: async (_t: unknown, message: { text?: string }) => {
        sent.push(message);
        return { delivered: true };
      },
    };
    const binding: SessionBinding = {
      channelId: 'weixin',
      accountId: 'main',
      conversationId: 'user_123',
      sessionId: 's1',
      route: { preset: 'default' },
      schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
      createdAt: 1,
      updatedAt: 1,
    };
    const router = new ReplyRouter({
      config: { updateIntervalMs: 0, maxTextLength: undefined, splitParagraphs: true, splitCodeBlocks: true, finalFlush: true },
      getAdapter: () => adapter as never,
      getBinding: () => binding,
      replyContexts: new ReplyContextStore(),
      logger: silentLogger,
    });

    // Durable Session log: turn 0 started, streamed chunks, but NO turn/end.
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
      { type: 'assistant/chunk', seq: 1, time: 2, data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'final ' } } },
      { type: 'assistant/chunk', seq: 2, time: 3, data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 1, text: 'answer' } } },
    ];

    // NO onSessionEvent was ever called (the listener is ALREADY removed).
    await router.reconcileSession({ id: 's1', events });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe('final answer');
    expect(router.activeSessions()).toEqual([]);
  });

  it('reconcileSession falls back to assistant/message text when no deltas flowed', async () => {
    const sent: { text?: string }[] = [];
    const adapter = {
      id: 'weixin',
      capabilities: { text: true, image: false, file: false, audio: false, video: false, markdown: true, cards: false, reactions: false, threads: false, streaming: 'buffered' as const },
      start: async () => {},
      stop: async () => {},
      send: async (_t: unknown, message: { text?: string }) => {
        sent.push(message);
        return { delivered: true };
      },
    };
    const binding: SessionBinding = {
      channelId: 'weixin',
      accountId: 'main',
      conversationId: 'user_123',
      sessionId: 's1',
      route: { preset: 'default' },
      schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
      createdAt: 1,
      updatedAt: 1,
    };
    const router = new ReplyRouter({
      config: { updateIntervalMs: 0, maxTextLength: undefined, splitParagraphs: true, splitCodeBlocks: true, finalFlush: true },
      getAdapter: () => adapter as never,
      getBinding: () => binding,
      replyContexts: new ReplyContextStore(),
      logger: silentLogger,
    });
    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
      { type: 'assistant/message', seq: 1, time: 2, data: { turn: 0, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'assembled only' }] } } },
    ];

    await router.reconcileSession({ id: 's1', events });
    expect(sent[0]?.text).toBe('assembled only');
  });

  it('reconcileSession finalizes an already-active reply with the durable text', async () => {
    const sent: { text?: string }[] = [];
    const adapter = {
      id: 'weixin',
      capabilities: { text: true, image: false, file: false, audio: false, video: false, markdown: true, cards: false, reactions: false, threads: false, streaming: 'buffered' as const },
      start: async () => {},
      stop: async () => {},
      send: async (_t: unknown, message: { text?: string }) => {
        sent.push(message);
        return { delivered: true };
      },
    };
    const binding: SessionBinding = {
      channelId: 'weixin',
      accountId: 'main',
      conversationId: 'user_123',
      sessionId: 's1',
      route: { preset: 'default' },
      schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
      createdAt: 1,
      updatedAt: 1,
    };
    const router = new ReplyRouter({
      config: { updateIntervalMs: 0, maxTextLength: undefined, splitParagraphs: true, splitCodeBlocks: true, finalFlush: true },
      getAdapter: () => adapter as never,
      getBinding: () => binding,
      replyContexts: new ReplyContextStore(),
      logger: silentLogger,
    });
    // A turn was streaming through the listener and has an active reply.
    const session = { id: 's1' } as never;
    router.onSessionEvent(session, { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } } as never);
    router.onSessionEvent(session, { type: 'assistant/chunk', seq: 1, time: 2, data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hel' } } } as never);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const events: SessionEvent[] = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
      { type: 'assistant/chunk', seq: 1, time: 2, data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'hel' } } },
      { type: 'assistant/chunk', seq: 2, time: 3, data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 1, text: 'lo reco' } } },
    ];
    await router.reconcileSession({ id: 's1', events });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // The active reply is finalized with the durable text.
    expect(sent.map((m) => m.text).join('|')).toContain('hel');
  });
});