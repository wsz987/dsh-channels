/**
 * `ReplyContextStore` — carries the transient per-turn reply context from an
 * inbound message to the outbound reply target.
 *
 * The triggering message id (and the conversation kind it came from) belongs
 * to one user-message ↔ one agent-turn pair, so it is *never* persisted on a
 * `SessionBinding` (which models the durable conversation ↔ session relation).
 * Instead the correlation is established with the Harness `MessageId`:
 *
 * 1. The bridge converts the inbound message to a Harness `UserMessage`
 *    (`createUserMessage` assigns a fresh stable `MessageId`) and *registers*
 *    a pending context keyed by that message id, strictly BEFORE `followup`.
 * 2. Harness drives the message through the agent inbox; when the agent loop
 *    actually picks it up, `agent/inbox/claimed { agent, message, turn }`
 *    fires, and the store *claims* the pending context by `message.id`,
 *    moving it to the active slot for `sessionId`+`turn`.
 * 3. `assistant/chunk` / `assistant/message` (which only flow after the claim)
 *    resolve the active context lazily via `getTurn`, so the reply target is
 *    bound exactly once per message-id — never via a session FIFO guessed at
 *    `turn/start`.
 * 4. `turn/end` releases the active context; `agent/inbox/discarded` drops a
 *    pending context that never became a turn (prevents leaks).
 */

export interface ChannelReplyContext {
  conversationType: 'dm' | 'group';
  /** Authorized sender that initiated this turn. */
  senderId?: string;
  replyToMessageId?: string;
  raw?: unknown;
  /**
   * Turn-scoped correlation id. Mined once per inbound turn and shared by every
   * outbound send scoped to that turn, so the platform (e.g. Weixin run_id)
   * sees ONE stable correlation instead of a fresh UUID per sender call.
   */
  runId?: string;
}

export class ReplyContextStore {
  /** MessageId → pending context waiting for its `agent/inbox/claimed`. */
  private readonly pendingByMessageId = new Map<
    string,
    { sessionId: string; context: ChannelReplyContext }
  >();
  /** `${sessionId}:${turn}` → active context for that turn. */
  private readonly activeByTurn = new Map<string, ChannelReplyContext>();

  /** Register a context for one Harness UserMessage id (call BEFORE followup). */
  register(
    messageId: string,
    pending: { sessionId: string; context: ChannelReplyContext },
  ): void {
    this.pendingByMessageId.set(messageId, pending);
  }

  /** Move pendingByMessageId[messageId] → activeByTurn[sessionId:turn]; delete the pending entry. */
  claim(input: {
    sessionId: string;
    messageId: string;
    turn: number;
  }): ChannelReplyContext | undefined {
    const pending = this.pendingByMessageId.get(input.messageId);
    if (!pending) return undefined;
    this.pendingByMessageId.delete(input.messageId);
    this.activeByTurn.set(`${input.sessionId}:${input.turn}`, pending.context);
    return pending.context;
  }

  /** Drop a pending context by message id (agent/inbox/discarded) — prevents leaks. */
  discard(messageId: string): void {
    this.pendingByMessageId.delete(messageId);
  }

  /** Session id of a still-pending context, if any (used to cancel typing on discard). */
  pendingSessionId(messageId: string): string | undefined {
    return this.pendingByMessageId.get(messageId)?.sessionId;
  }

  /** Pending context before discard, used to stop target-bound indicators. */
  pendingContext(messageId: string): ChannelReplyContext | undefined {
    return this.pendingByMessageId.get(messageId)?.context;
  }

  /** Active context for sessionId+turn, if any. */
  getTurn(sessionId: string, turn: number): ChannelReplyContext | undefined {
    return this.activeByTurn.get(`${sessionId}:${turn}`);
  }

  /** Active context for a single-flight Agent session, including its turn. */
  getActiveForSession(
    sessionId: string,
  ): { turn: number; context: ChannelReplyContext } | undefined {
    const prefix = `${sessionId}:`;
    for (const [key, context] of this.activeByTurn) {
      if (!key.startsWith(prefix)) continue;
      const turn = Number(key.slice(prefix.length));
      if (Number.isSafeInteger(turn)) return { turn, context };
    }
    return undefined;
  }

  /** Drop the active context for sessionId+turn (turn/end cleanup). */
  releaseTurn(sessionId: string, turn: number): void {
    this.activeByTurn.delete(`${sessionId}:${turn}`);
  }
}
