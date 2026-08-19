/**
 * [ChannelControlService] — the universal Channel Control Plane mounted at
 * ctx.channelControl (doc §12–§13, §33, §46).
 *
 * Owns the four sub-managers that later waves wire into:
 * - definition registry (registration order)
 * - credential access (thin wrappers over the injected structural seam)
 * - interactive auth session lifecycle (AuthSessionManager)
 * - runtime mount lifecycle (ChannelRuntimeManager)
 *
 * It is deliberately adapter-agnostic: every channel is driven through its
 * [ChannelDefinition], never through a per-channel conditional.
 *
 * The credentials seam is structural ([CredentialSeam]) and injected, so this
 * package carries no dependency on any concrete credentials implementation.
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import type { ChannelAdapter } from '@wsz987/channel-core';
import { ChannelDefinitionRegistry } from './definitions/registry.js';
import { CredentialManager, type CredentialSeam } from './credentials/manager.js';
import { AuthSessionManager } from './auth/session-manager.js';
import { ControlError } from './errors.js';
import { ChannelRuntimeManager } from './runtime/manager.js';
import type {
  AuthBeginInput,
  AuthInput,
  ChannelDefinition,
  ChannelSetupDescriptor,
  ChannelSetupField,
  ChannelSetupInput,
  ChannelSetupResult,
  ChannelSummary,
  ConfiguredState,
  InternalAuthSession,
} from './types.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    channelControl: ChannelControlService;
  }
}

export interface ChannelControlServiceOptions {
  /** Optional registry; created fresh when omitted. */
  registry?: ChannelDefinitionRegistry;
  /** The injected credentials seam (structural). */
  credentials: CredentialSeam;
  /** Injectable clock for auth (ms since epoch). Defaults to Date.now. */
  now?: () => number;
}

const SECRET_SUFFIXES = ['secret', 'Secret', 'token', 'Token'] as const;

/** Whether a config key is a secret field and must be rejected in saveConfig. */
function isSecretKey(name: string): boolean {
  return SECRET_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export class ChannelControlService extends Service {
  readonly definitions: ChannelDefinitionRegistry;
  readonly credentials: CredentialManager;
  readonly auth: AuthSessionManager;
  readonly runtime: ChannelRuntimeManager;

  constructor(ctx: Context, options: ChannelControlServiceOptions) {
    super(ctx, 'channelControl');
    this.definitions = options.registry ?? new ChannelDefinitionRegistry();
    this.credentials = new CredentialManager(options.credentials);
    this.auth = new AuthSessionManager({ registry: this.definitions, now: options.now });
    this.runtime = new ChannelRuntimeManager({
      ctx,
      registry: this.definitions,
      credentials: options.credentials,
    });
    // Doc §27: auto-start configured channels the moment their plugin
    // registers the definition (channel plugins activate after this service).
    // A registration that cannot report state or fails to start is logged by
    // autoStartOne and never throws out of register().
    this.definitions.onRegister((definition) => {
      void this.runtime.autoStartOne(definition.id).catch(() => {});
    });
  }

  // ---- convenience surface for the future v2 web API (doc §29–§33) --------

  /** Registry + runtime + configured state merged into per-channel rows. */
  async listChannels(): Promise<ChannelSummary[]> {
    const rows: ChannelSummary[] = [];
    for (const definition of this.definitions.list()) {
      rows.push(await this.summarize(definition));
    }
    return rows;
  }

  /** One merged row for a single registered channel, or a stable ChannelError. */
  async getChannel(channelId: string): Promise<ChannelSummary> {
    return this.summarize(this.definitions.require(channelId));
  }

  /**
   * Enable / disable a channel (doc §22, §25). Disabling persists the intent
   * and stops the runtime; enabling persists the intent and — when the channel
   * is configured — starts the runtime. Returns the latest merged summary.
   */
  async setEnabled(channelId: string, enabled: boolean): Promise<ChannelSummary> {
    const definition = this.definitions.require(channelId);
    if (!definition.setEnabled) {
      throw new ControlError(
        'ENABLE_NOT_SUPPORTED',
        `channel '${channelId}' does not support enable/disable`,
      );
    }
    await definition.setEnabled(enabled);
    if (!enabled) {
      await this.runtime.stop(channelId);
    } else {
      let configured = false;
      try {
        configured = (await definition.getConfiguredState()).configured;
      } catch {
        configured = false;
      }
      if (configured) await this.runtime.start(channelId);
    }
    return this.getChannel(channelId);
  }

  /** Merge one definition's registry + runtime + configured state into a row. */
  private async summarize(definition: ChannelDefinition): Promise<ChannelSummary> {
    let configured = false;
    try {
      configured = (await definition.getConfiguredState()).configured;
    } catch {
      configured = false;
    }
    const enabled = definition.enabled;
    const running = this.runtime.isRunning(definition.id);
    if (running) {
      const status = await this.runtime.status(definition.id);
      return {
        id: definition.id,
        configured,
        enabled,
        mounted: status.mounted,
        runtime: status.running ? 'running' : 'stopped',
        connection: status.connection,
      };
    }
    return {
      id: definition.id,
      configured,
      enabled,
      mounted: false,
      runtime: 'stopped',
      connection: 'unknown',
    };
  }

  async getSetup(channelId: string): Promise<ChannelSetupDescriptor> {
    const definition = this.definitions.require(channelId);
    const state = await definition.getConfiguredState();
    return {
      authMethods: [...definition.setup.authMethods],
      setupUrl: definition.setup.setupUrl,
      fields: definition.setup.fields.map((field) => {
        const dynamic = state.fields[field.name];
        const publicField: ChannelSetupField = {
          name: field.name,
          kind: field.kind,
          secret: field.secret,
          configured: dynamic?.configured ?? field.configured,
          writable: dynamic?.writable ?? field.writable,
        };
        // Surface the current value for non-secret fields only (doc §29).
        // Secret values and the credential ref are never echoed here.
        if (!field.secret && typeof dynamic?.value === 'string') {
          publicField.value = dynamic.value;
        }
        return publicField;
      }),
    };
  }

  async getConfiguredState(channelId: string): Promise<ConfiguredState> {
    return this.definitions.require(channelId).getConfiguredState();
  }

  /**
   * Persist a non-secret config patch for a channel. Secret fields (names
   * ending in Secret/secret/Token/token, or declared kind:'secret' in the
   * setup descriptor) are rejected — secret values go only through
   * credentials.set (doc §30–§31).
   */
  async saveConfig(channelId: string, patch: Record<string, unknown>): Promise<void> {
    const definition = this.definitions.require(channelId);
    const secretNames = new Set(
      definition.setup.fields.filter((field) => field.secret).map((field) => field.name),
    );
    for (const key of Object.keys(patch)) {
      if (isSecretKey(key) || secretNames.has(key)) {
        throw new ControlError(
          'SECRET_FIELD_REJECTED',
          `config field '${key}' is a secret; save it through the credentials seam instead`,
        );
      }
    }
    await definition.saveConfig(patch);
  }

  /**
   * Describe one credential field of a channel by its setup field name
   * (doc §31). Resolves the field's credential ref from the setup descriptor
   * and describes it via ctx.credentials — the value is never returned.
   */
  async describeCredential(
    channelId: string,
    fieldName: string,
  ): Promise<{ configured: boolean; writable: boolean; source?: string }> {
    const field = this.credentialField(channelId, fieldName);
    if (field.ref) {
      const described = await this.credentials.describe(field.ref);
      return { configured: described.configured, writable: described.writable, source: described.source };
    }
    return { configured: false, writable: field.writable };
  }

  /**
   * Save one credential field of a channel by its setup field name (doc §31).
   * The web layer sends only { field, value }; the control plane maps the
   * field to its credential ref and calls ctx.credentials.set. The value is
   * never echoed back.
   */
  async saveCredential(
    channelId: string,
    fieldName: string,
    value: string,
  ): Promise<{ configured: boolean; writable: boolean }> {
    const field = this.credentialField(channelId, fieldName);
    if (!field.secret) {
      throw new ControlError(
        'NOT_A_SECRET_FIELD',
        `field '${fieldName}' is not a secret; save it through the config endpoint`,
      );
    }
    if (!field.ref) {
      throw new ControlError(
        'CREDENTIAL_NOT_SUPPORTED',
        `field '${fieldName}' has no credential ref`,
      );
    }
    if (!field.writable) {
      throw new ControlError(
        'CREDENTIAL_READONLY',
        `credential '${fieldName}' is read-only (not writable)`,
      );
    }
    if (typeof value !== 'string') {
      throw new ControlError('INVALID_CREDENTIAL', 'credential value must be a string');
    }
    // Empty value = clear/delete the stored credential (the harness credential
    // seam rejects set(ref, '') and exposes unset for exactly this).
    if (value === '') {
      await this.credentials.unset(field.ref);
    } else {
      await this.credentials.set(field.ref, value);
    }
    const described = await this.credentials.describe(field.ref);
    return { configured: described.configured, writable: described.writable };
  }

  /**
   * Save a complete setup form and make it effective immediately. The Web
   * sends one user action; secret and non-secret fields still cross their
   * dedicated storage seams on the host.
   */
  async applySetup(channelId: string, input: ChannelSetupInput): Promise<ChannelSetupResult> {
    const definition = this.definitions.require(channelId);
    const running = this.runtime.isRunning(channelId);
    if (running && Object.keys(input.config).length > 0 && (!definition.snapshotConfig || !definition.restoreConfig)) {
      throw new ControlError('CONTROL_ERROR', `channel '${channelId}' does not support transactional config updates`);
    }

    const configSnapshot = definition.snapshotConfig?.();
    const credentialSnapshots = await Promise.all(
      Object.keys(input.credentials).map(async (fieldName) => {
        const field = this.credentialField(channelId, fieldName);
        if (!field.ref) return undefined;
        return { ref: field.ref, previous: await this.credentials.resolve(field.ref) };
      }),
    );
    let rolledBack = false;
    const rollback = async () => {
      if (rolledBack) return;
      rolledBack = true;
      if (configSnapshot !== undefined) await definition.restoreConfig?.(configSnapshot);
      for (const snapshot of credentialSnapshots) {
        if (!snapshot) continue;
        if (snapshot.previous) await this.credentials.set(snapshot.ref, snapshot.previous.value);
        else await this.credentials.unset(snapshot.ref);
      }
    };

    try {
      if (Object.keys(input.config).length > 0) await this.saveConfig(channelId, input.config);
      for (const [field, value] of Object.entries(input.credentials)) {
        await this.saveCredential(channelId, field, value);
      }

      const configured = await this.getConfiguredState(channelId);
      if (!configured.configured) {
        // Clearing a required setup value is an intentional disable. End the
        // existing connection so its in-memory credentials cannot outlive the
        // persisted unconfigured state.
        if (running) await this.runtime.stop(channelId);
        return { configured: false, connection: 'unknown' };
      }

      if (input.reconcile === false) {
        const status = await this.runtime.status(channelId);
        return { configured: true, connection: status.connection };
      }

      if (running) await this.runtime.restart(channelId, undefined, rollback);
      else await this.runtime.start(channelId);
      const status = await this.runtime.status(channelId);
      return { configured: true, connection: status.connection };
    } catch (error) {
      try {
        await rollback();
      } catch (recoveryError) {
        this.ctx.logger('channel-control').error(
          `[channel-control] failed to restore setup for '${channelId}'`,
          recoveryError,
        );
      }
      throw error;
    }
  }

  /** Resolve a setup field of a channel or raise a stable error. */
  private credentialField(channelId: string, fieldName: string) {
    const definition = this.definitions.require(channelId);
    const field = definition.setup.fields.find((f) => f.name === fieldName);
    if (!field) {
      throw new ControlError(
        'UNKNOWN_FIELD',
        `channel '${channelId}' has no setup field '${fieldName}'`,
      );
    }
    return field;
  }

  beginAuth(channelId: string, input: AuthBeginInput) {
    return this.auth.create(channelId, input);
  }

  pollAuth(sessionId: string) {
    return this.auth.poll(sessionId);
  }

  submitAuthInput(sessionId: string, input: AuthInput) {
    return this.auth.submit(sessionId, input);
  }

  cancelAuth(sessionId: string) {
    return this.auth.cancel(sessionId);
  }

}

// Re-export authored types on the service module for consistency.
export type { ChannelDefinition, ChannelAdapter, InternalAuthSession };
export { ControlError };
