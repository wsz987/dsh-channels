/**
 * Official rc.2 image pipeline integration (upgrade plan P0-2).
 *
 * The channel only hands raw images to the Harness Attachment Store
 * (saveImage -> ImageAttachmentRef -> ImageBlock); whether the model can see
 * images is Harness's own request-projection concern (vision variant for
 * vision models, deterministic placeholder for text-only models, with the
 * append-only session history keeping the original attachment reference).
 *
 * These tests pin the channel side of that contract: the converter-produced
 * UserMessage reaches the agent with its ImageBlock intact, and the bridge's
 * Agent-scoped setup installs NO `agent/pre-step` rewrite — the entered
 * decision keeps the message by identity and never probes
 * `llm.resolveModelInfo` for image capability.
 */
import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import CommandRuntime from '@deepseek-ai/dsh-commands';
import { LlmAdapter, LlmRuntime, type StreamChunk } from '@deepseek-ai/dsh-llm';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope';
import { SessionId } from '@deepseek-ai/dsh-session';
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import type { Agent } from '@deepseek-ai/dsh-agent';
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
import type { ChannelWorkspaceResolver } from '../src/workspace-resolver.ts';
import { allowAllAccessResolver } from './access-test-helper.ts';

const defaultRoute: AgentRouteSpec = { preset: 'default' };
const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const noopResolver: ChannelWorkspaceResolver = { resolve: async () => ({}) };

function baseConfig(): Config {
  return Config({
    agent: { default: defaultRoute },
    routing: { mode: 'global' },
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
    includeMetadataPrefix: false,
  });
}

/** Text-only-by-declaration catalog: even this must not trigger a channel rewrite. */
const textOnlyTable = { openai: { models: [{ id: 'gpt-text-only', name: 'GPT text-only' }] } };

class FakeLlmAdapter extends LlmAdapter {
  listModels(provider: string) {
    return Promise.resolve(textOnlyTable[provider]!.models.map((model) => ({ ...model, provider })));
  }
  resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model });
  }
  async *stream(): AsyncGenerator<StreamChunk> { return; }
}

interface ScopedAgent {
  id: SessionId;
  session: { id: string; append(type: string, data: unknown): { type: string; data: unknown } };
  options: { provider?: string; model?: string };
  ctx: Context;
}

function scopedAgent(root: Context, id: string): ScopedAgent {
  const agent = {
    id: SessionId(id),
    session: { id, append: (type, data) => ({ type, data }) },
    options: {},
    ctx: new Context(),
  } as ScopedAgent;
  agent.ctx = createScope(root, agent as unknown as Agent).ctx;
  return agent;
}

/**
 * In-memory gateway that ACTUALLY runs the bridge's Agent setup on a real
 * scoped context (commands + model hooks — and, before P0-2, the image
 * rewrite), and records every followup message.
 */
class SetupGateway implements AgentGateway {
  canResumeValue = false;
  live = new Map<string, GatewayAgentHandle>();
  agents = new Map<string, ScopedAgent>();
  followups: { sessionId: string; message: UserMessage }[] = [];

  constructor(private readonly rootCtx: Context) {}

  get(sessionId: string) {
    const handle = this.live.get(sessionId);
    return handle
      ? { id: handle.id, agent: handle.agent, followup: handle.followup, whenIdle: handle.whenIdle }
      : undefined;
  }
  canResume() { return this.canResumeValue; }
  async exists() { return false; }

  async create(sessionId: string, _route: AgentRouteSpec, setup?: Parameters<AgentGateway['create']>[2]) {
    const agent = scopedAgent(this.rootCtx, sessionId);
    if (setup) await setup(agent.ctx);
    this.agents.set(sessionId, agent);
    const handle: GatewayAgentHandle = {
      id: sessionId,
      agent: agent as unknown as Agent,
      followup: (message) => { this.followups.push({ sessionId, message: message as UserMessage }); },
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

class FakeAdapter {
  id = 'weixin';
  capabilities = {
    text: true, image: false, file: false, audio: false, video: false,
    markdown: true, cards: false, reactions: false, threads: false, streaming: 'buffered',
  } as const;
  sent: { text?: string }[] = [];
  async start() {}
  async stop() {}
  async send(_target: ChannelTarget, message: { text?: string }) {
    this.sent.push(message);
    return { delivered: true };
  }
}

function imageEvent(): MessageReceived {
  return {
    type: 'message.received',
    channel: 'weixin',
    accountId: 'main',
    conversation: { id: 'user_123', type: 'dm' },
    sender: { id: 'user_123', name: 'Alice' },
    message: {
      id: 'm-image-1',
      content: [
        { type: 'text', text: '帮我看图' },
        { type: 'image', mimeType: 'image/jpeg', localData: new Uint8Array([1, 2, 3, 4]) },
        { type: 'text', text: '图里是什么' },
      ],
    },
  } as unknown as MessageReceived;
}

function fixture() {
  const rootCtx = new Context();
  new CommandRuntime(rootCtx);
  const llm = new LlmRuntime(rootCtx);
  llm.registerAdapter(Object.keys(textOnlyTable), new FakeLlmAdapter());
  const resolveModelInfo = vi.spyOn(llm, 'resolveModelInfo');
  const gateway = new SetupGateway(rootCtx);
  const adapter = new FakeAdapter();
  const savedRef: ImageAttachmentRef = {
    attachmentId: AttachmentId('att-pipeline-1'),
    mediaType: 'image/jpeg',
    bytes: 4,
    width: 1,
    height: 1,
  };
  const saveImage = vi.fn(async () => savedRef);
  let bridge!: ChannelHarnessBridge;
  bridge = new ChannelHarnessBridge({
    config: baseConfig(),
    bindingStore: new MemoryBindingStore(),
    agentManager: new AgentManager(gateway, silentLogger, 4),
    agentRouter: new AgentRouter(baseConfig()),
    getAdapter: () => adapter as never,
    replyContexts: new ReplyContextStore(),
    logger: silentLogger,
    accessResolver: allowAllAccessResolver,
    saveImage,
    ctx: rootCtx,
    commandDeps: { startNewSession: (agent) => bridge.startNewSession(agent) },
    workspaceResolver: noopResolver,
  });
  return { rootCtx, gateway, adapter, saveImage, savedRef, resolveModelInfo, bridge };
}

/** Dispatch the official agent/pre-step waterfall on the agent's scoped context. */
async function preStep(agent: ScopedAgent, messages: UserMessage[]) {
  const decision = await agent.ctx.waterfall(
    scopeTarget(agent as unknown as Agent, agent as unknown as Agent),
    'agent/pre-step',
    {
      agent: agent as unknown as Agent,
      messages,
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
    () => Promise.resolve({ kind: 'enter' as const, messages }),
  );
  if (decision.kind !== 'enter') throw new Error('unexpected rejected decision');
  return decision;
}

describe('official rc.2 image pipeline (channel side)', () => {
  it('delivers the ImageBlock through saveImage and never rewrites it at agent/pre-step', async () => {
    const h = fixture();
    await h.bridge.handleChannelEvent(imageEvent());

    expect(h.saveImage).toHaveBeenCalledTimes(1);
    expect(h.gateway.followups).toHaveLength(1);
    const delivered = h.gateway.followups[0]!.message;

    // The converter handed the raw channel image to the Attachment Store and
    // emitted a real ImageBlock, preserving text-image-text order.
    expect(delivered.content.map((block) => block.type)).toEqual(['text', 'image', 'text']);
    const imageBlock = delivered.content.find((block) => block.type === 'image');
    expect(imageBlock).toMatchObject({ type: 'image', attachment: h.savedRef });

    // The Agent-scoped setup must not install any pre-step image rewrite:
    // even with a text-only-declaring catalog, the entered decision keeps the
    // converter's message BY IDENTITY and no capability probe happens.
    const agent = h.gateway.agents.get(h.gateway.followups[0]!.sessionId)!;
    const decision = await preStep(agent, [delivered]);
    expect(decision.messages[0]).toBe(delivered);
    expect(decision.messages[0]!.content.map((block) => block.type)).toEqual(['text', 'image', 'text']);
    expect(h.resolveModelInfo).not.toHaveBeenCalled();
  });

  it('keeps nested tool-result images untouched as well', async () => {
    const h = fixture();
    await h.bridge.handleChannelEvent(imageEvent());
    const agent = h.gateway.agents.get(h.gateway.followups[0]!.sessionId)!;
    const original = h.gateway.followups[0]!.message;

    const nested: UserMessage = {
      ...original,
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1' as never,
          content: [{ type: 'image', attachment: h.savedRef }],
        } as never,
      ],
    };
    const decision = await preStep(agent, [nested]);
    expect(decision.messages[0]).toBe(nested);
    expect((decision.messages[0]!.content[0] as { content: unknown[] }).content[0]).toMatchObject({
      type: 'image',
      attachment: h.savedRef,
    });
    expect(h.resolveModelInfo).not.toHaveBeenCalled();
  });
});
