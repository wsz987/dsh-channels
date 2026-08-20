/**
 * Public type surface of @wsz987/channel-control (execution plan §14–§18).
 *
 * These types define the stable boundary between the Channel Control Plane
 * and every downstream consumer (channel adapters, the Web control plane in
 * channel-web, and future provider auth helpers). Platform differences stop
 * here: channel-control itself is adapter-agnostic and never branches on a
 * specific channel id.
 *
 * Host-only types ([InternalAuthSession], [AuthProviderSession]) must never
 * cross the browser boundary — see auth/sanitizer.ts for the public DTOs.
 */
import type {
  ChannelAccessPolicy,
  ChannelAdapter,
  ChannelHealth,
} from '@wsz987/channel-core';

/** How a channel begins an authorization flow (doc §15). */
export type AuthMethod =
  | 'qr'
  | 'device'
  | 'portal-login'
  | 'credentials'
  | 'hybrid';

/**
 * Fine-grained progress of an auth flow (doc §15/§16). The UI switches on
 * this value rather than parsing free-form [PublicAuthStatus.detail] text.
 */
export type AuthPhase =
  | 'preparing'
  | 'waiting-scan'
  | 'scanned'
  | 'waiting-confirm'
  | 'verification-required'
  | 'credentials-required'
  | 'authorized'
  | 'expired'
  | 'failed'
  | 'cancelled';

/** Coarse public auth state, kept M1-compatible (doc §15). */
export type AuthState = 'pending' | 'authenticated' | 'expired' | 'failed';

/**
 * Structured QR payload (doc §17). Replaces the ambiguous bare string:
 * a value is either opaque content to render, a ready-made data URL, or an
 * external URL to open.
 */
export interface PublicQrPayload {
  kind: 'content' | 'data-url' | 'external-url';
  value: string;
  expiresAt?: number;
}

/** Structured user-facing prompt associated with a phase (doc §16). */
export interface PublicAuthPrompt {
  kind:
    | 'verification-code'
    | 'confirm-on-phone'
    | 'credentials-required'
    | 'open-browser';
  message?: string;
}

/** Public auth status returned by polling (doc §16). */
export interface PublicAuthStatus {
  state: AuthState;
  phase: AuthPhase;
  prompt?: PublicAuthPrompt;
  expiresAt?: number;
  detail?: string;
}

/**
 * Browser-facing session (doc §18). It NEVER contains secrets, tokens, the
 * provider challenge or any provider payload. Build it exclusively through
 * auth/sanitizer.ts.
 */
export interface PublicAuthSession {
  id: string;
  channelId: string;
  state: AuthState;
  phase: AuthPhase;
  qr?: PublicQrPayload;
  expiresAt?: number;
  prompt?: PublicAuthPrompt;
  /**
   * Safe provider polling interval (ms) the browser may use to space its own
   * client polls (doc §15). NOT a secret: it is the provider's declared
   * throttle and the host already enforces the same bound server-side via
   * `nextPollAt`. Omitted unless the provider declared one (> 0).
   */
  pollingIntervalMs?: number;
}

/**
 * Host-only full session (doc §18). Holds the AbortController and opaque
 * provider state. Must never be serialized to the browser.
 */
export interface InternalAuthSession {
  id: string;
  channelId: string;
  accountId: string;
  provider: string;
  createdAt: number;
  expiresAt: number;
  pollingIntervalMs: number;
  nextPollAt: number;
  deviceCode?: string;
  challenge?: unknown;
  abortController: AbortController;
  providerState: unknown;
}

/** Input that begins an auth flow (doc §14/§19). */
export interface AuthBeginInput {
  method: AuthMethod;
  accountId?: string;
}

/**
 * What a definition's [ChannelDefinition.beginAuth] returns (doc §14/§19).
 * Provider-specific and host-only. [providerState] is opaque and handed back
 * verbatim to [ChannelDefinition.pollAuth] / [ChannelDefinition.submitAuthInput].
 */
export interface AuthProviderSession {
  provider: string;
  expiresAt: number;
  pollingIntervalMs: number;
  qr?: PublicQrPayload;
  prompt?: PublicAuthPrompt;
  deviceCode?: string;
  /** Opaque provider state; pollAuth/submitAuthInput receive this object back. */
  providerState: unknown;
}

/** Auth input submitted during a flow (e.g. a verification code). */
export interface AuthInput {
  kind: 'verification-code';
  value: string;
}

/** One selectable setup field of a channel (doc §29). */
export interface ChannelSetupField {
  name: string;
  kind: 'text' | 'secret';
  secret: boolean;
  configured: boolean;
  writable: boolean;
  /**
   * Credential reference name for secret fields (doc §31). The web layer
   * never sees this — the control plane maps a field name to its ref and
   * calls ctx.credentials. Non-secret fields omit it.
   */
  ref?: string;
  /**
   * Current value for NON-secret fields only (doc §29). Populated dynamically
   * by ChannelControlService.getSetup from ConfiguredState; secret fields never
   * carry it, and static definition.setup.fields leave it undefined.
   */
  value?: string;
}

/** Static setup descriptor advertising a channel's editable surface (doc §29). */
export interface ChannelSetupDescriptor {
  fields: ChannelSetupField[];
  authMethods: AuthMethod[];
  /** Optional official console where users obtain the required credentials. */
  setupUrl?: string;
}

/** One-shot setup payload used by the Web form. Secret values stay host-side. */
export interface ChannelSetupInput {
  config: Record<string, unknown>;
  credentials: Record<string, string>;
  /**
   * Whether a successful save immediately reconciles the channel runtime.
   * Defaults to true. Interactive authorization can persist prerequisite
   * credentials first, then start the provider auth flow without mounting an
   * adapter that is not authorized yet.
   */
  reconcile?: boolean;
}

/** Result of saving setup and reconciling the channel runtime. */
export interface ChannelSetupResult {
  configured: boolean;
  connection: ChannelRuntimeStatus['connection'];
}

/**
 * Dynamic configured state: never returns secret values (doc §14/§29).
 * Per-field `value` carries non-secret config values only (e.g. appId/clientId);
 * secret fields never set it.
 */
export interface ConfiguredState {
  configured: boolean;
  fields: Record<string, { configured: boolean; writable: boolean; source?: string; value?: string }>;
}

/**
 * Runtime status of one mounted (or not) channel (doc §60 / ChannelSummary).
 */
export interface ChannelRuntimeStatus {
  mounted: boolean;
  running: boolean;
  connection: 'connected' | 'degraded' | 'disconnected' | 'unknown';
  health?: ChannelHealth | null;
  lastError?: string | null;
}

/**
 * How a channel determines its local operator / owner identity (plan §10, §24).
 * - `account`: the domain account is identified up front (e.g. Weixin's
 *   scanning QR userId); owner is bootstrapped automatically.
 * - `claim`: no upfront identity; the owner identifies themselves via the
 *   reserved `/dsh-claim` flow.
 * - `manual`: the owner is assigned manually by the operator.
 * - `platform`: the platform restricts private messages to the bot creator;
 *   no local owner claim is needed.
 */
export type OwnerDiscoveryMode = 'account' | 'claim' | 'manual' | 'platform';

/**
 * Declared access capability of a channel (plan §10). Adapters publish it; the
 * control plane and harness use it to decide what a policy may express and
 * whether owner bootstrap applies.
 */
export interface ChannelAccessDescriptor {
  directMessages: boolean;
  groups: boolean;
  mentions: boolean;
  ownerDiscovery: OwnerDiscoveryMode;
  identityLabels: { user: string; group?: string };
  defaults?: { requireMention?: boolean };
}

/**
 * High-level access state of a channel (plan §27), surfaced to the Web control
 * plane so an operator can see at a glance why inbound is gated.
 */
export type ChannelAccessReadiness =
  | 'ready'
  | 'needs-owner'
  | 'missing-policy'
  | 'invalid-policy';

/**
 * Full access picture for one channel+account (plan §27). The `policy` carries
 * canonical sender/group IDs — never any secret — because these are exactly what
 * the operator edits in the ACL.
 */
export interface ChannelAccessState {
  descriptor: ChannelAccessDescriptor;
  readiness: ChannelAccessReadiness;
  policy?: ChannelAccessPolicy;
  owner: { configured: boolean; id?: string; source?: 'account' | 'claim' | 'manual' };
}

/**
 * Lifecycle phase of a local owner-claim session (plan §21).
 * - `waiting-message`: a challenge is outstanding; no valid candidate yet.
 * - `candidate`: a valid DM reply carried the exact challenge code.
 * - `confirmed`: the local operator confirmed the candidate (owner persisted).
 * - `expired`: TTL passed before confirmation.
 * - `cancelled`: the local operator cancelled the session.
 */
export type OwnerClaimPhase =
  | 'waiting-message'
  | 'candidate'
  | 'confirmed'
  | 'expired'
  | 'cancelled';

/**
 * Browser-facing owner-claim session (plan §21). This is the ONLY claim DTO
 * surfaced outside the host. `challengeCode` is a short one-time challenge the
 * local browser shows the operator who then sends it to the bot; it is NOT a
 * platform credential and must never be logged.
 */
export interface PublicOwnerClaimSession {
  id: string;
  channelId: string;
  accountId: string;
  phase: OwnerClaimPhase;
  /** Short one-time challenge the local browser shows the operator. NOT a credential. */
  challengeCode?: string;
  expiresAt: number;
  candidate?: { senderId: string };
}

/** Row returned by [ChannelControlService.listChannels] (doc §29). */
export interface ChannelSummary {
  id: string;
  configured: boolean;
  enabled: boolean;
  mounted: boolean;
  runtime: 'running' | 'stopped';
  connection: 'connected' | 'degraded' | 'disconnected' | 'unknown';
  /** Access readiness of the channel (plan §28). */
  access: ChannelAccessReadiness;
}

/**
 * One channel's setup/authorization/instantiation spec (doc §14). Platform
 * differences stop here: channel-control drives channels purely through this
 * interface, never through per-channel conditionals.
 */
export interface ChannelDefinition {
  id: string;
  /**
   * Whether the channel is enabled in configuration (doc §29 ChannelSummary.enabled).
   *
   * Implementations MUST expose this as a live getter over their mutable
   * config snapshot (e.g. `get enabled() { return state.enabled }`), never as
   * a registration-time snapshot — the control plane's `setEnabled` reads it
   * again after persisting a change.
   */
  readonly enabled: boolean;
  /**
   * Persist the enabled intent (doc §21). Implementations mutate their
   * config snapshot and push through their durable store (settings scope /
   * credentials seam). The control plane reacts by stopping the runtime when
   * disabled or starting it when re-enabled (doc §22). Optional for
   * definitions that are permanently enabled.
   */
  setEnabled?(enabled: boolean): Promise<void>;
  /** Static setup descriptor (fields + authMethods). */
  setup: ChannelSetupDescriptor;
  /**
   * Dynamic configured state: reads config + credential describe().
   * NEVER returns secret values.
   */
  getConfiguredState(): Promise<ConfiguredState>;
  /**
   * Persist a non-secret config patch. Secret field names are rejected by the
   * control plane before reaching the definition (see saveConfig rules).
   */
  saveConfig(patch: Record<string, unknown>): Promise<void>;
  /**
   * Optional host-only snapshot/restore hooks for transactional setup updates.
   * Definitions with mutable config implement both methods so a failed adapter
   * restart can restore the exact prior runtime configuration.
   */
  snapshotConfig?(): unknown;
  restoreConfig?(snapshot: unknown): Promise<void> | void;
  /** Begin an auth session (optional: channels without provider auth omit). */
  beginAuth?(input: AuthBeginInput): Promise<AuthProviderSession>;
  /** Poll a provider session (optional). Receives the SAME AuthProviderSession returned by beginAuth. */
  pollAuth?(session: AuthProviderSession): Promise<PublicAuthStatus>;
  /** Submit auth input (verification code etc.) (optional). */
  submitAuthInput?(
    session: AuthProviderSession,
    input: AuthInput,
  ): Promise<PublicAuthStatus> | void;
  /** Build the adapter; resolves credentials itself via the injected credentials seam. */
  createAdapter(): Promise<ChannelAdapter>;
  /** Whether this channel should auto-mount when configured (headless, doc §27). Default true. */
  autoStart?: boolean;
  /** Required: declared access capability descriptor (execution plan §10). */
  access: ChannelAccessDescriptor;
  /**
   * Only implemented by ownerDiscovery='account' channels. Returns the canonical
   * sender.id of the account owner (e.g. Weixin's scanning QR userId). Never
   * exposes platform storage format to the control plane.
   */
  resolveOwnerIdentity?(accountId: string): Promise<string | undefined>;
}

export type { ChannelAdapter, ChannelHealth };
