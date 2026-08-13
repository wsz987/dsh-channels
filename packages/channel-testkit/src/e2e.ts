/**
 * Fake channel E2E (execution plan M0 / Task 9.5).
 *
 * Assembles FakeChannelAdapter + ChannelService + FakeHarness into a complete
 * message pipeline:
 *
 *   inbound message.received → HarnessPort.resolveAgent → HarnessPort.followup
 *     → session event stream → replayed reply sent back through the adapter
 *
 * The harness side is exercised through the minimal `HarnessPort` surface only
 * (never channel-harness internals), so this handle can later be reused by the
 * channel-harness integration tests.
 */
import { Context } from '@deepseek-ai/cordis';
import { ChannelService } from '@dsh/channel-core';
import type {
  ChannelAdapterContext,
  ChannelEvent,
  ChannelTarget,
  MessageReceived,
  OutboundMessage,
} from '@dsh/channel-core';
import { FakeChannelAdapter } from './fake-adapter.js';
import { FakeHarness } from './fake-harness.js';
import { createTestContext } from './contract-tests.js';

export interface FakeChannelE2EOptions {
  /** Channel id; defaults to the adapter's id. */
  channel?: string;
  /** Account id within the channel; defaults to `'main'`. */
  accountId?: string;
  /** Pre-built adapter; a fresh one is created when omitted. */
  adapter?: FakeChannelAdapter;
  /** Pre-built ChannelService; a fresh one is created when omitted. */
  service?: ChannelService;
  /** Pre-built FakeHarness; a fresh one is created when omitted. */
  harness?: FakeHarness;
}

export interface FakeChannelE2EHandle {
  channel: string;
  accountId: string;
  adapter: FakeChannelAdapter;
  service: ChannelService;
  harness: FakeHarness;
  context: ChannelAdapterContext;
  /** Followup inputs routed to the agent per inbound message. */
  receivedByAgent: unknown[];
  /** Session ids resolved per inbound message. */
  sessionIds: string[];
  /** Session events replayed back from the harness stream. */
  replayedEvents: unknown[];
  /** Replies sent back to the channel as a result of the replay. */
  sentReplies: { target: ChannelTarget; message: OutboundMessage }[];
  /** Deliver one inbound text message through the full pipeline. */
  sendInbound(text: string, senderId?: string): Promise<MessageReceived>;
  /** Tear the pipeline down (unsubscribe, stop adapter, unregister). */
  dispose(): Promise<void>;
}

function inboundEvent(input: {
  channel: string;
  accountId: string;
  senderId: string;
  text: string;
}): MessageReceived {
  return {
    type: 'message.received',
    channel: input.channel as never,
    accountId: input.accountId as never,
    conversation: { id: input.senderId as never, type: 'dm' },
    sender: { id: input.senderId as never },
    message: {
      id: `in-${Date.now()}-${Math.random().toString(36).slice(2)}` as never,
      content: [{ type: 'text', text: input.text }],
      createdAt: Date.now(),
    },
  };
}

/**
 * Build and start the fake E2E pipeline. The returned handle can be used to
 * push inbound messages and assert on every stage of the flow.
 */
export async function runFakeChannelE2E(
  options: FakeChannelE2EOptions = {},
): Promise<FakeChannelE2EHandle> {
  const harness = options.harness ?? new FakeHarness();
  let service = options.service;
  if (!service) {
    const ctx = new Context();
    new ChannelService(ctx);
    service = ctx.channels;
  }
  const adapter = options.adapter ?? new FakeChannelAdapter({ id: options.channel ?? 'fake', service });
  const channel = options.channel ?? adapter.id;
  const accountId = options.accountId ?? 'main';

  const unregister = service.register(adapter);
  const context = createTestContext(service);
  await adapter.start(context);

  const receivedByAgent: unknown[] = [];
  const sessionIds: string[] = [];
  const replayedEvents: unknown[] = [];
  const sentReplies: { target: ChannelTarget; message: OutboundMessage }[] = [];
  const activeStreams = new Map<string, () => void>();

  const sessionKey = (event: MessageReceived): string =>
    service.key({
      channelId: event.channel,
      accountId: event.accountId,
      conversationId: event.conversation.id,
      threadId: event.conversation.threadId,
    });

  // Route inbound message.received events into the harness port. The listener
  // captures the async chain so `sendInbound` can await deterministic completion.
  let pending: Promise<void> | undefined;
  let pendingError: unknown;

  const unsubscribe = service.on((event: ChannelEvent) => {
    if (event.type !== 'message.received') return;
    const key = sessionKey(event);
    pending = processInbound(event, key).catch((error: unknown) => {
      pendingError = error;
    });
  });

  async function processInbound(event: MessageReceived, sessionId: string): Promise<void> {
    sessionIds.push(sessionId);
    const { id: agentId } = await harness.resolveAgent(sessionId);
    await harness.followup(agentId, event.message);
    receivedByAgent.push(event.message);

    // Replay agent session events back to the channel through the stream port.
    // Dispose any previous subscription for the session so multiple inbound
    // messages never stack duplicate event streams.
    activeStreams.get(sessionId)?.();
    activeStreams.set(
      sessionId,
      harness.streamEvents(sessionId, (streamEvent: unknown) => {
        replayedEvents.push(streamEvent);
        const target: ChannelTarget = {
          channelId: event.channel,
          accountId: event.accountId,
          conversationId: event.conversation.id,
          threadId: event.conversation.threadId,
        };
        const message: OutboundMessage = {
          text: typeof streamEvent === 'string' ? streamEvent : JSON.stringify(streamEvent),
        };
        sentReplies.push({ target, message });
        void adapter.send(target, message).catch(() => undefined);
      }),
    );

    const first = event.message.content[0];
    const text = first && first.type === 'text' ? first.text : '';
    harness.emitSessionEvent(sessionId, {
      type: 'agent.reply',
      text: `reply to ${text}`,
      sessionId,
    });
  }

  return {
    channel,
    accountId,
    adapter,
    service,
    harness,
    context,

    receivedByAgent,
    sessionIds,
    replayedEvents,
    sentReplies,

    async sendInbound(text: string, senderId?: string): Promise<MessageReceived> {
      pending = undefined;
      pendingError = undefined;
      const event = inboundEvent({ channel, accountId, senderId: senderId ?? 'user-1', text });
      await adapter.receive(event);
      if (pending) await pending;
      if (pendingError !== undefined) throw pendingError;
      return event;
    },

    async dispose(): Promise<void> {
      unsubscribe();
      for (const disposeStream of activeStreams.values()) disposeStream();
      activeStreams.clear();
      await adapter.stop().catch(() => undefined);
      unregister();
    },
  };
}
