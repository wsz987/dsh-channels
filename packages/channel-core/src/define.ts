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
import type { ChannelCapabilities } from './capabilities.js';
import type { ChannelHealth } from './health.js';
import type { OutboundMessage, SendResult } from './messages.js';
import type {
  AuthChallenge,
  AuthStatePoll,
  ChannelTarget,
  CreateReplyOptions,
  ReplyHandle,
} from './adapter.js';
import type { z } from 'zod';
import { defineChannelAdapterInputSchema } from './schema.js';

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
   * `getAdapterManifest` from `@wsz987/channel-compat`).
   */
  manifest?: unknown;
}

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
 *
 * The check runs `defineChannelAdapterInputSchema` and maps each zod issue
 * back to the stable legacy problem strings the tests and docs rely on.
 */
function assertAdapterShape(value: unknown): asserts value is ChannelAdapter {
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(
      'defineChannelAdapter: expected an adapter object with id, capabilities, start, stop and send',
    );
  }
  const parsed = defineChannelAdapterInputSchema.safeParse(value);
  if (parsed.success) return;
  const problems: string[] = [];
  for (const issue of parsed.error.issues) {
    const problem = problemForIssue(issue);
    if (problem !== undefined && !problems.includes(problem)) {
      problems.push(problem);
    }
  }
  if (problems.length === 0) {
    problems.push(parsed.error.issues[0]?.message ?? 'adapter does not satisfy the ChannelAdapter contract');
  }
  const id = typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : '<unknown>';
  throw new TypeError(
    `defineChannelAdapter: invalid adapter '${id}' — ${problems.join('; ')}`,
  );
}

/** Map one zod issue back to the legacy problem string for the field. */
function problemForIssue(issue: z.ZodIssue): string | undefined {
  const path = issue.path.map(String).join('.');
  if (path === 'capabilities.streaming') {
    return "capabilities.streaming must be one of 'native' | 'edit' | 'buffered'";
  }
  if (issue.code === 'invalid_type') {
    if (path === 'id') return 'id must be a non-empty string';
    if (path === 'capabilities') return 'capabilities must be a ChannelCapabilities object';
    if (path.startsWith('capabilities.')) {
      return `capabilities.${path.slice('capabilities.'.length)} must be a boolean`;
    }
    if (path === 'start' || path === 'stop' || path === 'send') return `${path} must be a function`;
    if (path === 'createReply' || path === 'beginAuth' || path === 'pollAuth' || path === 'getHealth') {
      return `${path} must be a function when present`;
    }
  }
  if (issue.code === 'too_small' && path === 'id') return 'id must be a non-empty string';
  return undefined;
}
