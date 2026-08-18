/**
 * The `/model` command (spec §18–§29).
 *
 * Harness owns model routing. The command validates the requested model and
 * delegates the current-Session switch to the official Host RPC or the
 * headless Agent model-selection hook. The same operation updates the shared
 * default so future Sessions use the selected model as well.
 *
 * Validation: provider must come from `ctx.llm.listProviders()` (spec §28);
 * the exact model is resolved ONCE via `ctx.llm.resolveModelInfo` — catalog
 * membership is ADVISORY and never rejects a model id (spec §17/§29). An
 * optional reasoning effort is then validated against that exact model's own
 * `reasoning.efforts` metadata (the same predicate the official
 * `resolveCallConfig` applies), so unsupported efforts reject without
 * provider I/O and without a second metadata resolution.
 */
import { type CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { ChannelCommandDependencies } from './index.js';

export function createModelCommand(deps: ChannelCommandDependencies): CommandDefinition {
  return {
    name: 'model',
    description: 'Show or switch the current model',
    input: { hint: '[<provider> <model> [<reasoningEffort>]]' },
    async handler(invocation) {
      const llm = deps.llm;

      const args = invocation.rawInput
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0);

      if (args.length === 0) {
        const selection = await deps.modelSelection.current(invocation.agent);
        if (!selection) {
          return { kind: 'success', text: ['当前模型', '', '（未解析到模型选择）'].join('\n') };
        }
        return { kind: 'success', text: formatSelection('当前模型', selection) };
      }
      if (args.length > 3) {
        return { kind: 'error', text: '用法：/model [<provider> <model> [<reasoningEffort>]]' };
      }
      const [providerId, modelId, effort] = args as [string, string, string | undefined];
      if (!modelId) {
        return { kind: 'error', text: '用法：/model [<provider> <model> [<reasoningEffort>]]' };
      }

      // 1. Provider must be a registered route (spec §28).
      const providers = llm.listProviders();
      if (!providers.some((p) => p.id === providerId)) {
        return {
          kind: 'error',
          text: '未找到 Provider: ' + providerId + (providers.length > 0 ? '\n\n可用：\n' + providers.map((p) => p.id).join('\n') : ''),
        };
      }

      // 2. Exact model metadata resolution (catalog membership is advisory).
      let resolved: LlmResolvedModelInfo | undefined;
      try {
        resolved = await llm.resolveModelInfo(providerId, modelId, invocation.signal);
      } catch (error) {
        return { kind: 'error', text: '模型解析失败：' + errorMessage(error) };
      }

      // 3. Reasoning-effort validation against the exact model's metadata
      //    (spec §29). `resolved.reasoning.efforts` is the adapter-owned truth
      //    for this exact route; the same predicate the official
      //    `resolveCallConfig` applies — reject an explicit unsupported effort
      //    here, without a second metadata resolution or provider I/O.
      let reasoningEffort: ReturnType<typeof ReasoningEffortId> | undefined;
      if (effort) {
        const supported = resolved?.reasoning?.efforts ?? [];
        if (!supported.some((e) => String(e.id) === effort)) {
          return {
            kind: 'error',
            text: 'Reasoning effort 不被支持: ' + effort + (supported.length > 0 ? '\n\n支持：' + supported.map((e) => String(e.id)).join(', ') : ''),
          };
        }
        reasoningEffort = ReasoningEffortId(effort);
      }

      // 4. Delegate the live Session switch. The controller also persists the
      // shared default for future Sessions, matching Harness's model command.
      const selection: ModelSelection = {
        provider: providerId,
        model: modelId,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      };
      try {
        await deps.modelSelection.select(invocation.agent, selection);
      } catch (error) {
        return { kind: 'error', text: '模型切换失败：' + errorMessage(error) };
      }

      // 5. Report success.
      return {
        kind: 'success',
        text: formatSelection('模型已切换：', selection) + '\n\n当前会话从下一次模型执行开始生效；该选择也会成为新会话默认。',
      };
    },
  };
}

function formatSelection(header: string, selection: ModelSelection): string {
  const lines = [header, '', 'Provider: ' + selection.provider, 'Model: ' + selection.model];
  if (selection.reasoningEffort) lines.push('Reasoning: ' + String(selection.reasoningEffort));
  return lines.join('\n');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
