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
  ResolvedChannelWorkspace,
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

/**
 * Owns the Channel Session lifecycle as one rollback-aware transaction:
 *
 * - `create` mints a fresh session id for a conversation without a binding;
 * - `recreate` brings an EXISTING binding's session back when its persisted
 *   data is gone (no sessionPersistence mounted, or the persisted session was
 *   lost) — re-running the workspaceResolver so the recreated session lands on
 *   the SAME channel Workspace cwd a first creation would have used, then
 *   re-attaching the workspace and keeping the durable binding.
 *
 * cwd / workspace / binding are SESSION LIFECYCLE concerns, so both paths
 * live here — never in the generic AgentManager.
 */
export class ChannelSessionFactory {
  constructor(private readonly options: ChannelSessionFactoryOptions) {}

  async create(
    conversation: SessionKeyInput,
    route: AgentRouteSpec,
  ): Promise<FreshChannelSession> {
    const sessionId = `ch-${randomUUID()}`;
    const resolved = await this.options.workspaceResolver.resolve(conversation);
    const cwd = this.effectiveCwd(resolved);

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

    const attachedWorkspace = await this.publishSession(sessionId, resolved, cwd, 'fresh');

    const now = Date.now();
    const binding: SessionBinding = {
      channelId: conversation.channelId,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
      // v3: stable conversation identity. The bridge populates this from the
      // event; when a caller omits it we fall back to the legacy dm default.
      conversationType: conversation.conversationType ?? 'dm',
      ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
      ...(conversation.senderId ? { senderId: conversation.senderId } : {}),
      sessionId,
      route,
      schemaVersion: SESSION_BINDING_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
    };

    await this.commitBinding(binding, attachedWorkspace);
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

  /**
   * Recreate the session behind an EXISTING binding whose persisted session is
   * missing (or persistence is unavailable) — the "existing binding -> missing
   * persistence -> recreate" case after a process restart.
   *
   * A live agent in this process is borrowed as-is (nothing to recreate). On a
   * miss, the SAME session id is recreated exactly like a first creation:
   * workspaceResolver re-run (so `header.cwd` lands back on the channel
   * Workspace, never on the host cwd), workspace re-attached, and the durable
   * binding kept (only `updatedAt` refreshed, route snapshot reconciled).
   */
  async recreate(
    binding: SessionBinding,
    route: AgentRouteSpec,
  ): Promise<FreshChannelSession> {
    const sessionId = binding.sessionId;

    // Live agent loaded in this process -> borrow it, no state change.
    const live = await this.options.agentManager.borrowIfLive(
      sessionId,
      route,
      this.options.commandSetup,
    );
    if (live) {
      this.options.logger.debug(
        '[channel-harness] reused live session for existing binding',
        { sessionId, bindingKey: bindingKey(binding) },
      );
      return { binding, agentRef: live };
    }

    const resolved = await this.options.workspaceResolver.resolve(this.conversationOf(binding));
    const cwd = this.effectiveCwd(resolved);

    this.options.logger.debug('[channel-harness] recreating session for existing binding', {
      sessionId,
      channelId: binding.channelId,
      cwd,
      workspaceId: resolved.workspace?.id,
    });

    const agentRef = await this.options.agentManager.create(
      sessionId,
      route,
      this.options.commandSetup,
      { cwd },
    );

    const attachedWorkspace = await this.publishSession(sessionId, resolved, cwd, 'recreated');

    const now = Date.now();
    const refreshed: SessionBinding = { ...binding, route, updatedAt: now };
    await this.commitBinding(refreshed, attachedWorkspace);
    this.options.agentManager.registerBinding(refreshed);
    this.options.logger.info('[channel-harness] channel session recreated (binding kept)', {
      sessionId,
      channelId: binding.channelId,
      accountIdHash: stableSafeAccountKey(binding.accountId),
      workspaceId: attachedWorkspace?.id,
      cwd,
      bindingKey: bindingKey(binding),
    });

    return { binding: refreshed, agentRef };
  }

  /** Rebuild the bindable conversation identity from a durable binding. */
  private conversationOf(binding: SessionBinding): SessionKeyInput {
    return {
      channelId: binding.channelId,
      accountId: binding.accountId,
      conversationId: binding.conversationId,
      conversationType: binding.conversationType,
      ...(binding.senderId ? { senderId: binding.senderId } : {}),
      ...(binding.threadId ? { threadId: binding.threadId } : {}),
    };
  }

  /** Resolved cwd with the same fallback chain used by fresh creation. */
  private effectiveCwd(resolved: ResolvedChannelWorkspace): string {
    return resolved.workspace?.path ?? resolved.cwd ?? this.options.cwd ?? process.cwd();
  }

  /**
   * Publish transaction tail shared by create/recreate: verify the created
   * agent reached `ctx.sessions` (dispose + throw when it did not), then
   * soft-attach the session to the resolved channel workspace (attach failure
   * is NON-FATAL — the session stays alive, grouped as ungrouped).
   */
  private async publishSession(
    sessionId: string,
    resolved: ResolvedChannelWorkspace,
    cwd: string,
    kind: 'fresh' | 'recreated',
  ): Promise<ChannelWorkspaceLike | undefined> {
    const sessions = this.options.ctx.get('sessions');
    const liveSession = sessions?.get(SessionId(sessionId));
    if (sessions && !liveSession) {
      await this.options.agentManager.disposeSession(sessionId);
      throw new Error(
        `ctx.agents.create resolved but session '${sessionId}' is absent from ctx.sessions`,
      );
    }

    this.options.logger.debug(`[channel-harness] ${kind} session published`, {
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

    return attachedWorkspace;
  }

  /**
   * Persist the binding; on failure roll the transaction back (detach the
   * workspace, dispose the freshly created/recreated agent) and rethrow.
   */
  private async commitBinding(
    binding: SessionBinding,
    attachedWorkspace: ChannelWorkspaceLike | undefined,
  ): Promise<void> {
    try {
      await this.options.bindingStore.put(binding);
    } catch (error) {
      await attachedWorkspace?.detachSession(SessionId(binding.sessionId)).catch(() => {});
      await this.options.agentManager.disposeSession(binding.sessionId);
      throw error;
    }
  }
}
