/**
 * Bridge lifecycle assembly.
 *
 * `startBridge(ctx, config)` wires everything together and returns a
 * disposer with the mandated stop order (execution plan Phase 5.4):
 * 1. stop new inbound (unregister the ChannelService listener);
 * 2. keep the `session/event` listener attached and drain active turns
 *    (`whenIdle`, bounded by a timeout) so streaming replies can still
 *    finalize via `turn/end`;
 * 3. flush any replies still marked active (`ReplyRouter.flushAll`);
 * 4. stop listening to `session/event`;
 * 5. dispose all owned agent handles;
 * 6. dispose the ReplyRouter (clear timers).
 *
 * It also registers the two reply-context correlation listeners
 * (`agent/inbox/claimed` → `ReplyContextStore.claim`, `agent/inbox/discarded`
 * → `ReplyContextStore.discard`) on the Cordis context. They are plain
 * `ctx.on` (auto-disposed with the context) and stay active for the whole
 * bridge lifetime so every message↔turn correlation is captured.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChannelAdapter, ChannelEvent, ChannelLogger } from '@dsh/channel-core';
import type { Config } from './config.js';
import { createBindingStore } from './binding-store.js';
import { AgentManager, HarnessAgentGateway } from './agent-manager.js';
import { AgentRouter } from './agent-router.js';
import { ReplyRouter } from './reply-router.js';
import { ChannelHarnessBridge } from './bridge.js';
import { ReplyContextStore } from './reply-context-store.js';

export interface BridgeLifecycle {
  dispose(): Promise<void>;
  handleChannelEvent(event: ChannelEvent): Promise<void>;
}

const DRAIN_TIMEOUT_MS = 5000;

export function startBridge(ctx: Context, config: Config): BridgeLifecycle {
  const logger: ChannelLogger = ctx.logger('channel-harness');
  const bindingStore = createBindingStore(config.bindingStore);
  const agentGateway = new HarnessAgentGateway(ctx, config.agentOptions);
  const agentManager = new AgentManager(agentGateway, logger, config.maxConcurrency);
  const agentRouter = new AgentRouter(config);
  const getAdapter = (channelId: string): ChannelAdapter | undefined =>
    ctx.channels.get(channelId);

  // One shared ReplyContextStore: the bridge registers per-message reply
  // context (keyed by Harness UserMessage id), the `agent/inbox/claimed`
  // listener claims it into an active `sessionId`+`turn` slot, and the reply
  // router resolves it lazily when chunks flow.
  const replyContexts = new ReplyContextStore();

  // Correlation listeners (v1.1 §15/§18/§19). They are plain `ctx.on` and
  // therefore auto-dispose with the context, but they must stay active for the
  // WHOLE bridge lifetime (not just during drain) — a turn claimed while the
  // plugin is still live must correlate. Registered at the top level
  // (outside the effect) so they are not tied to any drain window.
  ctx.on(
    'agent/inbox/claimed',
    ({ agent, message, turn }: { agent: { session: { id: string } }; message: { id: string }; turn: number }) => {
      replyContexts.claim({
        sessionId: String(agent.session.id),
        messageId: String(message.id),
        turn,
      });
    },
  );
  ctx.on(
    'agent/inbox/discarded',
    ({ message }: { message: { id: string } }) => {
      replyContexts.discard(String(message.id));
    },
  );

  const replyRouter = new ReplyRouter({
    config: config.reply,
    getAdapter,
    getBinding: (sessionId) => agentManager.bindingFor(sessionId),
    replyContexts,
    logger,
  });
  const stopListening = replyRouter.attach(ctx);

  const bridge = new ChannelHarnessBridge({
    config,
    bindingStore,
    agentManager,
    agentRouter,
    getAdapter,
    replyContexts,
    logger,
  });
  // Return the promise so `ChannelService.emit` awaits the bridge and can
  // surface async failures to the emitting adapter instead of swallowing them.
  const stopInbound = ctx.channels.on((event) => bridge.handleChannelEvent(event));

  let disposed = false;

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    // 1. Stop new inbound (adapter events no longer reach the bridge).
    stopInbound();
    // 2. Keep the `session/event` listener attached and drain active turns
    //    with a bounded wait, so a turn still streaming at unload can still
    //    deliver its `turn/end` (and final chunks) through the reply pipeline.
    await drainActiveTurns(agentManager, replyRouter, logger);
    // 3. Finalize any replies still marked active whose `turn/end` never
    //    arrived (deliver buffered/final text or fail the handle).
    await replyRouter.flushAll();
    // 4. Stop listening to `session/event`.
    stopListening();
    // 5. Dispose owned agent handles (each exactly once).
    await agentManager.disposeAll();
    // 6. Dispose the reply router (clear timers).
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
