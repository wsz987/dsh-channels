/**
 * Channel Workspace resolver (plan §6 / §9 / M1).
 *
 * Maps a channel conversation identity to the Session working directory and
 * (optionally) a Harness `WorkspaceRegistry` member. The default
 * `channel-account` mode gives every channel/account pair its own workspace
 * under `<dsh-home>/workspaces/channels/<channel>/<account-key>` and attaches
 * it to the registry; `host-cwd` keeps the old Host-cwd semantics; `disabled`
 * returns nothing.
 *
 * This module deliberately uses *structural* types for the official
 * `@deepseek-ai/dsh-workspace` entities and service (`WorkspaceRegistryLike`,
 * `ChannelWorkspaceLike`) instead of importing the package — the harness
 * exposes the service on `ctx` at runtime, and the official package is not a
 * dependency of this repo (see {@link WorkspaceRegistryLike}).
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { ChannelLogger } from '@wsz987/channel-core';
import type { WorkspaceConfig } from './config.js';
import { channelWorkspaceTitle, safeSegment, stableSafeAccountKey } from './channel-label.js';
import { resolveDshHome } from './dsh-home.js';

/** Channel conversation identity used to resolve a workspace. */
export interface ChannelWorkspaceInput {
  channelId: string;
  accountId: string;
  conversationId: string;
  threadId?: string;
}

/**
 * Structural view of the official dsh-workspace Workspace entity (plan §6/§10).
 * Kept local so this module does not depend on `@deepseek-ai/dsh-workspace`.
 */
export interface ChannelWorkspaceLike {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  attachSession(sessionId: SessionId): Promise<void>;
  detachSession(sessionId: SessionId): Promise<void>;
}

/**
 * Structural view of `ctx.workspaceRegistry` (official
 * `@deepseek-ai/dsh-workspace`). The harness exposes it on `ctx` at runtime;
 * this interface is only the shape this module relies on.
 */
export interface WorkspaceRegistryLike {
  resolveByPath(path: string): Promise<ChannelWorkspaceLike | undefined>;
  create(path: string, title?: string): Promise<ChannelWorkspaceLike>;
}

/** Result of a workspace resolve: the cwd plus the (optional) workspace. */
export interface ResolvedChannelWorkspace {
  cwd?: string;
  workspace?: ChannelWorkspaceLike;
}

/** Resolves a channel conversation to a Session cwd and workspace. */
export interface ChannelWorkspaceResolver {
  resolve(input: ChannelWorkspaceInput): Promise<ResolvedChannelWorkspace>;
}

/**
 * Resolves the channel workspace root. Defaults to
 * `<dsh-home>/workspaces/channels` when `config.root` is not set.
 */
export function resolveChannelWorkspaceRoot(config: WorkspaceConfig | undefined): string {
  return config?.root ?? join(resolveDshHome(), 'workspaces', 'channels');
}

/**
 * Default effective workspace config used when the schema default did not
 * apply (i.e. `config.workspace` validated as `undefined`): the plan's
 * recommended default — `channel-account` with auto-create enabled.
 */
const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = { mode: 'channel-account', autoCreate: true };

/**
 * Harness-backed resolve implementation grouping by channel + account.
 *
 * `config` may be `undefined` when the schema default did not apply; it is
 * treated as {@link DEFAULT_WORKSPACE_CONFIG}.
 */
export class HarnessChannelWorkspaceResolver implements ChannelWorkspaceResolver {
  constructor(
    private readonly ctx: Context,
    private readonly config: WorkspaceConfig | undefined,
    private readonly logger: ChannelLogger,
  ) {}

  /** Structural access to the official `workspaceRegistry` on `ctx`. */
  private registry(): WorkspaceRegistryLike | undefined {
    return this.ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined;
  }

  private effectiveConfig(): WorkspaceConfig {
    return this.config ?? DEFAULT_WORKSPACE_CONFIG;
  }

  async resolve(input: ChannelWorkspaceInput): Promise<ResolvedChannelWorkspace> {
    const config = this.effectiveConfig();

    if (config.mode === 'disabled') {
      return {};
    }

    if (config.mode === 'host-cwd') {
      const cwd = process.cwd();
      const workspace = await this.registry()?.resolveByPath(cwd).catch(() => undefined);
      if (workspace) {
        this.logger.debug('[channel-harness] workspace resolved', {
          cwd,
          workspaceId: workspace.id,
          title: workspace.title,
        });
      }
      return workspace ? { cwd, workspace } : { cwd };
    }

    const root = resolveChannelWorkspaceRoot(config);
    const accountKey = stableSafeAccountKey(input.accountId);
    const cwd = join(root, safeSegment(input.channelId), accountKey);

    // The official create() requires an existing directory (it realpaths), so
    // make sure the directory exists before resolving/creating the workspace.
    await mkdir(cwd, { recursive: true });

    const title = channelWorkspaceTitle({ channelId: input.channelId, accountId: input.accountId });

    let workspace = await this.registry()?.resolveByPath(cwd).catch(() => undefined);

    const registry = this.registry();
    if (!workspace && registry && config.autoCreate) {
      workspace = await registry.create(cwd, title);
    }

    this.logger.debug('[channel-harness] workspace resolved', {
      cwd,
      workspaceId: workspace?.id,
      title,
    });

    return { cwd, workspace };
  }
}
