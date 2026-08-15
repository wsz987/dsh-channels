/**
 * Durable Binding Authority (plan §58 / ¨59).
 *
 * Outbox authorization comes from the DURABLE `SessionBindingStore`, NEVER from
 * the in-memory `AgentManager` cache. `AgentManager.bindingFor()` is only a
 * hint used by the reply pipeline; a send MUST re-resolve through
 * `findBySessionId` so it sees the current durable binding — including after a
 * `/new`, at which point the retired session's durable binding is gone and the
 * send must fail closed (plan §57: from the binding update onward, session A's
 * outbox has lost authority).
 *
 * `findBySessionId` fails closed with `AmbiguousBindingError`
 * (OUTBOX_AMBIGUOUS_BINDING) when one session id maps to more than one current
 * binding; here it is surfaced as the typed `OutboxError` with the same code.
 */
import { AmbiguousBindingError, type SessionBindingStore } from '../binding-store.js';
import type { SessionBinding } from '../session-router.js';
import { OutboxError } from './types.js';

/**
 * Resolve the single current durable binding for a session (plan §59).
 * Never consults an in-memory cache.
 */
export async function resolveBindingForSession(
  sessionId: string,
  bindingStore: SessionBindingStore,
): Promise<SessionBinding> {
  let binding: SessionBinding | undefined;
  try {
    binding = await bindingStore.findBySessionId(sessionId);
  } catch (error) {
    if (error instanceof AmbiguousBindingError) {
      throw new OutboxError(
        'OUTBOX_AMBIGUOUS_BINDING',
        "session '" + sessionId + "' maps to more than one current channel binding; failing closed",
        { sessionId, cause: error },
      );
    }
    throw error;
  }
  if (!binding) {
    throw new OutboxError(
      'OUTBOX_NO_BINDING',
      "no current channel binding for session '" + sessionId + "'",
      { sessionId },
    );
  }
  return binding;
}
