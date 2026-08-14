/**
 * Channel runtime resources: the durable SecretStore + ChannelStorage pair
 * handed to every adapter through ChannelService.
 *
 * Adapters never instantiate their own storage or secret stores; they read
 * these boundaries from ctx.channels.resources. The concrete implementation
 * (in-memory for tests, file-backed for production) is chosen once by the
 * ChannelService, so swapping a Windows Credential Manager / DPAPI secret
 * provider later never touches an adapter.
 */
import type { SecretStore } from './secrets.js';
import type { ChannelStorage } from './storage.js';

export interface ChannelRuntimeResources {
  /** Durable secret store (credentials, tokens). */
  secrets: SecretStore;
  /** Durable key/value storage (cursors, dedup windows, context state). */
  storage: ChannelStorage;
}
