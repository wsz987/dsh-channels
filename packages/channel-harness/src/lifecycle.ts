/**
 * Bridge lifecycle assembly (doc §4 / §40).
 *
 * `startBridge(ctx, config, persistence?)` wires everything together and
 * returns a disposer with the mandated stop order (doc 4.3):
 * 1. stop new inbound (unregister the ChannelService listener);
 * 2. drain active turns (`whenIdle`, bounded by a timeout);
 * 3. RECONCILE replies from the Session durable log — final-reply correctness
 *    comes from the (durable) Session log, not from the `session/event`
 *    listener still being attached;
 * 4. flush any replies still marked active (`ReplyRouter.flushAll`);
 * 5. stop listening to `session/event`;
 * 6. dispose all owned agent handles;
 * 7. dispose the ReplyRouter (clear timers).
 *
 * Persistence is an OPTIONAL capability resolved at the use site: the caller
 * (plugin) queries `ctx.get('sessionPersistence')`, and the gateway's
 * `canResume()` reflects whether it is present.
 *
 * Two reply-context correlation listeners (`agent/inbox/claimed` and
 * `agent/inbox/discarded`) are registered on the Cordis context; they are
 * plain `ctx.on`, so they auto-dispose with the context and stay active for
 * the whole bridge lifetime.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import { SessionId, type Session, type SessionStore } from '@deepseek-ai/dsh-session';
import type { ChannelAdapter, ChannelEvent, ChannelLogger } from '@dsh/channel-core';
import type { Config } from './config.js';
import { createBindingStore } from './binding-store.js';
import { AgentManager, HarnessAgentGateway } from './agent-manager.js';
import { AgentRouter } from './agent-router.js';
import { ReplyRouter } from './reply-router.js';
import { ChannelHarnessBridge } from './bridge.js';
import { ReplyContextStore } from './reply-context-store.js';
import type { SaveImageHook } from './message-converter.js';

export interface BridgeLifecycle {
  dispose(): Promise<void>;
  handleChannelEvent(event: ChannelEvent): Promise<void>;
}

export function startBridge(
  ctx: Context,
  config: Config,
  persistence?: SessionPersistence | undefined,
): BridgeLifecycle {
  const logger: ChannelLogger = ctx.logger('channel-harness');
  const bindingStore = createBindingStore(config.bindingStore);
  const agentGateway = new HarnessAgentGateway(ctx, persistence);
  const agentManager = new AgentManager(agentGateway, logger, config.maxConcurrency);
  const agentRouter = new AgentRouter(config);
  const getAdapter = (channelId: string): ChannelAdapter | undefined =>
    ctx.channels.get(channelId);

  const replyContexts = new ReplyContextStore();

  // Optional attachment service -> real image path (WX5). Absent in deployments
  // without an attachment backend; the converter then keeps text placeholders.
  const attachments = ctx.get('attachments');
  const saveImage: SaveImageHook | undefined = attachments
    ? (input) => attachments.saveImage(input)
    : undefined;

  // Best-effort typing indicator wiring: a typing API failure must NEVER break
  // the inbound/outbound flow, so every call is fire-and-forget with a swallow.
  const startTyping = (sessionId: string): void => {
    const binding = agentManager.bindingFor(sessionId);
    if (!binding) return;
    const adapter = getAdapter(binding.channelId);
    if (!adapter?.startTyping) return;
    void adapter.startTyping(binding.conversationId).catch(() => {});
  };
  const stopTyping = (sessionId: string): void => {
    const binding = agentManager.bindingFor(sessionId);
    if (!binding) return;
    const adapter = getAdapter(binding.channelId);
    if (!adapter?.stopTyping) return;
    void adapter.stopTyping(binding.conversationId).catch(() => {});
  };

  ctx.on(
    'agent/inbox/claimed',
    ({ agent, message, turn }: { agent: { session: { id: string } }; message: { id: string }; turn: number }) => {
      replyContexts.claim({
        sessionId: String(agent.session.id),
        messageId: String(message.id),
        turn,
      });
      startTyping(String(agent.session.id));
    },
  );
  ctx.on(
    'agent/inbox/discarded',
    ({ message }: { message: { id: string } }) => {
      // Resolve the session id BEFORE dropping the pending entry so we can
      // cancel any typing the (never-claimed) inbound would have triggered.
      const sessionId = replyContexts.pendingSessionId(String(message.id));
      replyContexts.discard(String(message.id));
      if (sessionId) stopTyping(sessionId);
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
    saveImage,
  });
  const stopInbound = ctx.channels.on((event) => bridge.handleChannelEvent(event));

  let disposed = false;

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    // 1. Stop new inbound (adapter events no longer reach the bridge).
    stopInbound();
    // 2. Drain active turns with a bounded wait (the session/event listener is
    //    still attached here, but we do NOT depend on it for final-reply
    //    correctness).
    await drainActiveTurns(agentManager, replyRouter, logger, config.drainTimeoutMs);
    // 3. RECONCILE replies from the Session durable log (final text delivery
    //    does NOT rely on the listener still being attached).
    await reconcileReplies(ctx, persistence, agentManager, replyRouter, logger);
    // 4. Finalize any replies still marked active whose turn/end never arrived.
    await replyRouter.flushAll();
    // 5. Stop listening to session/event.
    stopListening();
    // 6. Dispose owned agent handles (each exactly once).
    await agentManager.disposeAll();
    // 7. Dispose the reply router (clear timers).
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
  drainTimeoutMs: number,
): Promise<void> {
  const sessionIds = replyRouter.activeSessions();
  if (sessionIds.length === 0) return;
  await Promise.all(
    sessionIds.map(async (sessionId) => {
      const ref = agentManager.refFor(sessionId);
      if (!ref) return;
      const timedOut = await withTimeout(ref.whenIdle(), drainTimeoutMs);
      if (timedOut) {
        logger.warn(`[channel-harness] drain timed out for session '${sessionId}'`);
      }
    }),
  );
}

/**
 * Reconcile every active session's reply from the durable log. Reads the live
 * Session when it is still in the store; otherwise inspects persistence. Skips
 * gracefully when neither is available. Final-reply correctness comes from the
 * Session log, not from the still-attached event listener.
 */
async function reconcileReplies(
  ctx: Context,
  persistence: SessionPersistence | undefined,
  agentManager: AgentManager,
  replyRouter: ReplyRouter,
  logger: ChannelLogger,
): Promise<void> {
  const sessionIds = agentManager.activeSessions();
  if (sessionIds.length === 0) return;
  const sessions = ctx.get('sessions') as SessionStore | undefined;
  for (const sessionId of sessionIds) {
    try {
      const live = sessions?.get(SessionId(sessionId)) as Session | undefined;
      if (live) {
        await replyRouter.reconcileSession({ id: sessionId, events: live.events });
        continue;
      }
      if (persistence) {
        const inspection = await persistence.inspect(SessionId(sessionId));
        await replyRouter.reconcileSession({ id: sessionId, events: inspection.events });
      }
      // else: no live session and no persistence — skip gracefully.
    } catch (error) {
      logger.warn(`[channel-harness] reconcile failed for session '${sessionId}'`, error);
    }
  }
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

