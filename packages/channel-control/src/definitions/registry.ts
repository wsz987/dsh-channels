/**
 * [ChannelDefinitionRegistry] — registration-order store of ChannelDefinitions.
 *
 * Each channel plugin registers exactly one definition at activation time; the
 * control plane drives setup/authorization/runtime purely through these
 * definitions (doc §14). Iteration is in registration order.
 */
import { ChannelDuplicateError, ChannelError } from '@wsz987/channel-core';
import type { ChannelDefinition } from '../types.js';

export class ChannelDefinitionRegistry {
  private readonly definitions = new Map<string, ChannelDefinition>();
  private readonly listeners = new Set<(definition: ChannelDefinition) => void>();

  /**
   * Subscribe to definition registrations. The returned disposer removes the
   * listener. Fired synchronously after a successful register() — the control
   * plane uses this to auto-start configured channels the moment their plugin
   * registers the definition (doc §27), since channel plugins activate AFTER
   * the channel-control plugin itself.
   */
  onRegister(listener: (definition: ChannelDefinition) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Register a definition; throws ChannelDuplicateError on duplicate id. */
  register(definition: ChannelDefinition): void {
    const { id } = definition;
    if (this.definitions.has(id)) {
      throw new ChannelDuplicateError(
        `channel definition '${id}' is already registered`,
      );
    }
    this.definitions.set(id, definition);
    for (const listener of this.listeners) {
      listener(definition);
    }
  }

  get(id: string): ChannelDefinition | undefined {
    return this.definitions.get(id);
  }

  /** Require a definition, or raise a stable ChannelError. */
  require(id: string): ChannelDefinition {
    const definition = this.definitions.get(id);
    if (!definition) {
      throw new ChannelError(
        'CHANNEL_ERROR',
        `channel definition '${id}' is not registered`,
      );
    }
    return definition;
  }

  has(id: string): boolean {
    return this.definitions.has(id);
  }

  /** List definitions in registration order. */
  list(): ChannelDefinition[] {
    return [...this.definitions.values()];
  }

  /** Remove a definition; returns whether it existed. */
  unregister(id: string): boolean {
    return this.definitions.delete(id);
  }
}
