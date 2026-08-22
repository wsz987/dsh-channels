/*
 * /version coverage: bundle version + Harness tested baseline + the
 * prompt-only update hint from the channel-control update check.
 *
 * - Direct handler execution covers the output shape and degradation (control
 *   plane absent / throwing → version-only output).
 * - One full-bridge case proves /version registers in the agent scope, appears
 *   in /help, and reaches the update status through the bridge's live
 *   `ctx.get('channelControl')` probe (never through invocation.agent.ctx).
 * - A drift guard pins HARNESS_TESTED_VERSION to this package's own
 *   @deepseek-ai/dsh-commands pin (single source: scripts/check-upstream.mjs).
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import CommandRuntime from '@deepseek-ai/dsh-commands';
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
import {
  createVersionCommand,
  HARNESS_TESTED_VERSION,
} from '../src/commands/version.ts';
import type { ChannelCommandDependencies, ChannelVersionInfo } from '../src/commands/index.ts';
import { ChannelModelSelectionController } from '../src/model-selection.ts';
import { ReplyContextStore } from '../src/reply-context-store.ts';
import type { ChannelWorkspaceResolver } from '../src/workspace-resolver.ts';
import { allowAllAccessResolver } from './access-test-helper.ts';
import harnessPkg from '../package.json' with { type: 'json' };

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const noopResolver: ChannelWorkspaceResolver = { resolve: async () => ({}) };

function baseConfig(): Config {
  return Config({
    agent: { default: { preset: 'default' } as AgentRouteSpec },
    routing: { mode: 'global' },
    bindingStore: { type: 'memory' },
    workspace: { mode: 'disabled' },
    reply: { updateIntervalMs: 0, maxTextLength: undefined, splitParagraphs: true, splitCodeBlocks: true, finalFlush: true },
    maxConcurrency: 4,
    includeMetadataPrefix: true,
  });
}

/** Minimal deps for the /version handler (only versionInfo is ever read). */
function versionDeps(rootCtx: Context, versionInfo?: ChannelCommandDependencies['versionInfo']): ChannelCommandDependencies {
  return {
    startNewSession: async () => {},
    modelSelection: new ChannelModelSelectionController(rootCtx),
    listCommands: () => [],
    findCommand: () => undefined,
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({ provider: '', id: '', name: '' }),
      resolveCallConfig: async (config) => config,
    },
    ...(versionInfo ? { versionInfo } : {}),
  };
}

/** Fake agent under a real scoped context (commands.execute appends lifecycle events). */
function fakeScopedAgent(ctx: Context, id = 's-version') {
  const events: { type: string; data: unknown }[] = [];
  const agent = {
    id: SessionId(id),
    session: {
      id,
      events,
      append(type: string, data: unknown) {
        const event = { type, data };
        events.push(event);
        return event;
      },
    },
    status: 'idle' as const,
    options: {},
    cancel: vi.fn(),
    ctx: new Context(),
    followup() {},
    whenIdle: async () => {},
  };
  const scoped = createScope(ctx, agent as never);
  agent.ctx = scoped.ctx;
  return agent;
}

async function runVersion(deps: ChannelCommandDependencies): Promise<string> {
  const ctx = new Context();
  new CommandRuntime(ctx);
  const disposer = ctx.commands.register(createVersionCommand(deps));
  const agent = fakeScopedAgent(ctx);
  const execution = await ctx.commands.execute(agent as never, '/version', [], new AbortController().signal);
  disposer();
  expect(execution?.result?.kind).toBe('success');
  return execution?.result?.text ?? '';
}

/* ------------------------------------------------------------------ */
/* drift guard                                                         */
/* ------------------------------------------------------------------ */

describe('/version baseline drift guard', () => {
  it('HARNESS_TESTED_VERSION matches the pinned @deepseek-ai/dsh-commands version', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      peerDependencies: Record<string, string>;
    };
    // Single source of truth: scripts/check-upstream.mjs HARNESS_TESTED_VERSION
    // + every workspace @deepseek-ai/dsh-* pin. If this fails after a baseline
    // bump, update src/commands/version.ts together with the workspace pins.
    expect(HARNESS_TESTED_VERSION).toBe(pkg.peerDependencies['@deepseek-ai/dsh-commands']);
  });
});

/* ------------------------------------------------------------------ */
/* handler output                                                      */
/* ------------------------------------------------------------------ */

describe('/version handler', () => {
  it('shows the bundle version and Harness baseline without a control plane', async () => {
    const text = await runVersion(versionDeps(new Context()));
    expect(text).toContain('Version');
    expect(text).toContain('Bundle: ' + harnessPkg.version);
    expect(text).toContain('Harness tested baseline: ' + HARNESS_TESTED_VERSION);
    expect(text).not.toContain('Update available');
  });

  it('appends the hint (same line → single update command)', async () => {
    const info: ChannelVersionInfo = {
      currentVersion: '0.4.2',
      update: {
        version: '0.4.3',
        tag: 'latest',
        crossLine: false,
        commands: ['npx @deepseek-ai/dsh plugin --profile web update -w @wsz987/dsh-channels'],
      },
      checkedAt: 1_700_000_000_000,
    };
    const text = await runVersion(versionDeps(new Context(), async () => info));
    expect(text).toContain('Update available: 0.4.3 (latest)');
    expect(text).toContain('npx @deepseek-ai/dsh plugin --profile web update -w @wsz987/dsh-channels');
    expect(text).not.toContain('npm i -g @deepseek-ai/dsh@latest');
    // The control-plane version wins over the local package fallback.
    expect(text).toContain('Bundle: 0.4.2');
  });

  it('appends the two-step hint when crossing a version line', async () => {
    const info: ChannelVersionInfo = {
      currentVersion: '0.4.2',
      update: {
        version: '0.5.0',
        tag: 'latest',
        crossLine: true,
        commands: [
          'npm i -g @deepseek-ai/dsh@latest',
          'npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest',
        ],
      },
    };
    const text = await runVersion(versionDeps(new Context(), async () => info));
    expect(text).toContain('Update available: 0.5.0 (latest)');
    expect(text).toContain('cross-version-line');
    expect(text).toContain('npm i -g @deepseek-ai/dsh@latest');
    expect(text).toContain('npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest');
  });

  it('degrades to the version-only output when the probe throws', async () => {
    const text = await runVersion(
      versionDeps(new Context(), async () => {
        throw new Error('control plane exploded');
      }),
    );
    expect(text).toContain('Bundle: ' + harnessPkg.version);
    expect(text).not.toContain('Update available');
  });

  it('renders "no update" as the version-only output', async () => {
    const text = await runVersion(
      versionDeps(new Context(), async () => ({ currentVersion: '0.4.2', checkedAt: 1 })),
    );
    expect(text).toContain('Bundle: 0.4.2');
    expect(text).not.toContain('Update available');
  });
});

/* ------------------------------------------------------------------ */
/* bridge integration (live ctx.get('channelControl') probe)           */
/* ------------------------------------------------------------------ */

class FakeAdapter {
  id = 'weixin';
  capabilities = { text: true, image: false, file: false, audio: false, video: false, markdown: true, cards: false, reactions: false, threads: false, streaming: 'buffered' } as const;
  sent: { text?: string }[] = [];
  constructor() {}
  async start() {}
  async stop() {}
  async send(_target: ChannelTarget, message: { text?: string }) {
    this.sent.push(message);
    return { delivered: true };
  }
}

interface FakeAgent {
  id: SessionId;
  session: { id: string; events: unknown[]; append(type: string, data: unknown): unknown };
  status: 'idle' | 'running';
  options: Record<string, unknown>;
  cancel: ReturnType<typeof vi.fn>;
  ctx: Context;
  followup(): void;
  whenIdle(): Promise<void>;
}

function fakeScopedBridgeAgent(ctx: Context, id: string): FakeAgent {
  const events: unknown[] = [];
  const agent: FakeAgent = {
    id: SessionId(id),
    session: { id, events, append(type, data) { const e = { type, data }; events.push(e); return e; } },
    status: 'idle',
    options: {},
    cancel: vi.fn(),
    ctx: new Context(),
    followup() {},
    whenIdle: async () => {},
  };
  const scoped = createScope(ctx, agent as never);
  agent.ctx = scoped.ctx;
  return agent;
}

class VersionGateway implements AgentGateway {
  live = new Map<string, GatewayAgentHandle>();
  agents = new Map<string, FakeAgent>();
  createCalls: string[] = [];
  constructor(private readonly rootCtx: Context) {}
  get(sessionId: string) {
    const handle = this.live.get(sessionId);
    return handle ? { id: handle.id, agent: handle.agent, followup: handle.followup, whenIdle: handle.whenIdle } : undefined;
  }
  canResume() { return true; }
  async exists() { return false; }
  async create(sessionId: string, _route: AgentRouteSpec, setup?: Parameters<AgentGateway['create']>[2]) {
    this.createCalls.push(sessionId);
    const agent = fakeScopedBridgeAgent(this.rootCtx, sessionId);
    if (setup) {
      const commit = await setup(agent.ctx);
      commit?.commit();
    }
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

function makeMessageEvent(text: string, id: string): MessageReceived {
  return {
    type: 'message.received',
    channel: 'weixin',
    accountId: 'main',
    conversation: { id: 'user_123', type: 'dm' },
    sender: { id: 'user_123', name: 'Alice' },
    message: { id, content: [{ type: 'text', text }] },
  };
}

describe('/version through the bridge', () => {
  function makeFixture(update?: ChannelVersionInfo['update']) {
    const rootCtx = new Context();
    new CommandRuntime(rootCtx);
    if (update) {
      rootCtx.provide('channelControl', {
        getUpdateStatus: async () => ({ currentVersion: '0.4.2', update, checkedAt: 1 }),
      });
    }
    const gateway = new VersionGateway(rootCtx);
    const manager = new AgentManager(gateway, silentLogger, 4);
    const adapter = new FakeAdapter();
    let bridge!: ChannelHarnessBridge;
    bridge = new ChannelHarnessBridge({
      config: baseConfig(),
      bindingStore: new MemoryBindingStore(),
      agentManager: manager,
      agentRouter: new AgentRouter(baseConfig()),
      getAdapter: () => adapter as never,
      replyContexts: new ReplyContextStore(),
      logger: silentLogger,
      accessResolver: allowAllAccessResolver,
      ctx: rootCtx,
      commandDeps: { startNewSession: (agent) => bridge.startNewSession(agent) },
      workspaceResolver: noopResolver,
    });
    return { rootCtx, gateway, bridge, adapter };
  }

  function lastSent(adapter: FakeAdapter): string {
    return adapter.sent[adapter.sent.length - 1]?.text ?? '';
  }

  it('reaches the control plane through the live probe and renders the hint', async () => {
    const { bridge, adapter } = makeFixture({
      version: '0.5.0',
      tag: 'latest',
      crossLine: true,
      commands: [
        'npm i -g @deepseek-ai/dsh@latest',
        'npx @deepseek-ai/dsh plugin --profile web add -w @wsz987/dsh-channels@latest',
      ],
    });
    await bridge.handleChannelEvent(makeMessageEvent('/version', 'm1'));
    const out = lastSent(adapter);
    expect(out).toContain('Bundle: 0.4.2');
    expect(out).toContain('Harness tested baseline: ' + HARNESS_TESTED_VERSION);
    expect(out).toContain('Update available: 0.5.0 (latest)');
    expect(out).toContain('npm i -g @deepseek-ai/dsh@latest');
  });

  it('degrades to version-only output without a control plane', async () => {
    const { bridge, adapter } = makeFixture();
    await bridge.handleChannelEvent(makeMessageEvent('/version', 'm1'));
    const out = lastSent(adapter);
    expect(out).toContain('Bundle: ' + harnessPkg.version);
    expect(out).not.toContain('Update available');
  });

  it('appears in /help automatically', async () => {
    const { bridge, adapter } = makeFixture();
    await bridge.handleChannelEvent(makeMessageEvent('/help', 'm1'));
    expect(lastSent(adapter)).toContain('/version');
  });

  it('resolves the control plane through the plugin ctx, not invocation.agent.ctx', async () => {
    // Real-env regression shape (see commands-help-status-models.test.ts): the
    // agent-loop scoped context injects no services — reading services on it
    // throws "cannot get property without inject". The bridge-builtin
    // versionInfo dep reaches channelControl through the PLUGIN ctx, so a bare
    // agent ctx must not break /version.
    const { bridge, gateway, adapter } = makeFixture({
      version: '0.4.3',
      tag: 'latest',
      crossLine: false,
      commands: ['npx @deepseek-ai/dsh plugin --profile web update -w @wsz987/dsh-channels'],
    });
    await bridge.handleChannelEvent(makeMessageEvent('hello', 'm1'));
    const agent = gateway.agents.get(gateway.createCalls[0]!)!;
    agent.ctx = new Context() as never;
    await bridge.handleChannelEvent(makeMessageEvent('/version', 'm2'));
    expect(lastSent(adapter)).toContain('Update available: 0.4.3');
  });
});
