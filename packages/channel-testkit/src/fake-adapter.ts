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
import { BufferedReply, toChannelError } from '@wsz987/channel-core';
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
  StreamingMode,
} from '@wsz987/channel-core';

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
  /**
   * Streaming strategy produced by `createReply`. Defaults to `'buffered'`
   * (a `BufferedReply` that delivers through `send()`), preserving the
   * existing behavior. With `'edit'` or `'native'`, `createReply` returns a
   * recording `FakeReplyHandle` instead.
   */
  streaming?: StreamingMode;
}

/** One recorded call on a `FakeReplyHandle`. */
export interface FakeReplyCall {
  type: 'append' | 'replace' | 'finish' | 'fail';
  /** For `append`/`replace`/`finish`: the message text involved. */
  text?: string;
  /** For `fail`: the recorded error. */
  error?: unknown;
}

/**
 * Streaming reply handle returned by `createReply` when the adapter's
 * `streaming` capability is `'edit'` or `'native'`. It records every call
 * (`append`/`replace`/`finish`/`fail`) so tests can assert on previews,
 * finalization and failures without a platform. `text` tracks the current
 * content: the last replaced text for `edit`, the accumulated concatenation
 * for `native`.
 */
export class FakeReplyHandle implements ReplyHandle {
  /** Every call made on this handle, in order. */
  readonly calls: FakeReplyCall[] = [];
  /** Current content: replaced text for `edit`, concatenated for `native`. */
  text = '';
  finished = false;
  failed = false;
  appendCount = 0;
  replaceCount = 0;
  finishCount = 0;
  failCount = 0;

  private pendingFailure: unknown;

  /** Make the next `append`/`replace`/`finish` throw (one-shot). */
  failNextCall(error: unknown = new Error('fake reply failure')): void {
    this.pendingFailure = error;
  }

  private throwIfPending(): void {
    if (this.pendingFailure === undefined) return;
    const error = this.pendingFailure;
    this.pendingFailure = undefined;
    throw error;
  }

  async append(delta: string): Promise<void> {
    this.throwIfPending();
    this.calls.push({ type: 'append', text: delta });
    this.appendCount += 1;
    this.text += delta;
  }

  async replace(message: OutboundMessage): Promise<void> {
    this.throwIfPending();
    const text = message.text ?? '';
    this.calls.push({ type: 'replace', text });
    this.replaceCount += 1;
    this.text = text;
  }

  async finish(message?: OutboundMessage): Promise<void> {
    this.throwIfPending();
    const text = message?.text ?? this.text;
    this.calls.push({ type: 'finish', text });
    this.finishCount += 1;
    this.text = text;
    this.finished = true;
  }

  async fail(error: unknown): Promise<void> {
    this.calls.push({ type: 'fail', error });
    this.failCount += 1;
    this.failed = true;
  }
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
  /** Every streaming reply handle created via `createReply`. */
  readonly replies: FakeReplyHandle[] = [];

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
      streaming: options.streaming ?? 'buffered',
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
    if (this.capabilities.streaming !== 'buffered') {
      const handle = new FakeReplyHandle();
      this.replies.push(handle);
      return handle;
    }
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
