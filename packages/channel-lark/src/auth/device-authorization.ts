import {
  ControlError,
  type AuthProviderSession,
  type PublicAuthStatus,
} from '@wsz987/channel-control';
import { z } from 'zod';

const deviceAuthorizationResponseSchema = z
  .object({
    device_code: z.string().trim().min(1).optional(),
    verification_uri_complete: z.string().trim().min(1).optional(),
    verification_uri: z.string().trim().min(1).optional(),
    expires_in: z.number().positive().optional(),
    interval: z.number().positive().optional(),
    error: z.string().trim().min(1).optional(),
    error_description: z.string().trim().min(1).optional(),
  })
  .passthrough();

const tokenResponseSchema = z
  .object({
    access_token: z.string().trim().min(1).optional(),
    refresh_token: z.string().trim().min(1).optional(),
    error: z.string().trim().min(1).optional(),
    error_description: z.string().trim().min(1).optional(),
    code: z.union([z.string(), z.number()]).optional(),
    msg: z.string().trim().min(1).optional(),
  })
  .passthrough();

const providerStateSchema = z.object({
  brand: z.enum(['feishu', 'lark']),
  appId: z.string().trim().min(1),
  appSecret: z.string().trim().min(1),
  deviceCode: z.string().trim().min(1),
  scope: z.string().trim().min(1),
});

type DeviceAuthorizationResponse = z.infer<typeof deviceAuthorizationResponseSchema>;
type TokenResponse = z.infer<typeof tokenResponseSchema>;
type ProviderState = z.infer<typeof providerStateSchema>;

export interface LarkDeviceAuthorizationOptions {
  appId: string;
  appSecret: string;
  domain?: string;
  fetcher?: typeof fetch;
}

function authError(message: string, cause?: unknown): ControlError {
  return new ControlError(
    'CONTROL_ERROR',
    message,
    cause === undefined ? undefined : { cause },
  );
}

function endpoint(domain: string | undefined, resource: 'device_authorization' | 'token'): string {
  return domain === 'lark'
    ? `https://accounts.larksuite.com/oauth/v1/${resource}`
    : `https://accounts.feishu.cn/oauth/v1/${resource}`;
}

function tokenEndpoints(brand: ProviderState['brand']): string[] {
  return brand === 'lark'
    ? [
        'https://accounts.larksuite.com/oauth/v1/token',
        'https://open.larksuite.com/open-apis/authen/v2/oauth/token',
      ]
    : [
        'https://accounts.feishu.cn/oauth/v1/token',
        'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
      ];
}

async function readJson(response: Response, provider: string): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw authError(`${provider} authorization returned invalid JSON`, error);
  }
}

function parseDeviceResponse(value: unknown): DeviceAuthorizationResponse {
  const parsed = deviceAuthorizationResponseSchema.safeParse(value);
  if (!parsed.success) throw authError('lark device authorization returned an invalid response', parsed.error);
  return parsed.data;
}

function parseTokenResponse(value: unknown): TokenResponse {
  const parsed = tokenResponseSchema.safeParse(value);
  if (!parsed.success) throw authError('lark authorization polling returned an invalid response', parsed.error);
  return parsed.data;
}

function parseProviderState(value: unknown): ProviderState {
  const parsed = providerStateSchema.safeParse(value);
  if (!parsed.success) throw authError('lark auth session is missing provider state', parsed.error);
  return parsed.data;
}

/** Begin Feishu/Lark device authorization. Secrets remain in opaque host state. */
export async function beginLarkDeviceAuthorization(
  options: LarkDeviceAuthorizationOptions,
): Promise<AuthProviderSession> {
  const appId = options.appId.trim();
  const appSecret = options.appSecret.trim();
  if (!appId || !appSecret) throw new ControlError('AUTH_NOT_READY', 'lark QR authorization requires configured appId and appSecret');
  const fetcher = options.fetcher ?? fetch;
  const brand = options.domain === 'lark' ? 'lark' : 'feishu';
  const scope = 'offline_access';
  let response: Response;
  try {
    response = await fetcher(endpoint(options.domain, 'device_authorization'), {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ client_id: appId, scope }).toString(),
    });
  } catch (error) {
    throw authError('lark device authorization request failed', error);
  }
  const payload = parseDeviceResponse(await readJson(response, 'lark'));
  if (!response.ok || payload.error) throw authError('lark device authorization request failed');
  const deviceCode = payload.device_code;
  const completeUrl = payload.verification_uri_complete ?? payload.verification_uri;
  if (!deviceCode || !completeUrl) throw authError('lark did not return a device authorization challenge');
  const expiresAt = Date.now() + (payload.expires_in ?? 240) * 1000;
  const providerState: ProviderState = { brand, appId, appSecret, deviceCode, scope };
  return {
    provider: 'lark-device-authorization',
    expiresAt,
    pollingIntervalMs: Math.max(3000, (payload.interval ?? 5) * 1000),
    qr: { kind: 'content', value: completeUrl, expiresAt },
    prompt: { kind: 'confirm-on-phone', message: '请使用飞书/Lark 扫码并确认授权' },
    deviceCode,
    providerState,
  };
}

/** Poll a device authorization session without exposing provider tokens. */
export async function pollLarkDeviceAuthorization(
  session: AuthProviderSession,
  options: Pick<LarkDeviceAuthorizationOptions, 'fetcher'> = {},
): Promise<PublicAuthStatus> {
  const provider = parseProviderState(session.providerState);
  const fetcher = options.fetcher ?? fetch;
  const attempts: Array<Record<string, string>> = [
    { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: provider.deviceCode, client_id: provider.appId },
    { grant_type: 'device_code', device_code: provider.deviceCode, client_id: provider.appId },
    { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: provider.deviceCode },
    { grant_type: 'device_code', device_code: provider.deviceCode },
  ];
  let lastError: unknown;
  for (const tokenUrl of tokenEndpoints(provider.brand)) {
    for (const attempt of attempts) {
      let response: Response;
      try {
        response = await fetcher(tokenUrl, {
          method: 'POST',
          headers: {
            authorization: `Basic ${Buffer.from(`${provider.appId}:${provider.appSecret}`).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(attempt).toString(),
        });
      } catch (error) {
        lastError = error;
        continue;
      }
      let payload: TokenResponse;
      try {
        payload = parseTokenResponse(await readJson(response, 'lark'));
      } catch (error) {
        lastError = error;
        continue;
      }
      if (response.ok && (payload.access_token || payload.refresh_token)) {
        return { state: 'authenticated', phase: 'authorized', expiresAt: session.expiresAt, detail: '飞书/Lark 扫码授权已完成' };
      }
      const code = payload.error ?? (payload.code === undefined ? '' : String(payload.code));
      if (code === 'authorization_pending' || code === 'slow_down') {
        return { state: 'pending', phase: 'waiting-scan', expiresAt: session.expiresAt, detail: '等待飞书/Lark 扫码授权中' };
      }
      if (code === 'expired_token' || code === 'invalid_grant' || response.status === 401) {
        return { state: 'expired', phase: 'expired', expiresAt: session.expiresAt, detail: '二维码已失效，请重新生成' };
      }
      lastError = new Error(payload.error_description ?? payload.msg ?? `HTTP ${response.status}`);
    }
  }
  throw authError('lark authorization polling failed', lastError);
}
