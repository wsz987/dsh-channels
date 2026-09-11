/**
 * The `/mirror` command (issue #5).
 *
 * Opt-in per-conversation toggle: when ON, turns initiated OUTSIDE the channel
 * (web/CLI) on this bound session deliver their final assistant text to the
 * bound conversation as buffered replies. Default OFF — a non-channel turn
 * never auto-routes without explicit owner consent. The state lives on the
 * durable binding (`SessionBinding.mirror`), so it survives restarts and is
 * consulted by the ReplyRouter at delivery time.
 */
import { type CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { ChannelCommandDependencies } from './index.js';

export function createMirrorCommand(deps: ChannelCommandDependencies): CommandDefinition {
  return {
    name: 'mirror',
    description: 'Mirror web-initiated replies to this conversation (opt-in)',
    async handler(invocation) {
      if (!deps.mirror) {
        return { kind: 'error', text: '当前部署不支持镜像模式。' };
      }
      const arg = invocation.rawInput.trim().toLowerCase();

      if (arg === '') {
        const on = await deps.mirror.get(invocation.agent);
        return {
          kind: 'success',
          text: on
            ? '镜像模式：已开启。Web 端发起的回复会同步发送到本会话。'
            : '镜像模式：已关闭。Web 端发起的回复不会发送到本会话（用法：/mirror on|off）。',
        };
      }
      if (arg !== 'on' && arg !== 'off') {
        return { kind: 'error', text: '用法：/mirror on|off（不带参数查看当前状态）。' };
      }

      const on = arg === 'on';
      await deps.mirror.set(invocation.agent, on);
      return {
        kind: 'success',
        text: on
          ? '镜像模式已开启：Web 端发起的回复将同步发送到本会话。'
          : '镜像模式已关闭：Web 端发起的回复不再发送到本会话。',
      };
    },
  };
}
