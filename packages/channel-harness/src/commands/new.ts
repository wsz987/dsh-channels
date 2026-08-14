/**
 * The `/new` command (plan §12 / §13).
 *
 * Starts a brand-new Harness session for the current channel conversation by
 * delegating to `deps.startNewSession` (supplied by the bridge). The old
 * session is NOT disposed by this handler: creating B and re-pointing the
 * binding at B happens here, but retiring the previous agent for A is left to
 * the bridge's post-command cleanup (plan §14) after the official
 * `command/done` settles.
 */
import { type CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { ChannelCommandDependencies } from './index.js';

export function createNewCommand(deps: ChannelCommandDependencies): CommandDefinition {
  return {
    name: 'new',
    description: 'Start a new channel session',
    async handler(invocation) {
      if (invocation.rawInput.trim().length > 0) {
        return {
          kind: 'error',
          text: '用法：/new',
        };
      }

      if (invocation.agent.status !== 'idle') {
        return {
          kind: 'error',
          text: '当前会话仍在运行，请稍后再执行 /new。',
        };
      }

      await deps.startNewSession(invocation.agent);

      return {
        kind: 'success',
        text: '已开启新会话。',
      };
    },
  };
}
