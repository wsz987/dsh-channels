/**
 * ChannelHarnessBridge — the inbound half: `ChannelEvent` -> session binding
 * -> agent resolution -> command plane / `agent.followup` (doc H0.3–H0.7,
 * command plane plan §8–§20).
 *
 * Only `message.received` is handled in v1; every other event type is logged
 * at debug level. Conversations are isolated by their canonical key
 * (channel:account:conversation[:thread]), never by account alone.
 *
 * Two input planes (§30): a **human command plane** (official
 * `@deepseek-ai/dsh-commands` `parseCommand`/`commands.execute`) and a
 * **model message plane** (`agent.followup`). A syntactically valid command
 * is resolved through the official registry and its `CommandResult` is
 * rendered directly to the channel — it is never sent to the model and never
 * creates `assistant/message` (`ReplyRouter` is bypassed). Ordinary text
 * keeps the unchanged followup path.
 *
 * Per-conversation serialization (§18): all `message.received` handling for
 * one canonical key runs through a lightweight per-key promise chain so a
 * `/new` fully completes (Binding → B) before the next message on the SAME
 * conversation starts, while different conversations run in parallel. Errors
 * are caught + logged and never poison the chain.
 */
import { randomUUID } from 'node:crypto';
import { type Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { parseCommand, type CommandResult } from '@deepseek-ai/dsh-commands';
import type {
  ChannelAdapter,
  ChannelLogger,
  ChannelEvent,
  ChannelTarget,
  MessageReceived,
  TextPart,
} from '@wsz987/channel-core';
import type { Config } from './config.js';
import type { SessionBindingStore } from './binding-store.js';
import type { AgentManager, AgentRef } from './agent-manager.js';
import type { AgentRouter, AgentRouteSpec } from './agent-router.js';
import { routesEqual } from './agent-router.js';
import {
  sessionKey,
  type SessionBinding,
  type SessionKeyInput,
} from './session-router.js';
import type { ChannelWorkspaceResolver } from './workspace-resolver.js';
import { toHarnessUserMessage, type SaveImageHook } from './message-converter.js';
import { ReplyContextStore } from './reply-context-store.js';
import {
  installChannelCommands,
  type ChannelCommandDependencies,
} from './commands/index.js';
import { toLoggableError } from './loggable-error.js';
import { ChannelSessionFactory } from './channel-session-factory.js';

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
  /**
   * The Cordis context on which the official `commands` registry is mounted.
   * `ctx.commands.execute` is the official command dispatcher (plan §8).
   */
  ctx: Context;
  /** Bridge hook the channel commands need (the one-capability `startNewSession`). */
  commandDeps: ChannelCommandDependencies;
  /**
   * Resolves a channel conversation to a Session working directory and (when
   * applicable) a Harness `WorkspaceRegistry` member (plan §6 / §9 / M3).
   */
  workspaceResolver: ChannelWorkspaceResolver;
}

/**
 * Retained for API compatibility: an error historically raised when Workspace
 * attach failed inside fresh Session creation. As of the soft-attach semantics
 * (plan §11 revision), a Workspace attach failure NO LONGER throws — the
 * freshly-created session is kept, grouped as ungrouped, and the binding +
 * followup continue. This class is no longer produced by the bridge.
 *
 * @deprecated Workspace attachment failures are now non-fatal and no longer
 * produce this error. Retained only for compatibility with existing imports.
 */
export class ChannelWorkspaceAttachError extends Error {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly channelId: string;
  readonly accountId: string;
  constructor(input: {
    sessionId: string;
    workspaceId: string;
    cwd: string;
    channelId: string;
    accountId: string;
  }) {
    super(`channel session '${input.sessionId}' could not attach to workspace '${input.workspaceId}'`);
    this.name = 'ChannelWorkspaceAttachError';
    this.sessionId = input.sessionId;
    this.workspaceId = input.workspaceId;
    this.cwd = input.cwd;
    this.channelId = input.channelId;
    this.accountId = input.accountId;
  }
}

export class ChannelHarnessBridge {
  private readonly sessionFactory: ChannelSessionFactory;

  constructor(private readonly options: ChannelHarnessBridgeOptions) {
    this.sessionFactory = new ChannelSessionFactory({
      ctx: options.ctx,
      cwd: options.config.cwd,
      bindingStore: options.bindingStore,
      agentManager: options.agentManager,
      workspaceResolver: options.workspaceResolver,
      commandSetup: this.commandSetup,
      logger: options.logger,
    });
  }

  /**
   * Per-conversation serialization (plan §18). Each canonical key has an
   * owning promise chain; a new `message.received` is appended onto the
   * previous entry for that key so it starts only after the prior one settles,
   * while distinct keys run in parallel. Errors in one message are caught +
   * logged (the chain never rejects), finished entries are removed so the map
   * does not grow unboundedly, and the current call still resolves only after
   * THIS event has been handled (Promise<void> semantics preserved).
   */
  async handleChannelEvent(event: ChannelEvent): Promise<void> {
    if (event.type !== 'message.received') {
      this.options.logger.debug(`[channel-harness] ignoring channel event '${event.type}'`);
      return;
    }

    const key = this.conversationKey(event);
    const prev = this.chains.get(key) ?? Promise.resolve();
    // This event's actual work, chained onto the previous entry for this key.
    const task = prev.then(() => this.handleMessageReceived(event));
    // The chain entry absorbs errors (logged, never rethrown) so ONE failing
    // message never poisons the conversation chain; the next event still starts.
    const chain = task.catch((error: unknown) => {
      this.options.logger.error(
        `[channel-harness] message handling failed for conversation '${key}'`,
        toLoggableError(error),
      );
    });
    this.chains.set(key, chain);
    void chain.finally(() => {
      if (this.chains.get(key) === chain) this.chains.delete(key);
    });
    // Surface THIS event's error to its await-er (preserves the prior
    // rejection semantics), even though the chain itself never rejects.
    await task;
  }

  /** Per-conversation promise chains (plan §18); entries self-clean on settle. */
  private readonly chains = new Map<string, Promise<void>>();

  /**
   * One-time Agent-scoped command setup (plan §4/§6). Installs the channel
   * commands onto an Agent's scoped context. Passed to every
   * create/resolve/resolveOrCreate so a fresh OR resumed session gets the
   * /new registration before any driving happens.
   */
  // Bound arrow: passed to create/resolve/resolveOrCreate as the official
  // AgentSetup (invoked as a bare setup(agentCtx)), so this must stay the
  // bridge instance.
  private commandSetup = async (agentCtx: Context): Promise<void> => {
    await installChannelCommands(agentCtx, this.options.commandDeps);
  };

  private conversationKey(event: MessageReceived): string {
    return sessionKey({
      channelId: event.channel,
      accountId: event.accountId,
      conversationId: event.conversation.id,
      ...(event.conversation.threadId ? { threadId: event.conversation.threadId } : {}),
    });
  }

  /** Conversation identity of an inbound event, as a bindable SessionKeyInput. */
  private conversationInput(event: MessageReceived): SessionKeyInput {
    return {
      channelId: event.channel,
      accountId: event.accountId,
      conversationId: event.conversation.id,
      ...(event.conversation.threadId ? { threadId: event.conversation.threadId } : {}),
    };
  }

  private async handleMessageReceived(event: MessageReceived): Promise<void> {
    const key = this.conversationKey(event);
    const route = this.options.agentRouter.resolve({
      channelId: event.channel,
      accountId: event.accountId,
      conversationId: event.conversation.id,
    });
    const now = Date.now();

    // The command parser operates on the RAW user text (the concatenated plain
    // text blocks), never on the '[channel=.. sender=.. message=..] ' metadata
    // prefix the model-facing converter prepends, and never after a trim (the
    // official parseCommand requires '/' at byte zero).
    const text = event.message.content
      .filter((part): part is TextPart => part.type === 'text')
      .map((part) => part.text)
      .join('');
    const parsed = parseCommand(text);
    const parsedName = parsed?.name ?? null;

    let binding = await this.options.bindingStore.get(key);
    let archivedSessionId: string | undefined;
    if (binding && this.options.workspaceResolver.isSessionArchived?.(binding.sessionId)) {
      archivedSessionId = binding.sessionId;
      this.options.logger.info('[channel-harness] archived binding will roll to a fresh session', {
        sessionId: archivedSessionId,
        bindingKey: key,
      });
      // Treat an archived binding like an absent binding for admission. The
      // durable entry is intentionally left untouched until the Session factory
      // commits its replacement, preserving rollback semantics on failure.
      binding = undefined;
    }
    let agentRef: AgentRef | undefined;

    if (!binding) {
      // --- Bootstrap: no receiving agent exists yet (plan §19) ------------------
      if (parsed) {
        if (parsedName === 'new') {
          // First message is /new: boot a brand-new session directly — do NOT
          // create session A and then run /new on it (no double-create). The
          // arg contract mirrors the registered handler (用法：/new).
          if (parsed.rawInput.trim().length > 0) {
            await this.sendCommandNotice(event, '用法：/new');
            return;
          }
          await this.sessionFactory.create(this.conversationInput(event), route);
          if (archivedSessionId) {
            await this.options.agentManager.retireSession(archivedSessionId);
          }
          await this.sendCommandNotice(event, '已开启新会话。');
          return;
        }
        // Unknown command before any session exists.
        await this.sendCommandNotice(event, '未知指令：/' + parsed.name);
        return;
      }
      // Ordinary first message: mint the session, create the agent, persist the
      // binding (with rollback on binding-write failure), and register it.
      const fresh = await this.sessionFactory.create(this.conversationInput(event), route);
      binding = fresh.binding;
      agentRef = fresh.agentRef;
      if (archivedSessionId) {
        await this.options.agentManager.retireSession(archivedSessionId);
      }
    } else {
      // --- Existing conversation: reconcile route snapshot + create-vs-resume --
      if (!routesEqual(binding.route, route)) {
        binding = { ...binding, route, updatedAt: now };
        await this.options.bindingStore.put(binding);
      }
      // Decide create vs resume. Live agent -> borrow (both paths). Otherwise
      // resume when persistence is present and the persisted session exists; a
      // missing persistence (or missing persisted session) recreates.
      if (this.options.agentManager.canResume() && (await this.options.agentManager.exists(binding.sessionId))) {
        agentRef = await this.options.agentManager.resolve(binding.sessionId, route, this.commandSetup);
      } else {
        agentRef = await this.options.agentManager.resolveOrCreate(binding.sessionId, route, this.commandSetup);
      }
      this.options.agentManager.registerBinding(binding);
    }

    // --- Command admission (plan §8) -------------------------------------------
    if (parsed) {
      const beforeSessionId = binding.sessionId;
      const controller = new AbortController();
      const execution = await this.options.ctx.commands.execute(
        agentRef!.agent,
        text,
        controller.signal,
      );
      if (!execution) {
        // Syntactically valid but unregistered command — never sent to the model.
        await this.sendCommandNotice(event, "未知指令：/" + parsed.name);
        return;
      }
      await this.renderCommandResult(event, execution.result);
      // Generic post-command cleanup (plan §14): whichever command switched the
      // active binding gets its previous session retired. No command-name
      // special-casing.
      const currentBinding = await this.options.bindingStore.get(key);
      if (currentBinding && currentBinding.sessionId !== beforeSessionId) {
        await this.options.agentManager.retireSession(beforeSessionId);
      }
      return;
    }

    // --- Ordinary message path (unchanged) ---------------------------------------
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
    agentRef!.followup(userMessage);
  }

  /**
   * The `commandDeps.startNewSession` implementation (plan §12/§13/§17).
   * Resolves the conversation from the CURRENT binding of the invoking agent
   * (the session id IS the agent id), then asks the Session factory to mint a
   * NEW session id (never a copy of the old one). The factory also attaches
   * the new session to the same channel Workspace and
   * registers its binding. The OLD agent is NOT disposed here; the bridge's
   * post-command retire handles that. If the factory throws, the old binding
   * stays untouched (we never delete it before the new
   * one is safely written; a binding-write failure disposes the fresh agent
   * inside its transaction, while a Workspace-attach failure does NOT —
   * the new session stays alive, merely ungrouped).
   */
  async startNewSession(agent: Agent): Promise<void> {
    const sessionId = String(agent.id);
    const oldBinding = this.options.agentManager.bindingFor(sessionId);
    if (!oldBinding) {
      throw new Error("startNewSession: no binding for session '" + sessionId + "'");
    }
    // Re-resolve through the current routing rules before creating the Session,
    // so /new follows today's overrides rather than the old binding snapshot.
    const route = this.options.agentRouter.resolve({
      channelId: oldBinding.channelId,
      accountId: oldBinding.accountId,
      conversationId: oldBinding.conversationId,
    });
    await this.sessionFactory.create(
      {
        channelId: oldBinding.channelId,
        accountId: oldBinding.accountId,
        conversationId: oldBinding.conversationId,
        ...(oldBinding.threadId ? { threadId: oldBinding.threadId } : {}),
      },
      route,
    );
  }

  /**
   * Deliver a command-plane notice directly through the channel adapter — never
   * through ReplyRouter and never as an assistant/model message (plan §10).
   */
  private async sendCommandNotice(event: MessageReceived, text: string): Promise<void> {
    const adapter = this.options.getAdapter(event.channel);
    if (!adapter) {
      this.options.logger.warn(
        `[channel-harness] no adapter for channel '${event.channel}' — could not deliver command notice`,
      );
      return;
    }
    await adapter.send(this.targetForEvent(event), { text });
  }

  /** Render a settled CommandResult to the channel (success/error text). */
  private async renderCommandResult(event: MessageReceived, result: CommandResult): Promise<void> {
    if (result.kind === 'error') {
      await this.sendCommandNotice(event, result.text);
      return;
    }
    if (result.text) {
      await this.sendCommandNotice(event, result.text);
    }
  }

  /** Build the outbound ChannelTarget from the inbound conversation + message. */
  private targetForEvent(event: MessageReceived): ChannelTarget {
    const target: ChannelTarget = {
      channelId: event.channel,
      accountId: event.accountId,
      conversationId: event.conversation.id,
      conversationType: event.conversation.type,
      ...(event.conversation.threadId
        ? { threadId: event.conversation.threadId, replyToMessageId: event.message.id }
        : { replyToMessageId: event.message.id }),
    };
    return target;
  }
}
