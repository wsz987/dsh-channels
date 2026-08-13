/**
 * FakeChannelAdapter — a configurable in-memory `ChannelAdapter` for contract
 * tests and E2E assembly.
 *
 * It implements the full `ChannelAdapter` surface, records every event emitted
 * through its context, forwards them to an optional `ChannelService`, and
 * simulates platform lifecycle (`authState`, `connectionState`, health).
 *
 * The testkit never depends on channel-harness or any Harness internals; this
 * adapter only talks to the channel-core contract.
 */
import { BufferedReply, toChannelError } from '@dsh/channel-core';
import type {
  AuthState,
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelCapabilities,
  ChannelEvent,
  ChannelHealth,
  ChannelService,
  ChannelTarget,
  ConnectionState,
  CreateReplyOptions,
  OutboundMessage,
  ReplyHandle,
  SendResult,
} from '@dsh/channel-core';

export interface FakeChannelAdapterOptions {
  /** Adapter id; defaults to `'fake'`. */
  id?: string;
  /** Overrides merged over the default capability surface. */
  capabilities?: Partial<ChannelCapabilities>;
  /**
   * Optional ChannelService that emitted events are forwarded to. When absent,
   * events are forwarded through the original context emit (which already
   * routes to a service in `createTestContext()`).
   */
  service?: ChannelService;
  /**
   * Enable adapter-level dedup: repeated `message.received` events sharing the
   * same message id are forwarded only once. Used by the contract dedup group.
   */
  dedup?: boolean;
}

/**
 * Fully in-memory channel adapter. All "platform" behavior is simulated:
 * `receive()` feeds inbound events, `send()` records outbound messages, and
 * lifecycle fields are plain mutable properties tests can assert on.
 */
export class FakeChannelAdapter implements ChannelAdapter {
  readonly id: string;
  readonly capabilities: ChannelCapabilities;
  readonly service?: ChannelService;

  /** Every event emitted through the adapter context (the wrapped `ctx.emit`). */
  readonly received: ChannelEvent[] = [];
  /** Every outbound message passed to `send()`. */
  readonly sentMessages: { target: ChannelTarget; message: OutboundMessage }[] = [];

  /** Mutable auth state, simulating platform credential state. */
  authState: AuthState = 'unknown';
  /** Mutable connection state, simulating the platform socket lifecycle. */
  connectionState: ConnectionState = 'disconnected';
  /** Health surface reported by `getHealth()`. */
  health: ChannelHealth = { status: 'ok' };
  /** Number of times `stop()` was called. */
  stopCount = 0;

  /** The context most recently passed to `start()`; `undefined` before start. */
  context?: ChannelAdapterContext;

  private readonly dedupEnabled: boolean;
  private started = false;
  private sendCounter = 0;
  private pendingSendError: unknown;
  private readonly seenMessageIds = new Set<string>();

  constructor(options: FakeChannelAdapterOptions = {}) {
    this.id = options.id ?? 'fake';
    this.service = options.service;
    this.dedupEnabled = options.dedup ?? false;
    this.capabilities = {
      text: true,
      image: false,
      file: false,
      audio: false,
      video: false,
      markdown: false,
      cards: false,
      reactions: false,
      threads: false,
      streaming: 'buffered',
      ...options.capabilities,
    };
  }

  async start(ctx: ChannelAdapterContext): Promise<void> {
    this.context = ctx;
    this.started = true;
    this.connectionState = 'connected';
    this.authState = 'authenticated';
    // Wrap `ctx.emit` so every internal emit is recorded and (unless deduped)
    // forwarded to the underlying service wiring.
    const forward = ctx.emit.bind(ctx);
    ctx.emit = async (event: ChannelEvent): Promise<void> => {
      this.received.push(event);
      if (this.dedupEnabled && event.type === 'message.received') {
        const { id } = event.message;
        if (this.seenMessageIds.has(id)) return;
        this.seenMessageIds.add(id);
      }
      await forward(event);
    };
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.started = false;
    this.connectionState = 'closed';
  }

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    this.sentMessages.push({ target, message });
    this.sendCounter += 1;
    if (this.pendingSendError !== undefined) {
      const error = this.pendingSendError;
      this.pendingSendError = undefined;
      throw toChannelError(error, 'CHANNEL_SEND_FAILED');
    }
    return { delivered: true, messageId: `sent-${this.sendCounter}` };
  }

  /** Make the next `send()` throw a platform-style error (normalized to ChannelError). */
  failNextSend(error: unknown = new Error('fake platform send failure')): void {
    this.pendingSendError = error;
  }

  /** Simulate the platform delivering an inbound event; ignored while stopped. */
  async receive(event: ChannelEvent): Promise<void> {
    if (!this.started || !this.context) return;
    await this.context.emit(event);
  }

  async createReply(target: ChannelTarget, _options?: CreateReplyOptions): Promise<ReplyHandle> {
    return new BufferedReply({
      deliver: async (text) => this.send(target, { text }),
    });
  }

  async getHealth(): Promise<ChannelHealth> {
    const connection: ChannelHealth['connection'] =
      this.connectionState === 'connected' || this.connectionState === 'connecting'
        ? this.connectionState
        : this.connectionState === 'reconnecting'
          ? 'reconnecting'
          : 'disconnected';
    return {
      ...this.health,
      connection,
      authenticated: this.authState === 'authenticated',
    };
  }
}
