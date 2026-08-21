/**
 * Schemastery configuration for the channel-harness bridge.
 *
 * All deployment-related parameters are configurable here; defaults match the
 * v2 behavior (global default route, file-backed binding store with restart
 * recovery, throttled reply previews, bounded gateway concurrency).
 *
 * v2 routing (doc §30): the old `defaultAgentId` and top-level
 * `agentOptions` are gone. Agent selection resolves to an `AgentRouteSpec`
 * (preset / provider / model / maxTokens), with `agent.default` as the global
 * fallback and optional per-channel / per-account / per-conversation overrides.
 */
import Schema from '@deepseek-ai/schemastery';
import type { AgentRouteSpec } from './agent-router.js';

/** Route for the global default agent. */
export interface AgentConfig {
  /** Fallback route used when no routing override matches. */
  default: AgentRouteSpec;
}

/** How the default agent route is selected for a conversation. */
export interface RoutingConfig {
  /**
   * The default-resolution granularity. `global` uses only
   * `agent.default`; the finer modes additionally allow per-channel,
   * per-account and per-conversation overrides via `routing.overrides`.
   */
  mode: 'global' | 'channel' | 'account' | 'conversation';
  /**
   * Per-level agent route overrides. Resolution priority when an override
   * hits: conversation > account > channel > `agent.default`.
   */
  overrides?: {
    channel?: Record<string, AgentRouteSpec>;
    account?: Record<string, AgentRouteSpec>;
    conversation?: Record<string, AgentRouteSpec>;
  };
}

/** Reply throttling / splitting behavior. */
export interface ReplyConfig {
  /**
   * Minimum interval (ms) between reply preview updates for `native` / `edit`
   * strategies. `0` disables throttling (every delta flushes immediately),
   * which also makes the pipeline easy to test deterministically.
   */
  updateIntervalMs: number;
  /** Optional hard cap for a single outbound message; longer text is split. */
  maxTextLength?: number;
  /** Split long messages on paragraph boundaries first. */
  splitParagraphs: boolean;
  /** Keep fenced code blocks intact while splitting long messages. */
  splitCodeBlocks: boolean;
  /** Whether `turn/end` must deliver trailing partial content. */
  finalFlush: boolean;
}

/** Where session bindings are persisted. */
export interface BindingStoreConfig {
  type: 'memory' | 'file';
  /** Path of the JSON file when `type` is `file`. */
  path?: string;
}

/**
 * Channel Workspace strategy (plan §5.1). Controls how a channel conversation
 * is mapped to a Session working directory and a Harness `WorkspaceRegistry`
 * member.
 */
export interface WorkspaceConfig {
  /**
   * `channel-account` (default): one Workspace per channel/account pair, under
   * `<dsh-home>/workspaces/channels/<channel>/<account-key>`.
   * `host-cwd`: keep the Host's real working directory (`process.cwd()`) and
   * attach only when that cwd is already registered.
   * `disabled`: no WorkspaceRegistry integration (cwd falls back to
   * `config.cwd ?? process.cwd()`).
   */
  mode: 'channel-account' | 'host-cwd' | 'disabled';
  /** Channel Workspace root; unset defaults to `<dsh-home>/workspaces/channels`. */
  root?: string;
  /** Whether a missing channel Workspace is auto-created. */
  autoCreate: boolean;
}

export type ImageCompatibilityMode = 'degrade' | 'reject';

/**
 * Channel image-compatibility policy (ADR 0002) — an explicit CHANNEL policy,
 * NOT an attempt at Web host parity.
 *
 * Official Harness Web refuses to switch a session to a model that cannot
 * accept images once the session already contains an image
 * (`session.selectModel` -> model-unavailable). Channels keep serving the same
 * conversation without forcing the user to `/new`, so the default here is a
 * deliberately bounded divergence from that Web semantics.
 */
export interface ImageCompatibilityConfig {
  /**
   * `degrade` (default): a text-only model keeps serving the Session — every
   * image block is replaced by `[图片：当前模型不支持查看]` at the
   * `agent/pre-step` boundary, so the placeholder is the durable user message
   * and the exact content reconstructed for the model request.
   * `reject`: the request is refused with an error instead (closest to the
   * official Web behavior) — the user must start a new Session (`/new`) or
   * switch to an image-capable model.
   */
  mode: ImageCompatibilityMode;
}

/** Channel-backed handling for Harness `ask_user_question` requests. */
export interface UserQuestionsConfig {
  enabled: boolean;
  /** Maximum time to wait for a channel answer before cancelling the question. */
  timeoutMs: number;
}

export interface Config {
  /** Default route (and explicit per-level override dictionary). */
  agent: AgentConfig;
  /**
   * Working directory for NEW channel sessions. This becomes the session's
   * `header.cwd`, which `dsh-workspace` uses to group the session under a
   * workspace — so set it to the directory of the workspace you want channel
   * sessions to appear in. Defaults to `process.cwd()` at runtime.
   */
  cwd?: string;
  routing: RoutingConfig;
  bindingStore: BindingStoreConfig;
  /** Channel Workspace policy; defaults to { mode: 'channel-account', autoCreate: true }. */
  workspace: WorkspaceConfig;
  /**
   * Channel image-compatibility policy (ADR 0002): how a text-only model
   * handles channel-bound Sessions whose history contains images. Defaults to
   * `{ mode: 'degrade' }`.
   */
  imageCompatibility: ImageCompatibilityConfig;
  /** Present channel-origin user questions through native interactive actions. */
  userQuestions: UserQuestionsConfig;
  reply: ReplyConfig;
  /**
   * Upper bound on concurrently live agents the bridge owns (per-session
   * single-flight always holds regardless of this value).
   */
  maxConcurrency: number;
  /**
   * Upper bound (ms) the bridge waits for in-flight agent turns to go idle
   * during unload before giving up and finalizing replies from the durable
   * log. Deployment-tunable (was previously a hardcoded 5000).
   */
  drainTimeoutMs: number;
  /** Prefix inbound user messages with `[channel=.. sender=.. message=..]` when explicitly enabled. */
  includeMetadataPrefix: boolean;
}

const routeSchema = Schema.object({
  preset: Schema.string(),
  provider: Schema.string(),
  model: Schema.string(),
  maxTokens: Schema.natural(),
});

export const Config: Schema<Config> = Schema.object({
  agent: Schema.object({
    default: routeSchema,
  }),
  cwd: Schema.string().description('Working directory for new channel sessions (default: process.cwd())'),
  routing: Schema.object({
    mode: Schema.union(['global', 'channel', 'account', 'conversation']).default('global'),
    overrides: Schema.object({
      channel: Schema.dict(routeSchema),
      account: Schema.dict(routeSchema),
      conversation: Schema.dict(routeSchema),
    }),
  }),
  bindingStore: Schema.object({
    // File-backed by default so session bindings survive restarts; the file
    // path is resolved at runtime (`<channel-data-dir>/bindings.json`) so
    // bindings no longer depend on the process cwd (plan §5.2).
    type: Schema.union(['memory', 'file']).default('file'),
    path: Schema.string(),
  }),
  workspace: Schema.object({
    mode: Schema.union(['channel-account', 'host-cwd', 'disabled']).default('channel-account'),
    root: Schema.string(),
    autoCreate: Schema.boolean().default(true),
  }),
  imageCompatibility: Schema.object({
    mode: Schema.union(['degrade', 'reject']).default('degrade'),
  }).default({ mode: 'degrade' }),
  userQuestions: Schema.object({
    enabled: Schema.boolean().default(true),
    timeoutMs: Schema.natural().default(300000),
  }).default({ enabled: true, timeoutMs: 300000 }),
  reply: Schema.object({
    updateIntervalMs: Schema.natural().default(200),
    maxTextLength: Schema.natural(),
    splitParagraphs: Schema.boolean().default(true),
    splitCodeBlocks: Schema.boolean().default(true),
    finalFlush: Schema.boolean().default(true),
  }),
  maxConcurrency: Schema.natural().default(4),
  drainTimeoutMs: Schema.natural().default(5000),
  includeMetadataPrefix: Schema.boolean().default(false),
});
