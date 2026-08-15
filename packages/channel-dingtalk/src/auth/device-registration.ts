import { ControlError, type AuthProviderSession, type PublicAuthStatus } from '@wsz987/channel-control';
import { z } from 'zod';

const RegistrationEnvelopeSchema = z.object({
  errcode: z.union([z.number(), z.string()]).optional(),
  errmsg: z.string().optional(),
}).passthrough();

const InitResponseSchema = RegistrationEnvelopeSchema.extend({
  nonce: z.string().trim().min(1),
});

const BeginResponseSchema = RegistrationEnvelopeSchema.extend({
  device_code: z.string().trim().min(1),
  verification_uri_complete: z.string().trim().min(1),
  expires_in: z.number().positive().optional(),
  interval: z.number().positive().optional(),
});

const PollResponseSchema = RegistrationEnvelopeSchema.extend({
  status: z.string().trim().min(1).optional(),
  client_id: z.string().trim().min(1).optional(),
  client_secret: z.string().trim().min(1).optional(),
  fail_reason: z.string().optional(),
});

type RegistrationInitResponse = z.infer<typeof InitResponseSchema>;
type RegistrationBeginResponse = z.infer<typeof BeginResponseSchema>;
type RegistrationPollResponse = z.infer<typeof PollResponseSchema>;

export interface DingTalkDeviceAuthOptions {
  baseUrl?: string;
  source?: string;
  fetcher?: typeof fetch;
}

interface DingTalkDeviceProviderState {
  baseUrl: string;
  deviceCode: string;
}

export interface DingTalkDevicePollResult {
  status: PublicAuthStatus;
  credentials?: {
    clientId: string;
    clientSecret: string;
  };
}

const DEFAULT_BASE_URL = 'https://oapi.dingtalk.com';
const DEFAULT_SOURCE = 'DING_DWS_CLAW';

/** Start DingTalk's device registration flow and return only browser-safe data. */
export async function beginDingTalkDeviceAuth(
  options: DingTalkDeviceAuthOptions = {},
): Promise<AuthProviderSession> {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const source = options.source ?? DEFAULT_SOURCE;
  const init = await postRegistration<RegistrationInitResponse>(
    fetcher,
    `${baseUrl}/app/registration/init`,
    { source },
    InitResponseSchema,
  );
  const begin = await postRegistration<RegistrationBeginResponse>(
    fetcher,
    `${baseUrl}/app/registration/begin`,
    { nonce: init.nonce },
    BeginResponseSchema,
  );
  const expiresAt = Date.now() + (begin.expires_in ?? 7200) * 1000;
  return {
    provider: 'dingtalk-registration',
    expiresAt,
    pollingIntervalMs: Math.max(3000, (begin.interval ?? 3) * 1000),
    qr: { kind: 'content', value: begin.verification_uri_complete, expiresAt },
    prompt: { kind: 'confirm-on-phone', message: '请使用手机钉钉扫码并确认授权' },
    deviceCode: begin.device_code,
    providerState: { baseUrl, deviceCode: begin.device_code } satisfies DingTalkDeviceProviderState,
  };
}

/** Poll DingTalk registration; credentials are returned only to the host definition. */
export async function pollDingTalkDeviceAuth(
  session: AuthProviderSession,
  options: DingTalkDeviceAuthOptions = {},
): Promise<DingTalkDevicePollResult> {
  const providerState = parseProviderState(session.providerState);
  const fetcher = options.fetcher ?? fetch;
  const payload = await postRegistration<RegistrationPollResponse>(
    fetcher,
    `${providerState.baseUrl}/app/registration/poll`,
    { device_code: providerState.deviceCode },
    PollResponseSchema,
  );
  const status = (payload.status ?? 'WAITING').toUpperCase();
  if (status === 'WAITING') {
    return {
      status: {
        state: 'pending',
        phase: 'waiting-scan',
        expiresAt: session.expiresAt,
        detail: '等待钉钉扫码授权中',
      },
    };
  }
  if (status === 'SUCCESS') {
    if (!payload.client_id || !payload.client_secret) {
      throw new ControlError('CONTROL_ERROR', 'dingtalk authorization did not return complete credentials');
    }
    return {
      status: {
        state: 'authenticated',
        phase: 'authorized',
        expiresAt: session.expiresAt,
        detail: '钉钉扫码授权已完成，凭证已保存',
      },
      credentials: { clientId: payload.client_id, clientSecret: payload.client_secret },
    };
  }
  if (status === 'FAIL' || status === 'EXPIRED') {
    return {
      status: {
        state: 'expired',
        phase: 'expired',
        expiresAt: session.expiresAt,
        detail: payload.fail_reason ?? payload.errmsg ?? '二维码已失效',
      },
    };
  }
  return {
    status: {
      state: 'pending',
      phase: 'waiting-scan',
      expiresAt: session.expiresAt,
      detail: `当前状态：${status}`,
    },
  };
}

async function postRegistration<T>(
  fetcher: typeof fetch,
  url: string,
  body: Record<string, string>,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new ControlError('CONTROL_ERROR', 'dingtalk authorization request failed', { cause: error });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ControlError('CONTROL_ERROR', 'dingtalk authorization returned invalid JSON', { cause: error });
  }
  const envelope = RegistrationEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    throw new ControlError('CONTROL_ERROR', 'dingtalk authorization returned an invalid response');
  }
  const errcode = envelope.data.errcode;
  if (!response.ok || (errcode !== undefined && String(errcode) !== '0')) {
    throw new ControlError('CONTROL_ERROR', 'dingtalk authorization request failed');
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ControlError('CONTROL_ERROR', 'dingtalk authorization returned an invalid response');
  }
  return parsed.data;
}

function parseProviderState(value: unknown): DingTalkDeviceProviderState {
  const parsed = z.object({
    baseUrl: z.string().url(),
    deviceCode: z.string().trim().min(1),
  }).safeParse(value);
  if (!parsed.success) {
    throw new ControlError('CONTROL_ERROR', 'dingtalk auth session is missing device code');
  }
  return parsed.data;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/$/, '');
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported URL protocol');
    }
  } catch (error) {
    throw new ControlError('CONTROL_ERROR', 'dingtalk registration base URL is invalid', { cause: error });
  }
  return trimmed;
}
