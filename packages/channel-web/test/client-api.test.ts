import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginOwnerClaim,
  confirmOwnerClaim,
} from '../src/client/api.js';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Owner Claim client requests', () => {
  it.each([
    ['begin', () => beginOwnerClaim('qq')],
    ['confirm', () => confirmOwnerClaim('qq', 'claim-1')],
  ])('%s sends an explicit empty JSON body', async (_name, invoke) => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await invoke();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
  });
});
