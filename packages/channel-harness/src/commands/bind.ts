/**
 * The `/bind` command (issue #6): rebind/attach an existing session to the
 * current conversation.
 *
 * Two-step, fail-closed:
 *
 *   /bind <id>          resolve the target (exact id, or a UNIQUE prefix) and
 *                       surface what will happen — never mutates anything.
 *   /bind <id> confirm  re-resolve (guarding against races), then re-point the
 *                       current conversation's durable binding at the target.
 *
 * Guard rails: a unique-prefix match is required (ambiguous prefixes list the
 * candidates and refuse), a target already bound to a DIFFERENT conversation
 * is refused (one conversation ↔ one session), and a persisted Agent preset
 * that conflicts with the conversation's route is refused — mirroring the
 * official resume semantics instead of producing a binding that cannot resume.
 */
import { type CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { ChannelBindResolution, ChannelCommandDependencies } from './index.js';

/** Minimum prefix length before a non-exact query is even considered. */
const MIN_PREFIX_LENGTH = 4;

function usage(): { kind: 'error'; text: string } {
  return {
    kind: 'error',
    text: '用法：/bind <会话ID> [confirm] —— 先解析目标，确认后加 confirm 执行重绑。',
  };
}

function describeResolution(resolution: ChannelBindResolution, query: string): string {
  switch (resolution.kind) {
    case 'missing':
      return `未找到匹配的会话：${query}。请从 Web UI 复制完整会话 ID。`;
    case 'ambiguous':
      return [
        `会话 ID 前缀不唯一（${resolution.candidates?.length ?? 0} 个匹配），已拒绝执行：`,
        ...(resolution.candidates ?? []).map((id) => `- ${id}`),
        '请使用完整 ID。',
      ].join('\n');
    case 'resolved':
      break;
  }
  if (resolution.boundElsewhere) {
    return `会话 ${resolution.sessionId} 已绑定到其他对话，拒绝重绑（一个对话只对应一个会话）。`;
  }
  if (resolution.conflict) {
    return [
      `会话 ${resolution.sessionId} 的 Agent 预设（${resolution.preset}）与本对话的路由预设冲突，`,
      '重绑后将无法恢复，已拒绝执行。',
    ].join(' ');
  }
  return [
    `将把本对话绑定到会话 ${resolution.sessionId}：`,
    resolution.preset ? `- Agent 预设：${resolution.preset}` : '- Agent 预设：无（沿用默认）',
    '- 这会替换当前对话的既有会话关联。',
    `确认无误请执行：/bind ${resolution.sessionId} confirm`,
  ].join('\n');
}

export function createBindCommand(deps: ChannelCommandDependencies): CommandDefinition {
  return {
    name: 'bind',
    description: 'Rebind this conversation to an existing session',
    async handler(invocation) {
      if (!deps.bind) {
        return { kind: 'error', text: '当前部署不支持会话重绑。' };
      }
      const parts = invocation.rawInput.trim().split(/\s+/).filter((part) => part.length > 0);
      if (parts.length === 0 || parts.length > 2) return usage();
      const [query, confirmFlag] = parts;
      if (confirmFlag !== undefined && confirmFlag !== 'confirm') return usage();

      const resolution = await deps.bind.resolve(invocation.agent, query!);

      if (confirmFlag === undefined) {
        if (resolution.kind === 'resolved' && resolution.sessionId === String(invocation.agent.id)) {
          return { kind: 'error', text: '本对话已绑定该会话。' };
        }
        return { kind: 'success', text: describeResolution(resolution, query!) };
      }

      if (resolution.kind !== 'resolved') {
        return { kind: 'error', text: describeResolution(resolution, query!) };
      }
      if (resolution.boundElsewhere || resolution.conflict) {
        return { kind: 'error', text: describeResolution(resolution, query!) };
      }
      await deps.bind.confirm(invocation.agent, resolution.sessionId!);
      return {
        kind: 'success',
        text: `已重绑：本对话现在使用会话 ${resolution.sessionId}。下一条消息将在该会话中继续。`,
      };
    },
  };
}
