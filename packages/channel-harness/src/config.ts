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
import { DEFAULT_BINDING_STORE_PATH } from './binding-store.js';

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

export interface Config {
  /** Default route (and explicit per-level override dictionary). */
  agent: AgentConfig;
  routing: RoutingConfig;
  bindingStore: BindingStoreConfig;
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
  /** Prefix inbound user messages with `[channel=.. sender=.. message=..]`. */
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
    // (relative to cwd) is created on demand.
    type: Schema.union(['memory', 'file']).default('file'),
    path: Schema.string().default(DEFAULT_BINDING_STORE_PATH),
  }),
  reply: Schema.object({
    updateIntervalMs: Schema.natural().default(200),
    maxTextLength: Schema.natural(),
    splitParagraphs: Schema.boolean().default(true),
    splitCodeBlocks: Schema.boolean().default(true),
    finalFlush: Schema.boolean().default(true),
  }),
  maxConcurrency: Schema.natural().default(4),
  drainTimeoutMs: Schema.natural().default(5000),
  includeMetadataPrefix: Schema.boolean().default(true),
});
