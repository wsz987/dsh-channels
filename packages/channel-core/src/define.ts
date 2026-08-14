/**
 * Third-party adapter authoring helper (execution plan Task 17.1,
 * architecture §33).
 *
 * `defineChannelAdapter` is the entry point for authors who build an adapter
 * outside the monorepo. It is an identity function at runtime: the object you
 * pass in is returned unchanged, so the concrete type (including any extra
 * fields such as `manifest`) survives and stays compatible with
 * `runChannelAdapterContract`, `ChannelService.register` and
 * `getAdapterManifest`.
 *
 * Outside production it also runs a structural dev-time validation and throws
 * a descriptive `TypeError` (listing every missing/incorrect required field)
 * when the object does not satisfy the `ChannelAdapter` contract. The
 * production path is a pure identity so the check costs nothing there.
 */
import type { ChannelAdapter } from './adapter.js';
import type { ChannelAdapterContext } from './context.js';
import type { ChannelCapabilities, StreamingMode } from './capabilities.js';
import type { ChannelHealth } from './health.js';
import type { OutboundMessage, SendResult } from './messages.js';
import type {
  AuthChallenge,
  AuthStatePoll,
  ChannelTarget,
  CreateReplyOptions,
  ReplyHandle,
} from './adapter.js';

/**
 * Structural input accepted by `defineChannelAdapter`.
 *
 * Identical to the `ChannelAdapter` contract plus an optional `manifest`
 * field for the upstream compatibility manifest read by `channel-compat`.
 * Marking the optional members with `?` mirrors the interface exactly, so
 * authors get the same type-level guidance they would from implementing
 * `ChannelAdapter` directly.
 */
export interface DefineChannelAdapterInput {
  /** Stable channel id, e.g. `'telegram'`. */
  id: string;

  /** Capability negotiation surface (see `ChannelCapabilities`). */
  capabilities: ChannelCapabilities;

  /** Start the adapter inside its owning Cordis scope. */
  start(ctx: ChannelAdapterContext): Promise<void>;

  /** Stop the adapter; must be idempotent. */
  stop(): Promise<void>;

  /** Send one outbound message to a target conversation. */
  send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult>;

  /** Optional streaming reply handle (native/edit streaming modes). */
  createReply?(target: ChannelTarget, options?: CreateReplyOptions): Promise<ReplyHandle>;

  /** Optional interactive auth challenge (QR/login flows). */
  beginAuth?(): Promise<AuthChallenge>;

  /** Optional auth state polling. */
  pollAuth?(challenge: AuthChallenge): Promise<AuthStatePoll>;

  /** Optional health reporting. */
  getHealth?(): Promise<ChannelHealth>;

  /**
   * Optional upstream compatibility manifest (read structurally by
   * `getAdapterManifest` from `@dsh/channel-compat`).
   */
  manifest?: unknown;
}

/** Capability flags that must be plain booleans. */
const CAPABILITY_FLAGS = [
  'text',
  'image',
  'file',
  'audio',
  'video',
  'markdown',
  'cards',
  'reactions',
  'threads',
] as const;

const STREAMING_MODES: readonly StreamingMode[] = ['native', 'edit', 'buffered'];

/** Required function members of the adapter contract. */
const REQUIRED_METHODS = ['start', 'stop', 'send'] as const;

/** Optional function members of the adapter contract. */
const OPTIONAL_METHODS = ['createReply', 'beginAuth', 'pollAuth', 'getHealth'] as const;

/**
 * Register an adapter built with the authoring helper.
 *
 * The returned value keeps the caller's concrete type (`A`), so a
 * `defineChannelAdapter`-based adapter can carry a `manifest` field and
 * still satisfy `ChannelAdapter`-typed call sites.
 */
export function defineChannelAdapter<A extends ChannelAdapter>(adapter: A): A {
  if (process.env.NODE_ENV !== 'production') {
    assertAdapterShape(adapter);
  }
  return adapter;
}

/**
 * Dev-time structural validation. Collects every problem it can find and
 * throws one `TypeError` listing all of them, so a broken adapter is fixed
 * in one pass instead of one error per run.
 */
function assertAdapterShape(value: unknown): asserts value is ChannelAdapter {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(
      'defineChannelAdapter: expected an adapter object with id, capabilities, start, stop and send',
    );
  }
  const adapter = value as Record<string, unknown>;
  const problems: string[] = [];

  if (typeof adapter.id !== 'string' || adapter.id.length === 0) {
    problems.push('id must be a non-empty string');
  }

  const caps = adapter.capabilities;
  if (typeof caps !== 'object' || caps === null) {
    problems.push('capabilities must be a ChannelCapabilities object');
  } else {
    const record = caps as Record<string, unknown>;
    for (const flag of CAPABILITY_FLAGS) {
      if (typeof record[flag] !== 'boolean') {
        problems.push(`capabilities.${flag} must be a boolean`);
      }
    }
    if (!STREAMING_MODES.includes(record.streaming as StreamingMode)) {
      problems.push("capabilities.streaming must be one of 'native' | 'edit' | 'buffered'");
    }
  }

  for (const method of REQUIRED_METHODS) {
    if (typeof adapter[method] !== 'function') {
      problems.push(`${method} must be a function`);
    }
  }

  for (const method of OPTIONAL_METHODS) {
    if (adapter[method] !== undefined && typeof adapter[method] !== 'function') {
      problems.push(`${method} must be a function when present`);
    }
  }

  if (problems.length > 0) {
    const id = typeof adapter.id === 'string' ? adapter.id : '<unknown>';
    throw new TypeError(
      `defineChannelAdapter: invalid adapter '${id}' — ${problems.join('; ')}`,
    );
  }
}
