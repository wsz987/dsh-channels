/**
 * FakeUpstream — a minimal in-memory stand-in for the messaging platform's
 * driver side ("upstream").
 *
 * Adapters delegate platform SDK/package/protocol interaction to an upstream
 * driver; `FakeUpstream` lets those flows be exercised without a real network
 * or platform credentials. It tracks connections, records outbound payloads,
 * dispatches inbound payloads to registered handlers and can be told to fail
 * its next call.
 */
import { toChannelError } from '@wsz987/channel-core';

/** Handler invoked when the "platform" delivers an inbound payload. */
export type FakeUpstreamHandler = (payload: unknown) => void | Promise<void>;

/** A text payload sent out through the fake upstream. */
export interface FakeUpstreamTextMessage {
  text: string;
  target?: string;
}

export interface FakeUpstreamOptions {
  /** Identifier reported by the fake platform (defaults to `'fake-upstream'`). */
  id?: string;
}

export class FakeUpstream {
  readonly id: string;

  /** Number of active simulated connections. */
  connections = 0;

  /** Set to an error to make the next `sendText()` throw. */
  failNextCall: unknown;

  /** Outbound text payloads sent through `sendText()`. */
  readonly sent: FakeUpstreamTextMessage[] = [];

  /** Inbound payloads dispatched via `emitMessage()`. */
  readonly received: unknown[] = [];

  private readonly handlers = new Set<FakeUpstreamHandler>();

  constructor(options: FakeUpstreamOptions = {}) {
    this.id = options.id ?? 'fake-upstream';
  }

  /** Register an inbound handler; returns a disposer. */
  onMessage(handler: FakeUpstreamHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Simulate establishing a platform connection. */
  async connect(): Promise<void> {
    this.connections += 1;
  }

  /** Simulate tearing down a platform connection. */
  async disconnect(): Promise<void> {
    this.connections = Math.max(0, this.connections - 1);
  }

  /** Send a text payload out; records it and honors `failNextCall`. */
  async sendText(text: string, options: { target?: string } = {}): Promise<void> {
    if (this.failNextCall !== undefined) {
      const error = this.failNextCall;
      this.failNextCall = undefined;
      throw toChannelError(error, 'CHANNEL_SEND_FAILED');
    }
    this.sent.push({
      text,
      ...(options.target !== undefined ? { target: options.target } : {}),
    });
  }

  /** Simulate the platform delivering an inbound payload to all handlers. */
  async emitMessage(payload: unknown): Promise<void> {
    this.received.push(payload);
    for (const handler of [...this.handlers]) {
      await handler(payload);
    }
  }
}
