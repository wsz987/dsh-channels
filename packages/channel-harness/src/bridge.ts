/**
 * ChannelHarnessBridge — the inbound half: `ChannelEvent` -> session binding
 * -> agent resolution -> command plane / `agent.followup` (doc H0.3–H0.7,
 * command plane spec §2–§12, §36).
 *
 * Only `message.received` is handled in v1; every other event type is logged
 * at debug level. Conversations are isolated by their canonical key
 * (channel:account:conversation[:thread]), never by account alone.
 *
 * Two input planes: a **human command plane** (official
 * `@deepseek-ai/dsh-commands` `parseCommand`/`commands.execute`) and a
 * **model message plane** (`agent.followup`). A syntactically valid command
 * is resolved through the official registry and its `CommandResult` is
 * rendered directly to the channel — it is never sent to the model and never
 * creates `assistant/message` (`ReplyRouter` is bypassed). An UNREGISTERED
 * slash command follows rc.2 official Host semantics (upgrade plan §10.2):
 * it is rejected with a direct channel notice and never enters the Agent
 * prompt — `commands.execute` returns `undefined` for admission misses,
 * which (given the syntax already parsed) means `ctx.commands.find(agent,
 * name)` missed.
 *
 * Per-conversation serialization: all `message.received` handling for one
 * canonical key runs through a lightweight per-key promise chain so a `/new`
 * fully completes (Binding → B) before the next message on the SAME
 * conversation starts, while different conversations run in parallel. Errors
 * are caught + logged and never poison the chain.
 *
 * `/stop` is the one scheduling exception (spec §4–§10): its COMMAND
 * semantics belong to the registry (see commands/stop.ts), but its SCHEDULING
 * is a FAST PATH executed outside the serial chain — it bumps the
 * per-conversation generation first (invalidating every stale queued message),
 * cancels the live agent, acknowledges immediately (never waiting for
 * `whenIdle`), and enqueues an internal stop barrier that re-cancels the
 * LATEST binding's agent after prior chain work converges (covering the /new
 * race).
 */
import { randomUUID } from 'node:crypto';
import { type Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { parseCommand, type CommandResult, type ParsedCommand } from '@deepseek-ai/dsh-commands';
import type {
  ChannelAdapter,
  ChannelLogger,
  ChannelEvent,
  ChannelTarget,
  InteractionReceived,
  MessageReceived,
  TextPart,
} from '@wsz987/channel-core';
import type { Config } from './config.js';
import type { SessionBindingStore } from './binding-store.js';
import type { AgentManager, AgentRef } from './agent-manager.js';
import { PersistenceUnavailableError, SessionNotFoundError } from './agent-manager.js';
import type { AgentRouter, AgentRouteSpec } from './agent-router.js';
import { routesEqual } from './agent-router.js';
import {
  sessionKey,
  type SessionBinding,
  type SessionKeyInput,
} from './session-router.js';
import type { ChannelWorkspaceResolver } from './workspace-resolver.js';
import {
  toHarnessUserMessage,
  type SaveImageHook,
  type FileStoreHook,
  type StoredBinaryPart,
} from './message-converter.js';
import type { ChannelFileProvider } from './file-provider.js';
import { ReplyContextStore } from './reply-context-store.js';
import type { ChannelOutboxService } from './outbox/service.js';
import { installSendChannelMessageTool } from './outbox/tool-send.js';
import {
  installChannelCommands,
  type ChannelCommandDisposer,
  type ChannelCommandDependencies,
  type ChannelVersionInfo,
} from './commands/index.js';

import { ChannelModelSelectionController } from './model-selection.js';
import { toLoggableError } from './loggable-error.js';
import { ChannelSessionFactory } from './channel-session-factory.js';
import { isReservedClaimCommand } from '@wsz987/channel-core';
import { InboundAccessController } from './access/controller.js';
import type {
  ChannelAccessPolicyResolver,
  ResolvedAccessPolicy,
} from './access/resolver.js';
import type { AccessDecisionReason } from './access/decision.js';
import type { ChannelQuestionPresenter } from './interactions/question-presenter.js';

function trimBrandedId<T extends string>(value: T): T {
  return value.trim() as T;
}

export interface ChannelHarnessBridgeOptions {
  config: Config;
  bindingStore: SessionBindingStore;
  agentManager: AgentManager;
  agentRouter: AgentRouter;
  getAdapter(channelId: string): ChannelAdapter | undefined;
  replyContexts: ReplyContextStore;
  logger: ChannelLogger;
  /** Fail-closed Access Gate resolver (plan §17, §32). */
  accessResolver: ChannelAccessPolicyResolver;
  /**
   * Namespaced logger for access decisions (plan §42, namespace
   * `channel-access`). Falls back to `logger` when not provided. Never logs
   * message body / challenge codes / raw payload / tokens.
   */
  accessLogger?: ChannelLogger;
  /** Optional attachment-commit seam (WX5 real image path). */
  saveImage?: SaveImageHook;
  /** Optional generic-file extension. Absent keeps ordinary file placeholders. */
  fileProvider?: ChannelFileProvider;
  /**
   * The Cordis context on which the official `commands` registry is mounted.
   * `ctx.commands.execute` is the official command dispatcher.
   */
  ctx: Context;
  /**
   * Bridge hook the channel commands need (`startNewSession` + optional
   * model-selection controller; absent -> the bridge owns a default instance).
   */
  commandDeps: Omit<
    ChannelCommandDependencies,
    'modelSelection' | 'listCommands' | 'findCommand' | 'llm' | 'versionInfo'
  > & {
    modelSelection?: ChannelModelSelectionController;
    listCommands?: ChannelCommandDependencies['listCommands'];
    findCommand?: ChannelCommandDependencies['findCommand'];
    llm?: ChannelCommandDependencies['llm'];
    versionInfo?: ChannelCommandDependencies['versionInfo'];

  };
  /**
   * Resolves a channel conversation to a Session working directory and (when
   * applicable) a Harness `WorkspaceRegistry` member.
   */
  workspaceResolver: ChannelWorkspaceResolver;
  /**
   * Optional durable outbox. Presence enables the Model-facing
   * `send_channel_message` tool. Absent -> no proactive send tool.
   */
  outbox?: ChannelOutboxService;
  /**
   * Optional question interaction presenter (Web profile: official ApiProxy
   * mux frames; headless: official UserQuestionProvider). Absent when the
   * user-questions feature is disabled or no transport was probed.
   */
  questionPresenter?: ChannelQuestionPresenter;
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
  private readonly commandDisposers = new Set<ChannelCommandDisposer>();
  private readonly modelSelectionDisposers = new Set<() => void>();
  private commandSetupsDisposed = false;
  /** Thin view over Harness's session/default model semantics. */
  private readonly modelSelection: ChannelModelSelectionController;
  /** Normalized command deps handed to every agent setup. */
  private readonly commandDeps: ChannelCommandDependencies;
  /** Per-conversation generation counters, invalidated by /stop (spec §6). */
  private readonly conversationGenerations = new Map<string, number>();
  /** Pure fail-closed access decision engine (plan §19). No I/O. */
  private readonly accessController = new InboundAccessController();

  constructor(private readonly options: ChannelHarnessBridgeOptions) {
    if (!options.accessResolver) {
      throw new Error('channel-harness requires an access policy resolver');
    }
    this.modelSelection =
      options.commandDeps.modelSelection ?? new ChannelModelSelectionController(options.ctx);
    // Every Harness service reach is bridged LAZILY from the plugin context
    // (options.ctx): command handlers must never read services through
    // invocation.agent.ctx — the agent-loop scoped context does not inject
    // commands/llm, and Cordis throws "without inject" there. This mirrors the
    // /new pattern: narrow deps, bridge-owned implementations (official
    // compact/goal/plan commands close over their plugin ctx the same way).
    this.commandDeps = {
      ...options.commandDeps,
      modelSelection: this.modelSelection,
      listCommands: (agent) => this.options.ctx.commands.list(agent),
      findCommand: (agent, name) => this.options.ctx.commands.find(agent, name),
      llm: {
        listProviders: () => this.options.ctx.llm.listProviders(),
        listModels: (provider) => this.options.ctx.llm.listModels(provider),
        resolveModelInfo: (provider, model, signal) =>
          this.options.ctx.llm.resolveModelInfo(provider, model, signal),
        resolveCallConfig: (config, signal) =>
          this.options.ctx.llm.resolveCallConfig(config, signal),
      },
      // /version's update hint: live probe of the (optional) control plane.
      // `ctx.get` is the official detection API — safe on any scope, undefined
      // when channel-control is not mounted (headless-without-control or the
      // check disabled). The probe re-runs on every /version so an HMR reload
      // of the control plugin is picked up without restarting the bridge.
      versionInfo: async (): Promise<ChannelVersionInfo | undefined> => {
        try {
          const control = this.options.ctx.get('channelControl') as
            | { getUpdateStatus(): Promise<ChannelVersionInfo> }
            | undefined;
          return await control?.getUpdateStatus();
        } catch {
          return undefined;
        }
      },
    };
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

  /** Per-conversation promise chains; entries self-clean on settle. */
  private readonly chains = new Map<string, Promise<void>>();

  /**
   * Per-conversation serialization. Each canonical key has an owning promise
   * chain; `fn` is appended onto the previous entry for that key so it starts
   * only after the prior one settles, while distinct keys run in parallel. The
   * returned promise resolves only after THIS operation has been handled; the
   * chain entry absorbs errors (logged, never rethrown) so ONE failing message
   * never poisons the conversation chain, while this call still surfaces THIS
   * operation's error to its await-er (preserving prior rejection semantics).
   */
  private async enqueueSelf(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const task = prev.then(fn);
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
    await task;
  }

  /**
   * Append work onto the per-conversation chain WITHOUT awaiting its
   * completion (used by the /stop stop barrier — spec §9). The returned
   * promise never rejects.
   */
  private enqueueConversation(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const task = prev.then(fn);
    const chain = task.catch((error: unknown) => {
      this.options.logger.error(
        `[channel-harness] queued message handling failed for conversation '${key}'`,
        toLoggableError(error),
      );
    });
    this.chains.set(key, chain);
    void chain.finally(() => {
      if (this.chains.get(key) === chain) this.chains.delete(key);
    });
    return task.catch(() => undefined);
  }

  async handleChannelEvent(event: ChannelEvent): Promise<void> {
    // Connection/auth state is consumed by the control plane and Web status
    // surface. It is expected to be frequent during startup/reconnect and is
    // not an inbound message for the Harness Agent bridge.
    if (event.type === 'connection.changed' || event.type === 'auth.changed') {
      return;
    }
    if (event.type === 'interaction.received') {
      const normalized = this.normalizeInteractionIdentity(event);
      if (await this.enforceInteractionAccessGate(normalized)) return;
      if (await this.options.questionPresenter?.handleChannelEvent(normalized)) return;
      this.options.logger.debug('[channel-harness] ignoring unmatched interaction.received');
      return;
    }
    if (event.type !== 'message.received') {
      this.options.logger.debug(`[channel-harness] ignoring channel event '${event.type}'`);
      return;
    }

    // The command parser operates on the RAW user text (the concatenated plain
    // text blocks), never on the '[channel=.. sender=.. message=..] ' metadata
    // prefix the model-facing converter prepends, and never after a trim (the
    // official parseCommand requires '/' at byte zero — spec §5).
    const normalizedEvent = this.normalizeInboundIdentity(event);
    const text = normalizedEvent.message.content
      .filter((part): part is TextPart => part.type === 'text')
      .map((part) => part.text)
      .join('');

    // ------------------------------------------------------------------
    // FAIL-CLOSED ACCESS GATE (plan §32). Runs BEFORE any side effect:
    // before conversationKey / parseCommand / /stop / binding writes /
    // session / workspace / agent. A drop here means NO side effect at all
    // (incl. /stop fast path — an unauthorized user can never cancel a live
    // agent or bump the generation, plan §33).
    // ------------------------------------------------------------------
    if (await this.enforceAccessGate(normalizedEvent, text)) return;

    if (await this.options.questionPresenter?.handleChannelEvent(normalizedEvent)) return;

    const key = this.conversationKey(normalizedEvent);
    const parsed = parseCommand(text);

    // P0: /stop is handled on a FAST PATH AND RUNS IMMEDIATELY — it must
    // NEVER be chained behind queued conversation work (spec §4/§5), because
    // the whole point is to interrupt an in-flight turn. `handleImmediateStop`
    // bumps the generation synchronously before its first await, so every
    // already-queued message (captured with the OLD generation) is invalidated
    // at its next generation check and can never re-wake the agent.
    if (parsed?.name === 'stop') {
      try {
        await this.handleImmediateStop(normalizedEvent, key, text);
      } catch (error) {
        this.options.logger.error(
          `[channel-harness] /stop handling failed for conversation '${key}'`,
          toLoggableError(error),
        );
      }
      return;
    }

    const generation = this.generationOf(key);
    await this.enqueueSelf(key, () =>
      this.handleQueuedMessage(normalizedEvent, key, text, parsed, generation),
    );
  }

  /** Apply the contract's only identity normalization before any side effect. */
  private normalizeInboundIdentity(event: MessageReceived): MessageReceived {
    const senderId = trimBrandedId(event.sender.id);
    const conversationId = trimBrandedId(event.conversation.id);
    if (senderId === event.sender.id && conversationId === event.conversation.id) {
      return event;
    }
    return {
      ...event,
      sender: { ...event.sender, id: senderId },
      conversation: { ...event.conversation, id: conversationId },
    };
  }

  private normalizeInteractionIdentity(event: InteractionReceived): InteractionReceived {
    return {
      ...event,
      sender: { ...event.sender, id: trimBrandedId(event.sender.id) },
      conversation: {
        ...event.conversation,
        id: trimBrandedId(event.conversation.id),
      },
    };
  }

  /** Interaction admission reuses Security Gate semantics; the click is activation. */
  private async enforceInteractionAccessGate(event: InteractionReceived): Promise<boolean> {
    const accessLogger = this.options.accessLogger ?? this.options.logger;
    if (!event.sender.id || event.sender.id === 'unknown') {
      this.dropInteraction(accessLogger, event, 'unidentified_sender');
      return true;
    }
    if (!event.conversation.id) {
      this.dropInteraction(accessLogger, event, 'invalid_conversation');
      return true;
    }
    let resolved: ResolvedAccessPolicy;
    try {
      resolved = await this.options.accessResolver.resolve(event.channel, event.accountId);
    } catch (error) {
      this.options.logger.warn('[channel-access] policy resolution failed', toLoggableError(error));
      return true;
    }
    if (resolved.state !== 'present') {
      this.dropInteraction(
        accessLogger,
        event,
        resolved.state === 'missing' ? 'missing_policy' : 'invalid_policy',
      );
      return true;
    }
    const decision = this.accessController.authorize({
      conversationType: event.conversation.type,
      senderId: event.sender.id,
      conversationId: event.conversation.id,
      policy: resolved.policy,
    });
    if (!decision.authorized) {
      this.dropInteraction(accessLogger, event, decision.reason);
      return true;
    }
    return false;
  }

  private dropInteraction(
    logger: ChannelLogger,
    event: InteractionReceived,
    reason: AccessDecisionReason,
  ): void {
    logger.info('[channel-access] interaction dropped', {
      channel: event.channel,
      account: event.accountId,
      conversationType: event.conversation.type,
      reason,
    });
  }

  /**
   * One-time Agent-scoped command and model-hook setup. Installed onto an
   * Agent's scoped context by every create/resolve and by the Session
   * factory's recreate (borrow + create) so a fresh, resumed OR recreated
   * session gets the channel commands and channel hooks before any driving
   * happens. Harness still resolves the Session model at creation/resume.
   * Channel images are NOT rewritten here: the inbound converter hands raw
   * images to the Harness Attachment Store and the official rc.2 image
   * pipeline owns model-capability projection (vision variant / text-only
   * deterministic placeholder), so the Agent-scoped history keeps the
   * original ImageBlock.
   */
  // Bound arrow: passed to create/resolve/borrowIfLive as the official
  // AgentSetup (invoked as a bare setup(agentCtx)), so this must stay the
  // bridge instance.
  private commandSetup = async (agentCtx: Context): Promise<void> => {
    const disposeCommands = await installChannelCommands(agentCtx, this.commandDeps);
    const disposeModelSelection = this.modelSelection.install(agentCtx);
    if (this.commandSetupsDisposed) {
      await disposeCommands();
      disposeModelSelection();
      throw new Error('channel-harness command setup continued after bridge disposal');
    }
    this.commandDisposers.add(disposeCommands);
    this.modelSelectionDisposers.add(disposeModelSelection);
    // M4: Agent-scoped read_channel_attachment tool. Registered on the agent's
    // own scope so it is disposed with the agent. Best-effort: a tool-install
    // failure must never roll back the agent setup.
    if (this.options.fileProvider) {
      try {
        await this.options.fileProvider.installTools(agentCtx);
      } catch (error) {
        this.options.logger.warn('[channel-harness] failed to install read_channel_attachment tool', error);
      }
    }
    // M6: Agent-scoped send_channel_message tool. Only installed when the
    // durable outbox is wired. Best-effort, mirroring the attachment tool.
    if (this.options.outbox) {
      try {
        await installSendChannelMessageTool(agentCtx, { outbox: this.options.outbox });
      } catch (error) {
        this.options.logger.warn('[channel-harness] failed to install send_channel_message tool', error);
      }
    }
  };

  /** Release this bridge's Agent-scoped command and model-hook registrations. */
  async disposeCommandSetups(): Promise<void> {
    this.commandSetupsDisposed = true;
    const commandDisposers = [...this.commandDisposers];
    this.commandDisposers.clear();
    const modelDisposers = [...this.modelSelectionDisposers];
    this.modelSelectionDisposers.clear();
    await Promise.all([
      ...commandDisposers.map((dispose) => dispose()),
      ...modelDisposers.map((dispose) => Promise.resolve(dispose())),
    ]);
  }

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
      // v3: stable conversation identity captured for the durable binding.
      conversationType: event.conversation.type,
      ...(event.sender.id ? { senderId: event.sender.id } : {}),
      ...(event.conversation.threadId ? { threadId: event.conversation.threadId } : {}),
    };
  }

  /**
   * Whether the durable session behind an existing binding is MISSING — the
   * stale condition behind both the EXPLICIT stale-binding repair (/new) and
   * the loud SessionNotFoundError for every other request. A live agent is
   * never stale (live-first: no persistence probe), and without a mounted
   * sessionPersistence there is no durable identity to lose (ephemeral
   * deployments recreate instead). One ATOMIC probe decides all three cases
   * (live capability resolved once — no canResume/exists TOCTOU across a
   * persistence HMR).
   */
  private async isDurableSessionMissing(binding: SessionBinding): Promise<boolean> {
    if (this.options.agentManager.getLiveAgent(binding.sessionId)) return false;
    const probe = await this.options.agentManager.probePersisted(binding.sessionId);
    return probe === 'missing';
  }

  /** Bindings without the field predate the stable policy; fail closed. */
  private bindingDurability(binding: SessionBinding): 'ephemeral' | 'durable' {
    return binding.durability ?? 'durable';
  }

  /**
   * FAIL-CLOSED Access Gate (plan §32, §33, §42). Returns true when the message
   * must be DROPPED with NO side effect (agent / command / session / binding /
   * workspace / generation / /stop fast path), false to let it proceed.
   *
   * Order (plan §32):
   *   1. Reserved claim suppression (/dsh-claim never reaches anything).
   *   2. Identity validation (plan §9): sender + conversation ids.
   *   3. Resolve policy (missing/invalid -> drop, fail closed).
   *   4. Authorize (security gate) + activate (activation gate).
   *
   * Logging follows plan §42: `channel-access` logger, minimal fields
   * (channel / account / conversationType / reason), never message body,
   * challenge code, raw payload or tokens.
   */
  private async enforceAccessGate(event: MessageReceived, text: string): Promise<boolean> {
    const accessLogger = this.options.accessLogger ?? this.options.logger;

    // 1. Reserved owner-claim suppression (plan §20, §34): /dsh-claim must
    //    NEVER reach model / command dispatcher / Session / Binding, even when
    //    no access policy exists. Static drop — no policy read is needed.
    if (isReservedClaimCommand(text)) {
      accessLogger.debug('[channel-access] reserved claim message suppressed', {
        channel: event.channel,
        account: event.accountId,
      });
      return true;
    }

    // 2. Identity validation (plan §9): sender.id must be a non-empty string
    //    and !== 'unknown'; conversation.id must be non-empty.
    const senderId = event.sender.id;
    const conversationId = event.conversation.id;
    if (
      typeof senderId !== 'string' ||
      senderId.length === 0 ||
      senderId === 'unknown'
    ) {
      this.dropInbound(accessLogger, event, 'unidentified_sender');
      return true;
    }
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      this.dropInbound(accessLogger, event, 'invalid_conversation');
      return true;
    }

    // 3. Resolve the policy (fail closed; plan §15/§17).
    let resolved: ResolvedAccessPolicy;
    try {
      resolved = await this.options.accessResolver.resolve(event.channel, event.accountId);
    } catch (error) {
      this.options.logger.warn('[channel-access] policy resolution failed', toLoggableError(error));
      return true;
    }
    if (resolved.state === 'missing') {
      this.dropInbound(accessLogger, event, 'missing_policy');
      return true;
    }
    if (resolved.state === 'invalid') {
      this.dropInbound(accessLogger, event, 'invalid_policy');
      return true;
    }

    // 4. Authorize (Security Gate) then activate (Activation Gate).
    const decision = this.accessController.authorize({
      conversationType: event.conversation.type,
      senderId,
      conversationId,
      mentionedBot: event.message.activation?.mentionedBot,
      policy: resolved.policy,
    });
    if (!decision.authorized) {
      this.dropInbound(accessLogger, event, decision.reason);
      return true;
    }
    if (!decision.activated) {
      this.dropInbound(accessLogger, event, decision.reason);
      return true;
    }

    return false;
  }

  /** Log a fail-closed inbound drop with minimal plan-§42 fields. */
  private dropInbound(
    accessLogger: ChannelLogger,
    event: MessageReceived,
    reason: AccessDecisionReason,
  ): void {
    accessLogger.info('[channel-access] inbound dropped', {
      channel: event.channel,
      account: event.accountId,
      conversationType: event.conversation.type,
      reason,
    });
  }

  /**
   * Queued (serialized) message handling for one conversation. Captures the
   * generation at ENQUEUE time; /stop bumps it, so this callback drops out at
   * either generation check and can never re-wake a stopped agent (spec §7).
   */
  private async handleQueuedMessage(
    event: MessageReceived,
    key: string,
    text: string,
    parsed: ParsedCommand | undefined,
    generation: number,
  ): Promise<void> {
    // Check #1: fast-drop work already invalidated by /stop (spec §7).
    if (!this.isGenerationCurrent(key, generation)) return;

    const route = this.options.agentRouter.resolve({
      channelId: event.channel,
      accountId: event.accountId,
      conversationId: event.conversation.id,
    });
    const now = Date.now();
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
    // /new is the ONE EXPLICIT stale-binding repair path — NOT a
    // session-recovery branch: the user is explicitly authorizing abandonment
    // of the old session (its persisted data is gone, so ordinary recovery
    // would throw session-not-found) and creation of a fresh one that replaces
    // the binding. Every other request on the stale binding still fails loud:
    // the inconsistency is never auto-repaired.
    if (
      binding &&
      parsed &&
      parsedName === 'new' &&
      (await this.isDurableSessionMissing(binding))
    ) {
      // Arg contract mirrors the registered handler (用法：/new).
      if (parsed.rawInput.trim().length > 0) {
        await this.sendCommandNotice(event, '用法：/new');
        return;
      }
      const staleSessionId = binding.sessionId;
      this.options.logger.info('[channel-harness] /new repairs a stale binding (persisted session missing)', {
        sessionId: staleSessionId,
        bindingKey: key,
      });
      await this.sessionFactory.create(this.conversationInput(event), route);
      // Clear the stale session's reverse cache (never live/owned -> the
      // retire is a no-op dispose); the factory has already overwritten the
      // binding with the fresh session.
      await this.options.agentManager.retireSession(staleSessionId);
      await this.sendCommandNotice(event, '旧会话数据已丢失，已开启新会话。');
      return;
    }
    let agentRef: AgentRef | undefined;

    if (!binding) {
      // --- Bootstrap: no receiving agent exists yet (spec §37/§38) -----------
      if (parsed && parsedName === 'new') {
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
      // Every other first message (ordinary text, /help, /status, /models,
      // /model, or an unknown /foo) mints the session and continues below —
      // first-message /help/status/models/model must work (spec §38). An
      // unknown /foo is then rejected at command admission (rc.2 Host parity;
      // the session must exist first because channel commands register in the
      // Agent scope and cannot be resolved without one).
      const fresh = await this.sessionFactory.create(this.conversationInput(event), route);
      binding = fresh.binding;
      agentRef = fresh.agentRef;
      if (archivedSessionId) {
        await this.options.agentManager.retireSession(archivedSessionId);
      }
    } else {
      // --- Existing conversation: reconcile route snapshot + resolve ----------
      if (!routesEqual(binding.route, route)) {
        binding = { ...binding, route, updatedAt: now };
        await this.options.bindingStore.put(binding);
      }
      // Existing-binding resolution follows the official Host resolver order
      // (live agent -> persistence membership -> resume), never the reverse:
      //   ① a LIVE agent is borrowed FIRST — persistence is never scanned for
      //      an agent already live in this process (with thousands of sessions
      //      the per-inbound persistence scan would dominate);
      //   ② one ATOMIC probe decides the rest; availability is not durability:
      //      durable + unavailable -> fail loud (never recreate);
      //      ephemeral + unavailable -> recreate via the Session factory;
      //   ③ membership hit -> resume;
      //   ④ membership MISS -> durable binding => session-not-found, while an
      //      explicitly ephemeral binding may recreate the recorded id.
      const borrowed = await this.options.agentManager.borrowIfLive(
        binding.sessionId,
        route,
        this.commandSetup,
      );
      if (borrowed) {
        agentRef = borrowed;
      } else {
        const probe = await this.options.agentManager.probePersisted(binding.sessionId);
        if (probe === 'unavailable' && this.bindingDurability(binding) === 'ephemeral') {
          const recreated = await this.sessionFactory.recreate(binding, route);
          binding = recreated.binding;
          agentRef = recreated.agentRef;
        } else if (probe === 'present') {
          agentRef = await this.options.agentManager.resolve(binding.sessionId, route, this.commandSetup);
        } else if (probe === 'unavailable') {
          throw new PersistenceUnavailableError(binding.sessionId, key);
        } else if (this.bindingDurability(binding) === 'ephemeral') {
          const recreated = await this.sessionFactory.recreate(binding, route);
          binding = recreated.binding;
          agentRef = recreated.agentRef;
        } else {
          throw new SessionNotFoundError(binding.sessionId, key);
        }
      }
      this.options.agentManager.registerBinding(binding);
    }

    // --- Command admission (rc.2 Host parity, upgrade plan §10.2) -----------
    // Registered commands run on the Human Command Plane; an UNREGISTERED
    // slash command is always rejected with a direct channel notice and never
    // enters the Agent prompt.
    if (parsed) {
      const beforeSessionId = binding.sessionId;
      const controller = new AbortController();
      // rc.2 commands.execute takes base64 composer images; channel command
      // admission is text-only for now (command image parity is a later phase).
      const execution = await this.options.ctx.commands.execute(
        agentRef!.agent,
        text,
        [],
        controller.signal,
      );
      if (execution !== undefined) {
        await this.renderCommandResult(event, execution.result);
        // Generic post-command cleanup: whichever command switched the active
        // binding gets its previous session retired. No command-name
        // special-casing.
        const currentBinding = await this.options.bindingStore.get(key);
        if (currentBinding && currentBinding.sessionId !== beforeSessionId) {
          await this.options.agentManager.retireSession(beforeSessionId);
        }
        return;
      }
      // `execution === undefined` with syntax already parsed means the
      // registry missed the name (`ctx.commands.find(agent, parsed.name)`
      // returned nothing) — rc.2 official Host answers `unknown-command` and
      // never forwards the line to the model.
      this.options.logger.info('[channel-harness] rejected unknown command', {
        channel: event.channel,
        account: event.accountId,
        conversationType: event.conversation.type,
        command: parsed.name,
      });
      await this.sendCommandNotice(event, `未知命令：/${parsed.name}，输入 /help 查看命令。`);
      return;
    }

    // Check #2: a /stop may have arrived while this message was resolving
    // (spec §7) — do not re-wake a stopped agent.
    if (!this.isGenerationCurrent(key, generation)) return;

    // --- Ordinary message followup --------------------------------------------
    const runId = randomUUID();
    this.logInboundBinaryAvailability(event, binding.sessionId);
    const userMessage = await toHarnessUserMessage(event, {
      includeMetadataPrefix: this.options.config.includeMetadataPrefix,
      saveImage: this.options.saveImage,
      fileStore: this.fileStoreHook(event, binding.sessionId),
    });
    // Register the reply context keyed by the Harness UserMessage id strictly
    // BEFORE followup.
    this.options.replyContexts.register(userMessage.id, {
      sessionId: binding.sessionId,
      context: {
        conversationType: event.conversation.type,
        senderId: event.sender.id,
        replyToMessageId: event.message.id,
        // Platform reply handles such as DingTalk's per-message sessionWebhook
        // are transient and must travel only with the triggering turn.
        raw: event.raw,
        runId,
      },
    });
    agentRef!.followup(userMessage);
  }

  /**
   * /stop FAST PATH (spec §4–§10). Runs OUTSIDE the serial chain:
   * ① bump the generation FIRST (synchronous, before any await) so every
   *    queued/stale message on this conversation is invalidated;
   * ② cancel the live agent — preferably by executing the registered /stop
   *    command (lifecycle recorded, behavior owned by the handler), with a
   *    direct `agent.cancel({ kind: 'user' })` fallback;
   * ③ acknowledge immediately (never wait for `whenIdle`);
   * ④ enqueue a fire-and-forget STOP BARRIER that, after prior chain work
   *    converges, re-cancels the LATEST binding's agent (covers the /new race,
   *    spec §9).
   */
  private async handleImmediateStop(event: MessageReceived, key: string, text: string): Promise<void> {
    // ① Generation bump must happen before any await (spec §8).
    this.bumpGeneration(key);

    // ② Resolve + cancel.
    const binding = await this.options.bindingStore.get(key);
    if (binding) {
      const agent = this.options.agentManager.getLiveAgent(binding.sessionId);
      if (agent) {
        try {
          const controller = new AbortController();
          // rc.2 commands.execute takes base64 composer images; none accompany
          // an inbound IM stop command.
          const execution = await this.options.ctx.commands.execute(agent, text, [], controller.signal);
          if (execution !== undefined) {
            await this.renderCommandResult(event, execution.result);
          } else {
            agent.cancel({ kind: 'user' });
            await this.sendCommandNotice(event, '已停止当前任务。');
          }
        } catch {
          agent.cancel({ kind: 'user' });
          await this.sendCommandNotice(event, '已停止当前任务。');
        }
      } else {
        // Binding exists but no process-local live agent (cold/resumed
        // elsewhere): nothing to cancel here; the barrier re-checks below.
        await this.sendCommandNotice(event, '已停止当前任务。');
      }
    } else {
      // ③ No session: never create one for /stop (spec §39).
      await this.sendCommandNotice(event, '当前没有可停止的任务。');
    }

    // ④ Stop barrier: after existing chain work converges, re-read the LATEST
    // binding and cancel its agent (spec §9).
    void this.enqueueConversation(key, async () => {
      const latestBinding = await this.options.bindingStore.get(key);
      if (!latestBinding) return;
      this.options.agentManager.getLiveAgent(latestBinding.sessionId)?.cancel({ kind: 'user' });
    });
  }

  /** Generation helpers (spec §6). */
  private generationOf(key: string): number {
    return this.conversationGenerations.get(key) ?? 0;
  }

  private bumpGeneration(key: string): number {
    const next = this.generationOf(key) + 1;
    this.conversationGenerations.set(key, next);
    return next;
  }

  private isGenerationCurrent(key: string, generation: number): boolean {
    return this.generationOf(key) === generation;
  }

  /**
   * Build the converter's optional file/audio/video store hook. Absent
   * `fileProvider` -> no hook -> the converter keeps `[file: name]`
   * placeholders (unchanged fallback). The hook binds the current binding's
   * session + event identity so a stored asset is correctly session-ACL'd.
   */
  private fileStoreHook(event: MessageReceived, sessionId: string): FileStoreHook | undefined {
    if (!this.options.fileProvider) return undefined;
    const provider = this.options.fileProvider;
    return async (part: StoredBinaryPart) => {
      const fields = this.attachmentLogFields(event, sessionId, part);
      try {
        const descriptor = await provider.store(
          {
            sessionId,
            channelId: event.channel,
            accountId: event.accountId,
            conversationId: event.conversation.id,
            ...(event.conversation.type ? { conversationType: event.conversation.type } : {}),
            ...(event.conversation.threadId ? { threadId: event.conversation.threadId } : {}),
            messageId: event.message.id,
          },
          part,
        );
        if (!descriptor) {
          this.options.logger.warn('[channel-harness] inbound attachment was not stored', fields);
          return undefined;
        }
        this.options.logger.info('[channel-harness] inbound attachment stored', {
          ...fields,
          attachmentId: descriptor.attachmentId,
          bytes: descriptor.bytes,
          readable: descriptor.readable,
        });
        return descriptor;
      } catch (error) {
        this.options.logger.warn('[channel-harness] inbound attachment storage failed', {
          ...fields,
          error: toLoggableError(error),
        });
        return undefined;
      }
    };
  }

  /** Log the adapter-to-asset-store boundary once for every binary inbound part. */
  private logInboundBinaryAvailability(event: MessageReceived, sessionId: string): void {
    for (const part of event.message.content) {
      if (part.type !== 'file' && part.type !== 'audio' && part.type !== 'video') continue;
      if (part.localData?.byteLength) continue;
      this.options.logger.warn('[channel-harness] inbound attachment has no local bytes', {
        ...this.attachmentLogFields(event, sessionId, part),
        hasUrl: Boolean(part.url),
        reason: 'adapter did not provide downloaded bytes',
      });
    }
  }

  private attachmentLogFields(event: MessageReceived, sessionId: string, part: StoredBinaryPart): Record<string, unknown> {
    return {
      channel: event.channel,
      accountId: event.accountId,
      conversationId: event.conversation.id,
      sessionId,
      messageId: event.message.id,
      kind: part.type,
      name: part.type === 'file' ? part.name : undefined,
      mimeType: part.mimeType,
      localBytes: part.localData?.byteLength,
    };
  }

  /**
   * The `commandDeps.startNewSession` implementation. Resolves the
   * conversation from the CURRENT binding of the invoking agent (the session id
   * IS the agent id), then asks the Session factory to mint a NEW session id
   * (never a copy of the old one). The factory also attaches the new session to
   * the same channel Workspace and registers its binding. The OLD agent is NOT
   * disposed here; the bridge's post-command retire handles that. If the
   * factory throws, the old binding stays untouched.
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
        conversationType: oldBinding.conversationType,
        ...(oldBinding.senderId ? { senderId: oldBinding.senderId } : {}),
        ...(oldBinding.threadId ? { threadId: oldBinding.threadId } : {}),
      },
      route,
    );
  }

  /**
   * Deliver a command-plane notice directly through the channel adapter — never
   * through ReplyRouter and never as an assistant/model message.
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
      raw: event.raw,
      ...(event.conversation.threadId
        ? { threadId: event.conversation.threadId, replyToMessageId: event.message.id }
        : { replyToMessageId: event.message.id }),
    };
    return target;
  }
}
