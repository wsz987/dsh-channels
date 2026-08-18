/**
 * The `/help` command (spec §13).
 *
 * Discovery is read LIVE from the official registry — never from a static
 * list: `deps.listCommands(agent)` returns the effective view after global +
 * agent-scope shadowing, so Harness plugins that register new commands
 * (e.g. /compact, /goal, /plan) appear on the channel side without a channel
 * upgrade. `/help <name>` resolves one command via `deps.findCommand`.
 * The registry is reached through deps (bridged from the plugin ctx) — never
 * through `invocation.agent.ctx`, which the agent-loop scope does not inject.
 */
import { type CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { ChannelCommandDependencies } from './index.js';

export function createHelpCommand(deps: ChannelCommandDependencies): CommandDefinition {
  return {
    name: 'help',
    description: 'List available commands or show usage for one command',
    input: { hint: '[command]' },
    handler(invocation) {
      const name = invocation.rawInput.trim();
      if (name.length > 0) {
        const def = deps.findCommand(invocation.agent, name);
        if (!def) {
          return { kind: 'error', text: '未知指令：/' + name };
        }
        const lines = ['/' + def.name];
        if (def.description) lines.push('', def.description);
        if (def.input?.hint) lines.push('', 'Usage:', '/' + def.name + ' ' + def.input.hint);
        return { kind: 'success', text: lines.join('\n') };
      }
      const defs = deps.listCommands(invocation.agent);
      if (defs.length === 0) {
        return { kind: 'success', text: '当前没有可用指令。' };
      }
      const lines = ['可用指令：', ''];
      for (const def of defs) {
        lines.push('/' + def.name + (def.description ? ' — ' + def.description : ''));
      }
      return { kind: 'success', text: lines.join('\n') };
    },
  };
}