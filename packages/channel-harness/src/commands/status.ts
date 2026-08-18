/**
 * The `/status` command (spec §14).
 *
 * Pure Human Plane — never calls the model. Shows the session identity +
 * lifecycle status and the effective model selection (provider / model /
 * reasoning effort). Secrets (API keys, tokens, webhooks, platform keys,
 * reply-context) are never shown.
 */
import { type CommandDefinition } from '@deepseek-ai/dsh-commands';
import type { ChannelCommandDependencies } from './index.js';

export function createStatusCommand(deps: ChannelCommandDependencies): CommandDefinition {
  return {
    name: 'status',
    description: 'Show session / agent / model status',
    handler(invocation) {
      const lines = [
        'Session',
        'ID: ' + String(invocation.agent.id),
        'Status: ' + invocation.agent.status,
      ];
      const selection = deps.modelSelection.current(invocation.agent);
      if (selection) {
        lines.push('', 'Model', 'Provider: ' + selection.provider, 'Model: ' + selection.model);
        if (selection.reasoningEffort) lines.push('Reasoning: ' + String(selection.reasoningEffort));
      }
      return { kind: 'success', text: lines.join('\n') };
    },
  };
}
