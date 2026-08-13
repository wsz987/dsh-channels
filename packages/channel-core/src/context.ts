/**
 * Context handed to an adapter by the ChannelService at start time.
 *
 * The adapter emits structured events, logs with a namespaced logger, and
 * reads secrets/storage through these boundaries — never via Harness APIs
 * and never by touching `ctx.agents`.
 */
import type { ChannelEvent } from './events.js';
import type { SecretStore } from './secrets.js';
import type { ChannelStorage } from './storage.js';

export interface ChannelLogger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface ChannelAdapterContext {
  /** Emit a structured channel event into the ChannelService. */
  emit(event: ChannelEvent): Promise<void>;

  logger: ChannelLogger;

  secrets: SecretStore;

  storage: ChannelStorage;

  /** Aborted when the owning Cordis effect is disposed. */
  signal: AbortSignal;
}
