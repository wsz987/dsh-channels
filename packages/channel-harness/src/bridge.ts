/**
 * ChannelHarnessBridge — the inbound half: `ChannelEvent` -> session binding
 * -> agent resolution -> `agent.followup`.
 *
 * Only `message.received` is handled in v1; every other event type is logged
 * at debug level. Conversations are isolated by their canonical key
 * (channel:account:conversation[:thread]), never by account alone (red line 7).
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
import type { AgentRouter } from './agent-router.js';
import type { SessionBinding } from './session-router.js';
import { sessionKey } from './session-router.js';
import { toHarnessUserMessage } from './message-converter.js';
import { ReplyContextStore } from './reply-context-store.js';

export interface ChannelHarnessBridgeOptions {
  config: Config;
  bindingStore: SessionBindingStore;
  agentManager: AgentManager;
  agentRouter: AgentRouter;
  getAdapter(channelId: string): ChannelAdapter | undefined;
  replyContexts: ReplyContextStore;
  logger: ChannelLogger;
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
    let binding = await this.options.bindingStore.get(key);
    const agentId = this.options.agentRouter.resolve({
      channelId: event.channel,
      accountId: event.accountId,
      conversationId: event.conversation.id,
      bindingAgentId: binding?.agentId,
    });
    const now = Date.now();

    let agentRef;
    if (!binding) {
      // New conversation: mint the session id, create the agent, and only
      // THEN persist the binding (v1.1 §33: create success before binding
      // write). If the binding write fails after create, dispose the owned
      // handle to roll back — never leave a dangling owned handle.
      const sessionId = `ch-${randomUUID()}`;
      agentRef = await this.options.agentManager.create(sessionId, agentId);
      binding = {
        channelId: event.channel,
        accountId: event.accountId,
        conversationId: event.conversation.id,
        ...(event.conversation.threadId ? { threadId: event.conversation.threadId } : {}),
        agentId,
        sessionId,
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
      if (binding.agentId !== agentId) {
        binding = { ...binding, agentId, updatedAt: now };
        await this.options.bindingStore.put(binding);
      }
      // Existing conversation: live get → resume; resume failure is loud.
      agentRef = await this.options.agentManager.resolve(binding.sessionId, agentId);
    }

    this.options.agentManager.registerBinding(binding);

    const userMessage = toHarnessUserMessage(event, {
      includeMetadataPrefix: this.options.config.includeMetadataPrefix,
    });
    // Register the reply context keyed by the Harness UserMessage id strictly
    // BEFORE followup, so `agent/inbox/claimed` (the authoritative correlation
    // this replaces) can always find the pending context for this message.
    this.options.replyContexts.register(userMessage.id, {
      sessionId: binding.sessionId,
      context: {
        conversationType: event.conversation.type,
        replyToMessageId: event.message.id,
      },
    });
    agentRef.followup(userMessage);
  }
}
