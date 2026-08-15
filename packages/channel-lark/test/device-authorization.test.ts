import { describe, expect, it, vi } from 'vitest';
import type { AuthProviderSession } from '@wsz987/channel-control';
import { pollLarkDeviceAuthorization } from '../src/auth/device-authorization.js';

const session: AuthProviderSession = {
  provider: 'lark-device-authorization',
  expiresAt: Date.now() + 180_000,
  pollingIntervalMs: 3000,
  providerState: {
    brand: 'feishu',
    appId: 'cli_test',
    appSecret: 'TEST_APP_SECRET_PLACEHOLDER',
    deviceCode: 'device-test',
    scope: 'offline_access',
  },
};

describe('pollLarkDeviceAuthorization', () => {
  it('falls back to the alternate device-code grant form accepted by the provider', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'unsupported_grant_type' }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'test-access-token' }), { status: 200 }));

    const status = await pollLarkDeviceAuthorization(session, { fetcher });

    expect(status).toMatchObject({ state: 'authenticated', phase: 'authorized' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const firstBody = new URLSearchParams(String(fetcher.mock.calls[0]![1]?.body));
    const secondBody = new URLSearchParams(String(fetcher.mock.calls[1]![1]?.body));
    expect(firstBody.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    expect(secondBody.get('grant_type')).toBe('device_code');
  });
});
