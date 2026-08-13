/**
 * Bridge lifecycle assembly.
 *
 * `startBridge(ctx, config)` wires everything together and returns a
 * disposer with the mandated stop order (execution plan Phase 5.4):
 * 1. stop new inbound (unregister the ChannelService listener);
 * 2. drain necessary active turns (`whenIdle`, bounded by a timeout);
 * 3. dispose all owned agent handles;
 * 4. dispose the ReplyRouter (clear timers).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChannelAdapter, ChannelEvent, ChannelLogger } from '@dsh/channel-core';
import type { Config } from './config.js';
import { createBindingStore } from './binding-store.js';
import { AgentManager, HarnessAgentGateway } from './agent-manager.js';
import { AgentRouter } from './agent-router.js';
import { ReplyRouter } from './reply-router.js';
import { ChannelHarnessBridge } from './bridge.js';

export interface BridgeLifecycle {
  dispose(): Promise<void>;
  handleChannelEvent(event: ChannelEvent): Promise<void>;
}

const DRAIN_TIMEOUT_MS = 5000;

export function startBridge(ctx: Context, config: Config): BridgeLifecycle {
  const logger: ChannelLogger = ctx.logger('channel-harness');
  const bindingStore = createBindingStore(config.bindingStore);
  const agentGateway = new HarnessAgentGateway(ctx, config.agentOptions);
  const agentManager = new AgentManager(agentGateway, logger);
  const agentRouter = new AgentRouter(config);
  const getAdapter = (channelId: string): ChannelAdapter | undefined =>
    ctx.channels.get(channelId);

  const replyRouter = new ReplyRouter({
    config: config.reply,
    getAdapter,
    getBinding: (sessionId) => agentManager.bindingFor(sessionId),
    logger,
  });
  const stopListening = replyRouter.attach(ctx);

  const bridge = new ChannelHarnessBridge({
    config,
    bindingStore,
    agentManager,
    agentRouter,
    getAdapter,
    logger,
  });
  const stopInbound = ctx.channels.on((event) => {
    void bridge.handleChannelEvent(event);
  });

  let disposed = false;

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    // 1. Stop new inbound.
    stopInbound();
    stopListening();
    // 2. Drain active turns with a bounded wait.
    await drainActiveTurns(agentManager, replyRouter, logger);
    // 3. Dispose owned agent handles (each exactly once).
    await agentManager.disposeAll();
    // 4. Dispose the reply router (clear timers).
    replyRouter.dispose();
  }

  return {
    dispose,
    handleChannelEvent: (event) => bridge.handleChannelEvent(event),
  };
}

async function drainActiveTurns(
  agentManager: AgentManager,
  replyRouter: ReplyRouter,
  logger: ChannelLogger,
): Promise<void> {
  const sessionIds = replyRouter.activeSessions();
  if (sessionIds.length === 0) return;
  await Promise.all(
    sessionIds.map(async (sessionId) => {
      const ref = agentManager.refFor(sessionId);
      if (!ref) return;
      const timedOut = await withTimeout(ref.whenIdle(), DRAIN_TIMEOUT_MS);
      if (timedOut) {
        logger.warn(`[channel-harness] drain timed out for session '${sessionId}'`);
      }
    }),
  );
}

/** Resolve true when the timeout elapses before the promise settles. */
function withTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) resolve(true);
    }, ms);
    promise.then(
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}
