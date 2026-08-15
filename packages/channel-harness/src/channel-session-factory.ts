import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { AgentSetup } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { ChannelLogger } from '@wsz987/channel-core';
import type { AgentManager, AgentRef } from './agent-manager.js';
import type { AgentRouteSpec } from './agent-router.js';
import type { SessionBindingStore } from './binding-store.js';
import { stableSafeAccountKey } from './channel-label.js';
import { toLoggableError } from './loggable-error.js';
import {
  bindingKey,
  SESSION_BINDING_SCHEMA_VERSION,
  type SessionBinding,
  type SessionKeyInput,
} from './session-router.js';
import type {
  ChannelWorkspaceLike,
  ChannelWorkspaceResolver,
} from './workspace-resolver.js';

export interface FreshChannelSession {
  binding: SessionBinding;
  agentRef: AgentRef;
}

interface ChannelSessionFactoryOptions {
  ctx: Context;
  cwd?: string;
  bindingStore: SessionBindingStore;
  agentManager: AgentManager;
  workspaceResolver: ChannelWorkspaceResolver;
  commandSetup: AgentSetup;
  logger: ChannelLogger;
}

/** Creates and persists fresh channel Sessions as one rollback-aware transaction. */
export class ChannelSessionFactory {
  constructor(private readonly options: ChannelSessionFactoryOptions) {}

  async create(
    conversation: SessionKeyInput,
    route: AgentRouteSpec,
  ): Promise<FreshChannelSession> {
    const sessionId = `ch-${randomUUID()}`;
    const resolved = await this.options.workspaceResolver.resolve(conversation);
    const cwd = resolved.workspace?.path ?? resolved.cwd ?? this.options.cwd ?? process.cwd();

    this.options.logger.debug('[channel-harness] creating fresh session', {
      sessionId,
      channelId: conversation.channelId,
      cwd,
      workspaceId: resolved.workspace?.id,
    });

    const agentRef = await this.options.agentManager.create(
      sessionId,
      route,
      this.options.commandSetup,
      { cwd },
    );

    const sessions = this.options.ctx.get('sessions');
    const liveSession = sessions?.get(SessionId(sessionId));
    if (sessions && !liveSession) {
      await this.options.agentManager.disposeSession(sessionId);
      throw new Error(
        `ctx.agents.create resolved but session '${sessionId}' is absent from ctx.sessions`,
      );
    }

    this.options.logger.debug('[channel-harness] fresh session published', {
      sessionId,
      requestedCwd: cwd,
      sessionCwd: liveSession?.header.cwd,
      workspacePath: resolved.workspace?.path,
    });

    let attachedWorkspace: ChannelWorkspaceLike | undefined;
    if (resolved.workspace) {
      try {
        await resolved.workspace.attachSession(SessionId(sessionId));
        attachedWorkspace = resolved.workspace;
        this.options.logger.debug('[channel-harness] workspace attached', {
          sessionId,
          workspaceId: resolved.workspace.id,
        });
      } catch (error) {
        this.options.logger.error(
          '[channel-harness] workspace attach failed; keeping session alive',
          {
            sessionId,
            requestedCwd: cwd,
            sessionCwd: liveSession?.header.cwd,
            workspaceId: resolved.workspace.id,
            workspacePath: resolved.workspace.path,
            error: toLoggableError(error),
          },
        );
      }
    }

    const now = Date.now();
    const binding: SessionBinding = {
      channelId: conversation.channelId,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
      ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
      sessionId,
      route,
      schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.options.bindingStore.put(binding);
    } catch (error) {
      await attachedWorkspace?.detachSession(SessionId(sessionId)).catch(() => {});
      await this.options.agentManager.disposeSession(sessionId);
      throw error;
    }

    this.options.agentManager.registerBinding(binding);
    this.options.logger.info('[channel-harness] fresh channel session created', {
      sessionId,
      channelId: conversation.channelId,
      accountIdHash: stableSafeAccountKey(conversation.accountId),
      workspaceId: attachedWorkspace?.id,
      cwd,
      bindingKey: bindingKey(binding),
    });

    return { binding, agentRef };
  }
}
