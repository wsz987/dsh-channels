/**
 * Fail-closed support behind the `/bind` command (issue #6).
 *
 * Resolution NEVER mutates: it resolves the query against the persisted
 * session universe (exact id first, then a unique prefix of at least
 * {@link MIN_BIND_QUERY_LENGTH} characters) and reports the two refusal
 * conditions — a target already bound to a different conversation, and a
 * persisted Agent preset that conflicts with the conversation's route (which
 * would make the next resume throw, per the official resume semantics).
 * `confirmBindTarget` re-runs the full resolution at confirm time (guarding
 * against races) and only then re-points the durable binding.
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { HarnessAgentGateway } from './agent-manager.js';
import { bindingKey, type SessionBinding } from './session-router.js';
import type { ChannelBindResolution } from './commands/index.js';
import type { SessionBindingStore } from './binding-store.js';

/** Minimum prefix length before a non-exact query is even considered. */
export const MIN_BIND_QUERY_LENGTH = 4;

/** Resolve one `/bind` query against persisted sessions without mutating. */
export async function resolveBindTarget(
  gateway: HarnessAgentGateway,
  bindingStore: SessionBindingStore,
  agent: Agent,
  query: string,
): Promise<ChannelBindResolution> {
  const currentBinding = await requireCurrentBinding(bindingStore, agent);
  const ids = await gateway.listPersistedSessionIds();
  let matches = ids.filter((id) => id === query);
  if (matches.length === 0 && query.length >= MIN_BIND_QUERY_LENGTH) {
    matches = ids.filter((id) => id.startsWith(query));
  }
  if (matches.length === 0) return { kind: 'missing' };
  if (matches.length > 1) return { kind: 'ambiguous', candidates: matches.slice(0, 6) };

  const target = matches[0]!;
  const boundElsewhere = await isBoundElsewhere(bindingStore, currentBinding, target);
  const preset = await gateway.persistedPresetOf(target);
  const routePreset = currentBinding.route.preset;
  const conflict = preset !== undefined && routePreset !== undefined && routePreset !== preset;
  return { kind: 'resolved', sessionId: target, preset, boundElsewhere, conflict };
}

/** Re-resolve and re-point the current conversation's binding at `sessionId`. */
export async function confirmBindTarget(
  gateway: HarnessAgentGateway,
  bindingStore: SessionBindingStore,
  agent: Agent,
  sessionId: string,
): Promise<void> {
  const currentBinding = await requireCurrentBinding(bindingStore, agent);
  if (sessionId === String(agent.id)) {
    throw new Error('this conversation is already bound to that session');
  }
  // Race guard: the full resolution re-runs at confirm time; any changed
  // condition fails the rebind instead of producing a broken binding.
  const resolution = await resolveBindTarget(gateway, bindingStore, agent, sessionId);
  if (resolution.kind !== 'resolved' || resolution.sessionId !== sessionId) {
    throw new Error('bind target is no longer uniquely resolvable; refused');
  }
  if (resolution.boundElsewhere) {
    throw new Error('target session is bound to another conversation; refused');
  }
  if (resolution.conflict) {
    throw new Error('target session preset conflicts with this conversation route; refused');
  }
  await bindingStore.put({
    ...currentBinding,
    sessionId,
    // Persisted composition wins, exactly like the official resume path: the
    // next message resumes under the target's recorded preset.
    route: resolution.preset
      ? { ...currentBinding.route, preset: resolution.preset }
      : currentBinding.route,
    updatedAt: Date.now(),
  });
}

async function requireCurrentBinding(
  bindingStore: SessionBindingStore,
  agent: Agent,
): Promise<SessionBinding> {
  const binding = await bindingStore.findBySessionId(String(agent.id));
  if (!binding) {
    throw new Error(`no session binding for '${String(agent.id)}'`);
  }
  return binding;
}

async function isBoundElsewhere(
  bindingStore: SessionBindingStore,
  currentBinding: SessionBinding,
  targetSessionId: string,
): Promise<boolean> {
  const existing = await bindingStore.findBySessionId(targetSessionId);
  return !!existing && bindingKey(existing) !== bindingKey(currentBinding);
}
