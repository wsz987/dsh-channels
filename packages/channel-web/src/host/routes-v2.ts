/**
 * dsh-channels host API v2 control-plane routes (M4-M5 host side).
 *
 * Lives on `/dsh-channels/api/v2` and delegates every operation to the
 * ChannelControlService (doc §28–§33). This is deliberately a THIN layer:
 *
 * ```text
 * HTTP → validate (strict schema) → ChannelControlLike → serialize public DTO
 * ```
 *
 * The web layer never knows credential ref names: setup descriptors carry
 * credential fields, and `saveCredential` maps a field name to its ref
 * server-side (doc §31). Secret values are never echoed — the credential PUT
 * returns only `{ configured, writable }`.
 *
 * The service is injected as a structural seam ([ChannelControlLike]) so this
 * package ships no hard dependency on the concrete control-plane plugin; when
 * the seam is absent (standalone web profile) the caller registers a 503 stub
 * instead.
 */
import type {
  AuthBeginInput,
  AuthInput,
  AuthMethod,
  ChannelSetupDescriptor,
  ChannelSetupInput,
  ChannelSetupResult,
  ChannelSummary,
  ConfiguredState,
  PublicAuthSession,
  PublicAuthStatus,
} from '@wsz987/channel-control';
import { isChannelError } from '@wsz987/channel-core';
import { isControlError } from '@wsz987/channel-control';
import { errorBody } from './security.js';

/** Minimal structural view of the ChannelControlService surface we consume. */
export interface ChannelControlLike {
  listChannels(): Promise<ChannelSummary[]>;
  getSetup(channelId: string): Promise<ChannelSetupDescriptor>;
  getConfiguredState(channelId: string): Promise<ConfiguredState>;
  saveConfig(channelId: string, patch: Record<string, unknown>): Promise<void>;
  describeCredential(
    channelId: string,
    field: string,
  ): Promise<{ configured: boolean; writable: boolean; source?: string }>;
  saveCredential(
    channelId: string,
    field: string,
    value: string,
  ): Promise<{ configured: boolean; writable: boolean }>;
  applySetup(channelId: string, input: ChannelSetupInput): Promise<ChannelSetupResult>;
  beginAuth(channelId: string, input: AuthBeginInput): Promise<PublicAuthSession>;
  pollAuth(sessionId: string): Promise<PublicAuthStatus>;
  submitAuthInput(sessionId: string, input: AuthInput): Promise<PublicAuthStatus>;
  cancelAuth(sessionId: string): Promise<void>;
}

export interface ApiResultV2 {
  status: number;
  body: unknown;
}

const AUTH_METHODS: readonly AuthMethod[] = [
  'qr',
  'device',
  'portal-login',
  'credentials',
  'hybrid',
] as const;

/** URL-decode safety: decodeURIComponent of malformed escapes is a URIError. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate that a value is a non-empty string, or a 400 result. */
function requireString(
  value: unknown,
  field: string,
): { ok: true; value: string } | { ok: false; result: ApiResultV2 } {
  if (typeof value !== 'string' || !value) {
    return {
      ok: false,
      result: { status: 400, body: errorBody('INVALID_INPUT', field + ' must be a non-empty string') },
    };
  }
  return { ok: true, value };
}

/**
 * Map a control-plane error to an HTTP status + structured body. Unknown
 * channels surface as 404; expired sessions as 410; every other recognized
 * control code gets 400; anything unexpected becomes a redacted 500.
 */
function mapControlError(error: unknown): ApiResultV2 {
  if (isControlError(error)) {
    switch (error.code) {
      case 'CONTROL_DEFINITION_NOT_FOUND':
      case 'UNKNOWN_FIELD':
      case 'AUTH_SESSION_NOT_FOUND':
      case 'AUTH_SESSION_CANCELLED':
        return { status: 404, body: errorBody(error.code, error.message) };
      case 'AUTH_SESSION_EXPIRED':
        return { status: 410, body: errorBody(error.code, error.message) };
      case 'SECRET_FIELD_REJECTED':
      case 'NOT_A_SECRET_FIELD':
      case 'INVALID_CREDENTIAL':
      case 'CREDENTIAL_READONLY':
      case 'CREDENTIAL_NOT_SUPPORTED':
      case 'AUTH_NOT_SUPPORTED':
      case 'AUTH_NOT_READY':
        return { status: 400, body: errorBody(error.code, error.message) };
      default:
        return {
          status: 500,
          body: errorBody('CONTROL_ERROR', 'channel control failed'),
        };
    }
  }
  if (isChannelError(error)) {
    // The only ChannelError the control surface raises here is an unknown
    // channel ("definition not registered"); map it to 404.
    return {
      status: 404,
      body: errorBody('CONTROL_DEFINITION_NOT_FOUND', 'unknown channel'),
    };
  }
  // Never leak an arbitrary message.
  return { status: 500, body: errorBody('INTERNAL_ERROR', 'internal error') };
}

/** Run `fn` and translate any control-plane throw into an ApiResult. */
async function run<T>(
  fn: () => Promise<T> | T,
  ok: (value: T) => { status: number; body: unknown },
): Promise<ApiResultV2> {
  try {
    const value = await fn();
    return ok(value);
  } catch (error) {
    return mapControlError(error);
  }
}

export class ChannelApiV2 {
  constructor(private readonly control: ChannelControlLike) {}

  /**
   * Resolve whether a channel id exists (via the setup descriptor). Returns a
   * 404 result for unknown channels so every channel-scoped endpoint reports a
   * stable code.
   */
  private async channelOr404(
    channelId: string,
  ): Promise<{ ok: true } | { ok: false; result: ApiResultV2 }> {
    try {
      await this.control.getSetup(channelId);
      return { ok: true };
    } catch (error) {
      if (isControlError(error, 'CONTROL_DEFINITION_NOT_FOUND') || isChannelError(error)) {
        return {
          ok: false,
          result: { status: 404, body: errorBody('CHANNEL_NOT_FOUND', 'unknown channel: ' + channelId) },
        };
      }
      throw error;
    }
  }

  /** GET /channels → { channels: ChannelSummary[] } (doc §29). */
  async listChannels(): Promise<ApiResultV2> {
    return run(
      (): Promise<ChannelSummary[]> => this.control.listChannels(),
      (channels) => ({ status: 200, body: { channels } }),
    );
  }

  /** GET /channels/:channelId/setup → ChannelSetupDescriptor (doc §29). */
  async getSetup(channelId: string): Promise<ApiResultV2> {
    const found = await this.channelOr404(channelId);
    if (!found.ok) return found.result;
    return run(() => this.control.getSetup(channelId), (setup) => ({ status: 200, body: setup }));
  }

  /** PUT /channels/:channelId/setup → save the whole form and reconcile. */
  async applySetup(channelId: string, body: unknown): Promise<ApiResultV2> {
    const found = await this.channelOr404(channelId);
    if (!found.ok) return found.result;
    const input = this.setupInput(body);
    if (!input.ok) return input.result;
    return run(() => this.control.applySetup(channelId, input.value), (result) => ({
      status: 200,
      body: result,
    }));
  }

  /** PATCH /channels/:channelId/config → { configured, fields } (doc §30). */
  async saveConfig(channelId: string, body: unknown): Promise<ApiResultV2> {
    const found = await this.channelOr404(channelId);
    if (!found.ok) return found.result;
    const patch = this.configPatch(body);
    if (!patch.ok) return patch.result;
    const direct = async (): Promise<ConfiguredState> => {
      await this.control.saveConfig(channelId, patch.value);
      return this.control.getConfiguredState(channelId);
    };
    return run(direct, (state) => ({
      status: 200,
      body: { configured: state.configured, fields: state.fields },
    }));
  }

  /** PUT /channels/:channelId/credentials/:field → { configured, writable } (doc §31). */
  async saveCredential(channelId: string, field: string, body: unknown): Promise<ApiResultV2> {
    const found = await this.channelOr404(channelId);
    if (!found.ok) return found.result;
    const value = this.credentialValue(body);
    if (!value.ok) return value.result;
    return run(() => this.control.saveCredential(channelId, field, value.value), (result) => ({
      status: 200,
      body: { configured: result.configured, writable: result.writable },
    }));
  }

  /** POST /channels/:channelId/auth/sessions → 201 PublicAuthSession (doc §32). */
  async beginAuth(channelId: string, body: unknown): Promise<ApiResultV2> {
    const found = await this.channelOr404(channelId);
    if (!found.ok) return found.result;
    const begin = this.authBeginInput(body);
    if (!begin.ok) return begin.result;
    return run(() => this.control.beginAuth(channelId, begin.value), (session) => ({
      status: 201,
      body: session,
    }));
  }

  /** GET /channels/:channelId/auth/sessions/:sessionId → PublicAuthStatus (doc §32). */
  async pollAuth(channelId: string, sessionId: unknown): Promise<ApiResultV2> {
    const found = await this.channelOr404(channelId);
    if (!found.ok) return found.result;
    const sid = requireString(sessionId, 'sessionId');
    if (!sid.ok) return sid.result;
    return run(() => this.control.pollAuth(sid.value), (status) => ({ status: 200, body: status }));
  }

  /** POST /channels/:channelId/auth/sessions/:sessionId/input → PublicAuthStatus (doc §32). */
  async submitInput(channelId: string, sessionId: unknown, body: unknown): Promise<ApiResultV2> {
    const found = await this.channelOr404(channelId);
    if (!found.ok) return found.result;
    const sid = requireString(sessionId, 'sessionId');
    if (!sid.ok) return sid.result;
    const input = this.authInput(body);
    if (!input.ok) return input.result;
    return run(() => this.control.submitAuthInput(sid.value, input.value), (status) => ({
      status: 200,
      body: status,
    }));
  }

  /** DELETE /channels/:channelId/auth/sessions/:sessionId → 204 (doc §32). */
  async cancelAuth(channelId: string, sessionId: unknown): Promise<ApiResultV2> {
    const found = await this.channelOr404(channelId);
    if (!found.ok) return found.result;
    const sid = requireString(sessionId, 'sessionId');
    if (!sid.ok) return sid.result;
    return run(() => this.control.cancelAuth(sid.value), () => ({ status: 204, body: undefined }));
  }

  /**
   * Match a path under `/dsh-channels/api/v2` (the prefix is stripped by the
   * caller) and dispatch. Returns 404 for unknown routes.
   */
  async handle(method: string, pathname: string, body: unknown): Promise<ApiResultV2> {
    const clean = pathname.replace(/\/+$/, '');
    if (method === 'GET' && clean === '/channels') return this.listChannels();

    const setup = /^\/channels\/([^/]+)\/setup$/.exec(clean);
    if (method === 'GET' && setup) return this.getSetup(safeDecode(setup[1]!));
    if (method === 'PUT' && setup) return this.applySetup(safeDecode(setup[1]!), body);

    const config = /^\/channels\/([^/]+)\/config$/.exec(clean);
    if (method === 'PATCH' && config) return this.saveConfig(safeDecode(config[1]!), body);

    const credential = /^\/channels\/([^/]+)\/credentials\/([^/]+)$/.exec(clean);
    if (method === 'PUT' && credential) {
      return this.saveCredential(safeDecode(credential[1]!), safeDecode(credential[2]!), body);
    }

    const begin = /^\/channels\/([^/]+)\/auth\/sessions$/.exec(clean);
    if (method === 'POST' && begin) return this.beginAuth(safeDecode(begin[1]!), body);

    const session = /^\/channels\/([^/]+)\/auth\/sessions\/([^/]+)$/.exec(clean);
    if (session) {
      if (method === 'GET') return this.pollAuth(safeDecode(session[1]!), safeDecode(session[2]!));
      if (method === 'DELETE') return this.cancelAuth(safeDecode(session[1]!), safeDecode(session[2]!));
    }

    const input = /^\/channels\/([^/]+)\/auth\/sessions\/([^/]+)\/input$/.exec(clean);
    if (method === 'POST' && input) {
      return this.submitInput(safeDecode(input[1]!), safeDecode(input[2]!), body);
    }

    return { status: 404, body: errorBody('NOT_FOUND', 'no such endpoint') };
  }

  // ---- strict body schema validation -------------------------------------

  /** PATCH config body: a flat JSON object (never nested). */
  private configPatch(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; result: ApiResultV2 } {
    if (!isRecord(value)) {
      return { ok: false, result: { status: 400, body: errorBody('INVALID_INPUT', 'config patch must be a JSON object') } };
    }
    return { ok: true, value };
  }

  /** PUT credentials body: `{ value: string }`. */
  private credentialValue(body: unknown): { ok: true; value: string } | { ok: false; result: ApiResultV2 } {
    const parsed = isRecord(body) ? body : {};
    return requireString(parsed.value, 'value');
  }

  /** PUT setup body: `{ config: object, credentials: Record<string,string> }`. */
  private setupInput(body: unknown): { ok: true; value: ChannelSetupInput } | { ok: false; result: ApiResultV2 } {
    if (!isRecord(body)) {
      return { ok: false, result: { status: 400, body: errorBody('INVALID_INPUT', 'setup must be a JSON object') } };
    }
    const config = body.config ?? {};
    const credentials = body.credentials ?? {};
    if (!isRecord(config) || !isRecord(credentials)) {
      return { ok: false, result: { status: 400, body: errorBody('INVALID_INPUT', 'config and credentials must be JSON objects') } };
    }
    const secretValues: Record<string, string> = {};
    for (const [field, value] of Object.entries(credentials)) {
      if (typeof value !== 'string' || !value.trim()) {
        return { ok: false, result: { status: 400, body: errorBody('INVALID_INPUT', `credential ${field} must be a non-empty string`) } };
      }
      secretValues[field] = value.trim();
    }
    return { ok: true, value: { config, credentials: secretValues } };
  }

  /** POST auth/sessions body: `{ method: AuthMethod, accountId?: string }`. */
  private authBeginInput(body: unknown): { ok: true; value: AuthBeginInput } | { ok: false; result: ApiResultV2 } {
    const parsed = isRecord(body) ? body : {};
    const method = parsed.method;
    if (typeof method !== 'string' || !(AUTH_METHODS as readonly string[]).includes(method)) {
      return {
        ok: false,
        result: { status: 400, body: errorBody('INVALID_INPUT', 'method must be one of ' + AUTH_METHODS.join(', ')) },
      };
    }
    const account = parsed.accountId;
    if (account !== undefined && (typeof account !== 'string' || !account)) {
      return {
        ok: false,
        result: { status: 400, body: errorBody('INVALID_INPUT', 'accountId must be a non-empty string when present') },
      };
    }
    return { ok: true, value: { method: method as AuthMethod, accountId: account as string | undefined } };
  }

  /** POST session/input body: `{ kind: 'verification-code', value: string }`. */
  private authInput(body: unknown): { ok: true; value: AuthInput } | { ok: false; result: ApiResultV2 } {
    const parsed = isRecord(body) ? body : {};
    if (parsed.kind !== 'verification-code') {
      return { ok: false, result: { status: 400, body: errorBody('INVALID_INPUT', 'kind must be "verification-code"') } };
    }
    const value = requireString(parsed.value, 'value');
    if (!value.ok) return value;
    return { ok: true, value: { kind: 'verification-code', value: value.value } };
  }

}
