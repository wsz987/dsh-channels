/**
 * ChannelHarnessBridge — the inbound half: `ChannelEvent` -> session binding
 * -> agent resolution -> `agent.followup` (doc H0.3–H0.7).
 *
 * Only `message.received` is handled in v1; every other event type is logged
 * at debug level. Conversations are isolated by their canonical key
 * (channel:account:conversation[:thread]), never by account alone.
 *
 * The create-vs-resume DECISION lives here (the bridge is the caller):
 * - new conversation -> `agentManager.create`;
 * - existing conversation -> if a sessionPersistence service is available AND
 *   the persisted session exists, `agentManager.resolve` (borrow live, else
 *   resume with the SAME route); otherwise borrow the live agent or recreate
 *   (`resolveOrCreate`). A persistence backend failure propagates loudly — it
 *   is never misread as "no persistence" and never downgraded to create.
 */
import { randomUUID } from 'node:crypto';
import type {
  ChannelAdapter,
  ChannelLogger,
  ChannelEvent,
  MessageReceived,
} from '@dsh/channel-core';
import type { Config } from './config.js';
import type { SessionBindingStore } from './binding-store.js';
import type { AgentManager } from './agent-manager.js';
import type { AgentRouter, AgentRouteSpec } from './agent-router.js';
import { routesEqual } from './agent-router.js';
import { SESSION_BINDING_SCHEMA_VERSION, type SessionBinding } from './session-router.js';
import { sessionKey } from './session-router.js';
import { toHarnessUserMessage, type SaveImageHook } from './message-converter.js';
import { ReplyContextStore } from './reply-context-store.js';

export interface ChannelHarnessBridgeOptions {
  config: Config;
  bindingStore: SessionBindingStore;
  agentManager: AgentManager;
  agentRouter: AgentRouter;
  getAdapter(channelId: string): ChannelAdapter | undefined;
  replyContexts: ReplyContextStore;
  logger: ChannelLogger;
  /** Optional attachment-commit seam (WX5 real image path). */
  saveImage?: SaveImageHook;
}

export class ChannelHarnessBridge {
  constructor(private readonly options: ChannelHarnessBridgeOptions) {}

  /** Main entry point; forwards to the per-type handler. */
  async handleChannelEvent(event: ChannelEvent): Promise<void> {
    if (event.type !== 'message.received') {
      this.options.logger.debug(`[channel-harness] ignoring channel event '${event.type}'`);
      return;
    }
    await this.handleMessageReceived(event);
  }

  private async handleMessageReceived(event: MessageReceived): Promise<void> {
    const key = sessionKey({
      channelId: event.channel,
      accountId: event.accountId,
      conversationId: event.conversation.id,
      ...(event.conversation.threadId ? { threadId: event.conversation.threadId } : {}),
    });
    const route = this.options.agentRouter.resolve({
      channelId: event.channel,
      accountId: event.accountId,
      conversationId: event.conversation.id,
    });
    const now = Date.now();

    let binding = await this.options.bindingStore.get(key);
    let agentRef;
    if (!binding) {
      // New conversation: mint the session id, create the agent, and only
      // THEN persist the binding. If the binding write fails after create,
      // dispose the owned handle to roll back.
      const sessionId = `ch-${randomUUID()}`;
      agentRef = await this.options.agentManager.create(sessionId, route);
      binding = {
        channelId: event.channel,
        accountId: event.accountId,
        conversationId: event.conversation.id,
        ...(event.conversation.threadId ? { threadId: event.conversation.threadId } : {}),
        sessionId,
        route,
        schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this.options.bindingStore.put(binding);
      } catch (error) {
        await this.options.agentManager.disposeSession(sessionId).catch(() => {});
        throw error;
      }
    } else {
      // Existing conversation: if routing changed, update the binding route
      // snapshot (route parity uses the CURRENT route on resume).
      if (!routesEqual(binding.route, route)) {
        binding = { ...binding, route, updatedAt: now };
        await this.options.bindingStore.put(binding);
      }
      // Decide create vs resume. Live agent -> borrow (both paths). Otherwise
      // resume when persistence is present and the persisted session exists;
      // a missing persistence (or missing persisted session) recreates.
      if (this.options.agentManager.canResume() && (await this.options.agentManager.exists(binding.sessionId))) {
        agentRef = await this.options.agentManager.resolve(binding.sessionId, route);
      } else {
        agentRef = await this.options.agentManager.resolveOrCreate(binding.sessionId, route);
      }
    }

    this.options.agentManager.registerBinding(binding);

    // One turn-scoped runId per inbound message: every outbound send scoped to
    // this turn reuses it (the platform sees one correlation, not a fresh UUID
    // per sender call).
    const runId = randomUUID();

    const userMessage = await toHarnessUserMessage(event, {
      includeMetadataPrefix: this.options.config.includeMetadataPrefix,
      saveImage: this.options.saveImage,
    });
    // Register the reply context keyed by the Harness UserMessage id strictly
    // BEFORE followup.
    this.options.replyContexts.register(userMessage.id, {
      sessionId: binding.sessionId,
      context: {
        conversationType: event.conversation.type,
        replyToMessageId: event.message.id,
        runId,
      },
    });
    agentRef.followup(userMessage);
  }
}

