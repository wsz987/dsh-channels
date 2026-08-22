/**
 * The `/version` command — bundle version + Harness tested baseline + a
 * prompt-only npm update hint.
 *
 * Pure Human Plane — never calls the model. The update hint comes from the
 * channel-control update check, reached through the `versionInfo` dep (bridged
 * lazily from the plugin ctx via `ctx.get('channelControl')`, never through
 * `invocation.agent.ctx`). When the control plane is absent, disabled or the
 * registry check has not produced a result yet, the command degrades to the
 * plain version lines — an unreachable check must never surface an error.
 */
import { type CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { ChannelCommandDependencies, ChannelVersionInfo } from './index.js';
import pkg from '../../package.json' with { type: 'json' };

/**
 * The DeepSeek Harness version this bundle is tested against (peer pins).
 *
 * Single source of truth: `HARNESS_TESTED_VERSION` in
 * `scripts/check-upstream.mjs`, mirrored by every workspace `@deepseek-ai/dsh-*`
 * pin. Keep this constant in sync when the baseline is raised
 * (AGENTS.md red line 6); test/commands-version.test.ts guards the drift
 * against this package's own `@deepseek-ai/dsh-commands` pin.
 */
export const HARNESS_TESTED_VERSION = '0.1.1-rc.2';

function renderUpdate(info: NonNullable<ChannelVersionInfo['update']>): string[] {
  const lines = [
    '',
    'Update available: ' + info.version + ' (' + info.tag + ')' + (info.crossLine ? ' — cross-version-line upgrade' : ''),
  ];
  for (const command of info.commands) lines.push(command);
  return lines;
}

export function createVersionCommand(deps: ChannelCommandDependencies): CommandDefinition {
  return {
    name: 'version',
    description: 'Show the bundle version, Harness baseline and update hint',
    async handler() {
      let info: ChannelVersionInfo | undefined;
      try {
        info = await deps.versionInfo?.();
      } catch {
        info = undefined; // control plane hiccup → degrade to version-only
      }
      const currentVersion = info?.currentVersion ?? pkg.version;
      const lines = [
        'Version',
        'Bundle: ' + currentVersion,
        'Harness tested baseline: ' + HARNESS_TESTED_VERSION,
      ];
      if (info?.update) lines.push(...renderUpdate(info.update));
      return { kind: 'success', text: lines.join('\n') };
    },
  };
}
