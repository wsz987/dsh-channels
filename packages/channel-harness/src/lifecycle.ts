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
 * Persistence is an OPTIONAL capability resolved LIVE at the use site: the
 * caller passes a resolver (`() => ctx.get('sessionPersistence')`), and the
 * gateway's `canResume()` / probes reflect whether it is present RIGHT NOW —
 * mounting, unmounting, or replacing the service after startup is observed on
 * the next probe (never a startup snapshot).
 *
 * Two reply-context correlation listeners (`agent/inbox/claimed` and
 * `agent/inbox/discarded`) are registered on the Cordis context; they are
 * plain `ctx.on`, so they auto-dispose with the context and stay active for
 * the whole bridge lifetime.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence';
import { SessionId, type Session, type SessionStore } from '@deepseek-ai/dsh-session';
import type { ChannelAdapter, ChannelEvent, ChannelLogger, ChannelTarget } from '@wsz987/channel-core';
import type { Config } from './config.js';
import { createBindingStore } from './binding-store.js';
import { AgentManager, HarnessAgentGateway } from './agent-manager.js';
import { AgentRouter } from './agent-router.js';
import { ReplyRouter } from './reply-router.js';
import { ChannelHarnessBridge } from './bridge.js';
import { ChannelOutboxService } from './outbox/service.js';
import { HarnessChannelWorkspaceResolver } from './workspace-resolver.js';
import { ReplyContextStore, type ChannelReplyContext } from './reply-context-store.js';
import type { ChannelHarnessBridgeOptions } from './bridge.js';
import type { SaveImageHook } from './message-converter.js';
import { installDebugConsoleExporter } from './debug-logger.js';
import type { ChannelFileProvider } from './file-provider.js';
import { installImageModelFallback } from './image-model-fallback.js';

export interface BridgeLifecycle {
  dispose(): Promise<void>;
  handleChannelEvent(event: ChannelEvent): Promise<void>;
}

export function startBridge(
  ctx: Context,
  config: Config,
  resolvePersistence?: () => SessionPersistence | undefined,
): BridgeLifecycle {
  installDebugConsoleExporter(ctx);
  const logger: ChannelLogger = ctx.logger('channel-harness');

  const bindingStore = createBindingStore(config.bindingStore);
  const agentGateway = new HarnessAgentGateway(ctx, resolvePersistence);
  const agentManager = new AgentManager(agentGateway, logger, config.maxConcurrency);
  const stopImageFallback = installImageModelFallback(ctx, agentManager, logger, config.imageCompatibility.mode);
  const agentRouter = new AgentRouter(config);
  const workspaceResolver = new HarnessChannelWorkspaceResolver(ctx, config.workspace, logger);
  const getAdapter = (channelId: string): ChannelAdapter | undefined =>
    ctx.channels.get(channelId);

  const replyContexts = new ReplyContextStore();

  // Optional attachment service -> real image path (WX5). Absent in deployments
  // without an attachment backend; the converter then keeps text placeholders.
  const attachments = ctx.get('attachments');
  const saveImage: SaveImageHook | undefined = attachments
    ? (input) => attachments.saveImage(input)
    : undefined;

  // Optional generic-file extension. Harness currently has a native image
  // service but no generic FileBlock/FileAttachment surface, so deployments
  // may provide this separately without coupling document parsers to the bridge.
  const fileProvider = ctx.get('channelFiles') as ChannelFileProvider | undefined;

  // Best-effort typing indicator wiring: a typing API failure must NEVER break
  // the inbound/outbound flow, so every call is fire-and-forget with a swallow.
  const startTyping = (sessionId: string, context?: ChannelReplyContext): void => {
    const binding = agentManager.bindingFor(sessionId);
    if (!binding) return;
    const adapter = getAdapter(binding.channelId);
    if (adapter?.startTypingForTarget && context) {
      void adapter.startTypingForTarget(typingTarget(binding, context)).catch(() => {});
      return;
    }
    if (adapter?.startTyping) void adapter.startTyping(binding.conversationId).catch(() => {});
  };
  const stopTyping = (sessionId: string, context?: ChannelReplyContext): void => {
    const binding = agentManager.bindingFor(sessionId);
    if (!binding) return;
    const adapter = getAdapter(binding.channelId);
    if (adapter?.stopTypingForTarget && context) {
      void adapter.stopTypingForTarget(typingTarget(binding, context)).catch(() => {});
      return;
    }
    if (adapter?.stopTyping) void adapter.stopTyping(binding.conversationId).catch(() => {});
  };

  ctx.on(
    'agent/inbox/claimed',
    ({ agent, message, turn }: { agent: { session: { id: string } }; message: { id: string }; turn: number }) => {
      const context = replyContexts.claim({
        sessionId: String(agent.session.id),
        messageId: String(message.id),
        turn,
      });
      startTyping(String(agent.session.id), context);
    },
  );
  ctx.on(
    'agent/inbox/discarded',
    ({ message }: { message: { id: string } }) => {
      // Resolve the session id BEFORE dropping the pending entry so we can
      // cancel any typing the (never-claimed) inbound would have triggered.
      const messageId = String(message.id);
      const sessionId = replyContexts.pendingSessionId(messageId);
      const context = replyContexts.pendingContext(messageId);
      replyContexts.discard(messageId);
      if (sessionId) stopTyping(sessionId, context);
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

  // Deferred bridge reference: `commandDeps` routes the /new command backed by
  // the bridge back to the bridge's own fresh-session bootstrap. The arrow only
  // calls `bridge.startNewSession` at runtime (when a command actually runs), by
  // which point the bridge is assigned (definite-assignment assertion below).
  // Durable outbox (plan M6 / §60-§71 / §95): the proactive send path. The
  // binding authority is the DURABLE store (never AgentManager's hint cache),
  // and the adapter lookup + asset store are the same ones the reply pipeline
  // uses. Optional: absent -> the send_channel_message tool is not installed.
  const outbox = new ChannelOutboxService({
    bindingStore,
    getAdapter,
    attachmentResolver: fileProvider
      ? (attachmentId, sessionId) => fileProvider.resolveAttachment(attachmentId, sessionId)
      : undefined,
    logger,
  });

  let bridge!: ChannelHarnessBridge;
  const commandDeps: ChannelHarnessBridgeOptions['commandDeps'] = {
    startNewSession: (agent) => bridge.startNewSession(agent),
  };
  bridge = new ChannelHarnessBridge({
    config,
    bindingStore,
    agentManager,
    agentRouter,
    getAdapter,
    replyContexts,
    logger,
    saveImage,
    fileProvider,
    ctx,
    commandDeps,
    workspaceResolver,
    outbox,
  });
  const stopInbound = ctx.channels.on((event) => bridge.handleChannelEvent(event));

  let disposed = false;

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    // 1. Stop new inbound (adapter events no longer reach the bridge).
    stopInbound();
    // Release this bridge's Agent-scoped commands before a replacement bridge
    // can borrow the same live agents and install fresh handlers.
    await bridge.disposeCommandSetups();
    // 2. Drain active turns with a bounded wait (the session/event listener is
    //    still attached here, but we do NOT depend on it for final-reply
    //    correctness).
    await drainActiveTurns(agentManager, replyRouter, logger, config.drainTimeoutMs);
    // 3. RECONCILE replies from the Session durable log (final text delivery
    //    does NOT rely on the listener still being attached).
    await reconcileReplies(ctx, resolvePersistence, agentManager, replyRouter, logger);
    // 4. Finalize any replies still marked active whose turn/end never arrived.
    await replyRouter.flushAll();
    // 5. Stop listening to session/event.
    stopListening();
    // Active turns may make additional model calls while draining, so keep the
    // provider-boundary image fallback installed until reply processing ends.
    stopImageFallback();
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

function typingTarget(
  binding: { channelId: string; accountId: string; conversationId: string; threadId?: string },
  context: ChannelReplyContext,
): ChannelTarget {
  return {
    channelId: binding.channelId as ChannelTarget['channelId'],
    accountId: binding.accountId as ChannelTarget['accountId'],
    conversationId: binding.conversationId as ChannelTarget['conversationId'],
    threadId: binding.threadId as ChannelTarget['threadId'],
    conversationType: context.conversationType,
    replyToMessageId: context.replyToMessageId as ChannelTarget['replyToMessageId'],
    raw: context.raw,
    runId: context.runId,
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
 * Session when it is still in the store; otherwise inspects persistence
 * (resolved LIVE at dispose time — the currently mounted backend, whatever
 * the bridge started with). Skips gracefully when neither is available.
 * Final-reply correctness comes from the Session log, not from the
 * still-attached event listener.
 */
async function reconcileReplies(
  ctx: Context,
  resolvePersistence: (() => SessionPersistence | undefined) | undefined,
  agentManager: AgentManager,
  replyRouter: ReplyRouter,
  logger: ChannelLogger,
): Promise<void> {
  const sessionIds = agentManager.activeSessions();
  if (sessionIds.length === 0) return;
  const sessions = ctx.get('sessions') as SessionStore | undefined;
  const persistence = resolvePersistence?.();
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
