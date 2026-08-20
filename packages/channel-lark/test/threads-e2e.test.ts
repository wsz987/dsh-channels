/**
 * M3 acceptance (execution plan Task 12.2): threads → SessionBinding isolation.
 *
 * Proves that the Lark adapter's mapped events — which preserve
 * `conversationId` + optional `threadId` — drive the real `ChannelHarnessBridge`
 * into per-thread Harness sessions:
 *
 * - two inbound messages in the SAME conversation with DIFFERENT thread ids
 *   resolve to DIFFERENT session bindings (thread isolation);
 * - two messages with the SAME thread id reuse the SAME binding;
 * - a message without a threadId binds at the conversation level.
 *
 * The pipeline under test is entirely generic: real `ChannelHarnessBridge` +
 * `AgentManager` + a minimal in-memory `AgentGateway` (FakeGateway pattern from
 * channel-harness tests) + `MemoryBindingStore` + `AgentRouter`. The channel id
 * `'lark'` appears only as event/binding data — no special-casing anywhere.
 */
import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { loadFixture } from '@wsz987/channel-testkit';
import type { MessageReceived } from '@wsz987/channel-core';
import {
  AgentManager,
  type AgentGateway,
  type GatewayAgentHandle,
} from '../../channel-harness/src/agent-manager.ts';
import { AgentRouter, type AgentRouteSpec } from '../../channel-harness/src/agent-router.ts';
import { MemoryBindingStore } from '../../channel-harness/src/binding-store.ts';
import { ChannelHarnessBridge } from '../../channel-harness/src/bridge.ts';
import { Config as HarnessConfig } from '../../channel-harness/src/config.ts';
import { ReplyContextStore } from '../../channel-harness/src/reply-context-store.ts';
import { sessionKey } from '../../channel-harness/src/session-router.ts';
import type { ChannelWorkspaceResolver } from '../../channel-harness/src/workspace-resolver.ts';
import { allowAllAccessResolver } from '../../channel-harness/test/access-test-helper.ts';
import { mapInbound } from '../src/mapper.ts';

/** Minimal in-memory gateway recording every drive call. */
class FakeGateway implements AgentGateway {
  live = new Map<string, GatewayAgentHandle>();
  createCalls: string[] = [];
  resumeCalls: string[] = [];
  followups: { sessionId: string }[] = [];

  get(sessionId: string) {
    const agent = this.live.get(sessionId);
    if (!agent) return undefined;
    return { id: agent.id, agent: agent.agent, followup: agent.followup, whenIdle: agent.whenIdle };
  }

  canResume(): boolean {
    return true;
  }

  async exists(): Promise<boolean> {
    return false;
  }

  async create(sessionId: string, _route: AgentRouteSpec) {
    this.createCalls.push(sessionId);
    return this.makeHandle(sessionId);
  }

  async resume(sessionId: string, _route: AgentRouteSpec) {
    this.resumeCalls.push(sessionId);
    return this.makeHandle(sessionId);
  }

  private makeHandle(sessionId: string): GatewayAgentHandle {
    const handle: GatewayAgentHandle = {
      id: sessionId,
      // The raw Agent is only used as the dsh-scope key for command
      // registration; these e2e tests never exercise the command plane.
      agent: { id: sessionId } as never,
      followup: () => {
        this.followups.push({ sessionId });
      },
      whenIdle: () => Promise.resolve(),
      dispose: async () => {
        this.live.delete(sessionId);
      },
    };
    this.live.set(sessionId, handle);
    return handle;
  }
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Hermetic no-op workspace resolver: no workspace, no cwd (bridge falls back to config.cwd ?? process.cwd()). */
const noopResolver: ChannelWorkspaceResolver = {
  resolve: async () => ({}),
};

function harnessConfig() {
  return HarnessConfig({
    agent: { default: { preset: 'default' } },
    routing: {
      mode: 'global',
      overrides: {},
    },
    bindingStore: { type: 'memory' },
    workspace: { mode: 'disabled' },
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

/** Build the full generic inbound pipeline (bridge + manager + store + router). */
function makeBridge() {
  const gateway = new FakeGateway();
  const manager = new AgentManager(gateway, silentLogger);
  const store = new MemoryBindingStore();
  const bridge = new ChannelHarnessBridge({
    config: harnessConfig(),
    bindingStore: store,
    agentManager: manager,
    agentRouter: new AgentRouter(harnessConfig()),
    getAdapter: () => undefined,
    replyContexts: new ReplyContextStore(),
    logger: silentLogger,
    accessResolver: allowAllAccessResolver,
    ctx: new Context(),
    commandDeps: { startNewSession: async () => {} },
    workspaceResolver: noopResolver,
  });
  return { gateway, manager, bridge, store };
}

const meta = { channel: 'lark' as never, accountId: 'main' as never };

/** Map a raw lark payload through the adapter's mapper (the M3 inbound path). */
function mapRaw(raw: Record<string, unknown>): MessageReceived {
  return mapInbound(raw, meta);
}

function rawText(msgId: string, conversationId: string, threadId?: string, content = 'hi'): Record<string, unknown> {
  return {
    type: 'text',
    msgId,
    senderId: 'ou_123',
    conversationId,
    chatType: 'group',
    ...(threadId ? { threadId } : {}),
    content,
  };
}

describe('M3 acceptance: threads → SessionBinding isolation (Task 12.2)', () => {
  it('same conversation + different thread ids → different session bindings', async () => {
    const { bridge, store } = makeBridge();

    await bridge.handleChannelEvent(mapRaw(rawText('m1', 'oc_456', 'om_1', 'first')));
    await bridge.handleChannelEvent(mapRaw(rawText('m2', 'oc_456', 'om_2', 'second')));

    const keyA = sessionKey({ channelId: 'lark', accountId: 'main', conversationId: 'oc_456', threadId: 'om_1' });
    const keyB = sessionKey({ channelId: 'lark', accountId: 'main', conversationId: 'oc_456', threadId: 'om_2' });
    const bindingA = await store.get(keyA);
    const bindingB = await store.get(keyB);

    expect(bindingA).toBeDefined();
    expect(bindingB).toBeDefined();
    // Distinct thread keys → distinct bindings with distinct session ids.
    expect(keyA).not.toBe(keyB);
    expect(bindingA!.sessionId).not.toBe(bindingB!.sessionId);
    expect(bindingA!.threadId).toBe('om_1');
    expect(bindingB!.threadId).toBe('om_2');
  });

  it('same thread id → the same session binding is reused', async () => {
    const { gateway, bridge, store } = makeBridge();

    await bridge.handleChannelEvent(mapRaw(rawText('m1', 'oc_456', 'om_1', 'first')));
    await bridge.handleChannelEvent(mapRaw(rawText('m2', 'oc_456', 'om_1', 'second')));

    const key = sessionKey({ channelId: 'lark', accountId: 'main', conversationId: 'oc_456', threadId: 'om_1' });
    const binding = await store.get(key);
    expect(binding).toBeDefined();
    expect(binding!.threadId).toBe('om_1');

    // Both messages resolved into the SAME session: the first (new binding)
    // created the agent, the second reused it via live get (no resume, no
    // second create), both messages were delivered, and the store holds
    // exactly one binding for the thread.
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.resumeCalls).toHaveLength(0);
    expect(gateway.followups).toHaveLength(2);
    expect(gateway.createCalls[0]).toBe(binding!.sessionId);
    expect(gateway.followups.every((f) => f.sessionId === binding!.sessionId)).toBe(true);
  });

  it('a message without a threadId binds at the conversation level (distinct from thread bindings)', async () => {
    const { bridge, store } = makeBridge();

    // No threadId → conversation-level binding.
    await bridge.handleChannelEvent(mapRaw(rawText('m1', 'oc_456')));
    const convKey = sessionKey({ channelId: 'lark', accountId: 'main', conversationId: 'oc_456' });
    const convBinding = await store.get(convKey);
    expect(convBinding).toBeDefined();
    expect(convBinding!.threadId).toBeUndefined();

    // Same conversation, but inside a thread → a separate thread-scoped binding.
    await bridge.handleChannelEvent(mapRaw(rawText('m2', 'oc_456', 'om_1')));
    const threadKey = sessionKey({ channelId: 'lark', accountId: 'main', conversationId: 'oc_456', threadId: 'om_1' });
    const threadBinding = await store.get(threadKey);
    expect(threadBinding).toBeDefined();
    expect(threadBinding!.threadId).toBe('om_1');
    expect(threadBinding!.sessionId).not.toBe(convBinding!.sessionId);
  });

  it('maps the real thread fixture through the adapter mapper and the bridge', async () => {
    const fixture = await loadFixture('lark', 'inbound-thread');
    const event = mapRaw(fixture.payload as Record<string, unknown>);
    // The mapper preserved the thread id, so the bridge keys per thread.
    expect(event.conversation.threadId).toBe('om_789');

    const { bridge, store } = makeBridge();
    await bridge.handleChannelEvent(event);
    const key = sessionKey({
      channelId: 'lark',
      accountId: 'main',
      conversationId: 'oc_456',
      threadId: 'om_789',
    });
    const binding = await store.get(key);
    expect(binding).toBeDefined();
    expect(binding!.sessionId).toBeTruthy();
    expect(binding!.conversationId).toBe('oc_456');
    expect(binding!.threadId).toBe('om_789');
  });
});
