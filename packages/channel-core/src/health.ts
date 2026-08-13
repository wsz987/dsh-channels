/**
 * Health and diagnostics types surfaced by `ChannelAdapter.getHealth()`
 * and consumed by `channels doctor`.
 */

export type ChannelHealthStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface ChannelHealth {
  status: ChannelHealthStatus;
  /** Human-readable summary for doctor output. */
  detail?: string;
  /** Connection state, when the adapter tracks it. */
  connection?: 'connected' | 'connecting' | 'reconnecting' | 'disconnected';
  /** Whether auth is currently in a usable state. */
  authenticated?: boolean;
  /** Uptime in milliseconds, when known. */
  uptimeMs?: number;
  /** Error detail when the channel is not healthy. */
  error?: string;
  /** Adapter-specific diagnostics; never includes credentials. */
  raw?: unknown;
}
