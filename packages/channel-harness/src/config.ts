/**
 * Schemastery configuration for the channel-harness bridge.
 *
 * All deployment-related parameters are configurable here; defaults match the
 * v1 behavior (global default agent, memory binding store, throttled reply
 * previews, per-session single-flight concurrency).
 */
import Schema from '@deepseek-ai/schemastery';

/** How the default agent is selected for a conversation. */
export interface RoutingConfig {
  /**
   * The default-resolution granularity. `global` uses only
   * `defaultAgentId`; the finer modes additionally allow per-channel,
   * per-account and per-conversation overrides via `routing.overrides`.
   */
  mode: 'global' | 'channel' | 'account' | 'conversation';
  /**
   * Per-level agent overrides. Resolution priority when an override hits:
   * conversation > account > channel > `defaultAgentId`. A binding that
   * already carries an `agentId` always wins over routing.
   */
  overrides?: {
    channel?: Record<string, string>;
    account?: Record<string, string>;
    conversation?: Record<string, string>;
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
  /** Agent used when routing resolves nothing more specific. */
  defaultAgentId: string;
  routing: RoutingConfig;
  bindingStore: BindingStoreConfig;
  reply: ReplyConfig;
  /**
   * Upper bound on concurrently live agents the bridge owns (per-session
   * single-flight always holds regardless of this value).
   */
  maxConcurrency: number;
  /** Prefix inbound user messages with `[channel=.. sender=.. message=..]`. */
  includeMetadataPrefix: boolean;
  /** Optional provider/model passed to `ctx.agents.create` / `resume`. */
  agentOptions?: {
    provider?: string;
    model?: string;
  };
}

export const Config: Schema<Config> = Schema.object({
  defaultAgentId: Schema.string().default('default'),
  routing: Schema.object({
    mode: Schema.union(['global', 'channel', 'account', 'conversation']).default('global'),
    overrides: Schema.object({
      channel: Schema.dict(Schema.string()),
      account: Schema.dict(Schema.string()),
      conversation: Schema.dict(Schema.string()),
    }),
  }),
  bindingStore: Schema.object({
    type: Schema.union(['memory', 'file']).default('memory'),
    path: Schema.string(),
  }),
  reply: Schema.object({
    updateIntervalMs: Schema.natural().default(200),
    maxTextLength: Schema.natural(),
    splitParagraphs: Schema.boolean().default(true),
    splitCodeBlocks: Schema.boolean().default(true),
    finalFlush: Schema.boolean().default(true),
  }),
  maxConcurrency: Schema.natural().default(4),
  includeMetadataPrefix: Schema.boolean().default(true),
  agentOptions: Schema.object({
    provider: Schema.string(),
    model: Schema.string(),
  }),
});
