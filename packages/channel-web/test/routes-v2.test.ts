/**
 * v2 control-plane routes integration tests (M4-M5 host side).
 *
 * Drives the REAL prefix handler produced by apply() over a real node:http
 * server, backed by a fake ChannelControlLike (with per-method spies). Covers
 * doc §29–§33: channel list, setup descriptor, combined setup save, legacy
 * config/credential writes, auth session lifecycle,
 * the ControlError→HTTP status mapping, and the security surface (loopback,
 * JSON, 64 KiB cap).
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ControlError } from '@wsz987/channel-control';
import type {
  ChannelSetupDescriptor,
  ChannelSummary,
  PublicAuthSession,
} from '@wsz987/channel-control';
import { apply } from '../src/index.js';
import type { ChannelControlLike } from '../src/host/routes-v2.js';

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

const KNOWN = 'qq';
const UNKNOWN = 'nope';

const SETUP: ChannelSetupDescriptor = {
  fields: [
    { name: 'appId', kind: 'text', secret: false, configured: false, writable: true },
    { name: 'appSecret', kind: 'secret', secret: true, configured: true, writable: true },
  ],
  authMethods: [],
  setupUrl: 'https://q.qq.com/qqbot/openclaw/',
};

const CONFIGURED = {
  configured: true,
  fields: {
    appId: { configured: false, writable: true },
    appSecret: { configured: true, writable: true },
  },
};

interface Fakes {
  control: ChannelControlLike;
  calls: {
    listChannels: number;
    setup: string[];
    configuredState: string[];
    saveConfig: Array<[string, Record<string, unknown>]>;
    saveCredential: Array<[string, string, string]>;
    applySetup: Array<[string, { config: Record<string, unknown>; credentials: Record<string, string> }]>;
    setEnabled: Array<[string, boolean]>;
    beginAuth: Array<[string, unknown]>;
    pollAuth: string[];
    submitInput: Array<[string, unknown]>;
    cancelAuth: string[];
  };
}

function makeControl(
  overrides: Partial<{
    pollAuth: (sessionId: string) => Promise<unknown>;
    saveConfig: (channelId: string, patch: Record<string, unknown>) => Promise<void>;
  }> = {},
): Fakes {
  const calls: Fakes['calls'] = {
    listChannels: 0,
    setup: [],
    configuredState: [],
    saveConfig: [],
    saveCredential: [],
    applySetup: [],
    setEnabled: [],
    beginAuth: [],
    pollAuth: [],
    submitInput: [],
    cancelAuth: [],
  };
  const requireKnown = (channelId: string): void => {
    if (channelId !== KNOWN) throw new ControlError('CONTROL_DEFINITION_NOT_FOUND');
    calls.setup.push(channelId);
  };
  const control: ChannelControlLike = {
    async listChannels() {
      calls.listChannels += 1;
      const rows: ChannelSummary[] = [
        { id: KNOWN, configured: true, enabled: true, mounted: true, runtime: 'running', connection: 'connected' },
      ];
      return rows;
    },
    async setEnabled(channelId, enabled) {
      requireKnown(channelId);
      calls.setEnabled.push([channelId, enabled]);
      return {
        id: channelId,
        configured: true,
        enabled,
        mounted: enabled,
        runtime: enabled ? 'running' : 'stopped',
        connection: enabled ? 'connected' : 'unknown',
      };
    },
    async getSetup(channelId) {
      requireKnown(channelId);
      return SETUP;
    },
    async getConfiguredState(channelId) {
      requireKnown(channelId);
      calls.configuredState.push(channelId);
      return CONFIGURED;
    },
    async saveConfig(channelId, patch) {
      requireKnown(channelId);
      calls.saveConfig.push([channelId, patch]);
      if (overrides.saveConfig) return overrides.saveConfig(channelId, patch);
      for (const key of Object.keys(patch)) {
        if (key.endsWith('Secret') || key.endsWith('secret') || key.endsWith('Token') || key.endsWith('token')) {
          throw new ControlError('SECRET_FIELD_REJECTED', 'secret fields must go through the credentials seam');
        }
      }
    },
    async describeCredential(_channelId, field) {
      return { configured: field === 'appSecret', writable: true };
    },
    async saveCredential(channelId, field, value) {
      requireKnown(channelId);
      calls.saveCredential.push([channelId, field, value]);
      return { configured: true, writable: true };
    },
    async applySetup(channelId, input) {
      requireKnown(channelId);
      calls.applySetup.push([channelId, input]);
      return { configured: true, connection: 'connected' };
    },
    async beginAuth(channelId, input) {
      requireKnown(channelId);
      calls.beginAuth.push([channelId, input]);
      const session: PublicAuthSession = {
        id: 'session-1',
        channelId,
        state: 'pending',
        phase: 'waiting-scan',
        expiresAt: Date.now() + 300_000,
      };
      return session;
    },
    async pollAuth(sessionId) {
      calls.pollAuth.push(sessionId);
      if (overrides.pollAuth) return (await overrides.pollAuth(sessionId)) as never;
      return { state: 'pending', phase: 'waiting-scan' };
    },
    async submitAuthInput(sessionId, input) {
      calls.submitInput.push([sessionId, input]);
      return { state: 'pending', phase: 'verification-required' };
    },
    async cancelAuth(sessionId) {
      calls.cancelAuth.push(sessionId);
    },
  };
  return { control, calls };
}

/**
 * Capture the /dsh-channels/api/v2 handler registered by apply() over a fake
 * ctx (mirrors the v1 helper in routes.test.ts, but returns the v2 handler).
 */
function wireV2(control: ChannelControlLike): Handler {
  const handlersByPath = new Map<string, Handler>();
  const fakeWebServer = {
    register(opts: { kind: string; path: string; handler: Handler }) {
      handlersByPath.set(opts.path, opts.handler);
      return () => {};
    },
  };
  const fakeCtx = {
    inject(_deps: unknown, cb: (webCtx: Record<string, unknown>) => unknown) {
      return cb({ webServer: fakeWebServer, channels: {}, channelControl: control });
    },
    get(name: string) {
      return name === 'channelControl' ? control : undefined;
    },
  };
  apply(fakeCtx as never);
  const captured = handlersByPath.get('/dsh-channels/api/v2');
  if (!captured) throw new Error('v2 handler was not captured');
  return captured;
}

// ---- shared real-server wiring for the happy-path suite --------------------

let server: http.Server;
let base: string;
let sharedFakes: Fakes;

beforeAll(async () => {
  sharedFakes = makeControl();
  const handler = wireV2(sharedFakes.control);
  server = http.createServer((req, res) => {
    void handler(req as IncomingMessage, res as ServerResponse);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  base = 'http://127.0.0.1:' + addr.port + '/dsh-channels/api/v2';
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(base + path, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function fakeRes() {
  const state: { status?: number; body?: string } = {};
  const res = {
    writeHead(status: number) {
      state.status = status;
    },
    end(payload: string) {
      state.body = payload;
    },
    getData(): { status: number; body: unknown } {
      let body: unknown = state.body;
      try {
        body = state.body ? JSON.parse(state.body) : null;
      } catch {
        body = state.body;
      }
      return { status: state.status ?? 0, body };
    },
  };
  return res;
}

function invokeDirect(h: Handler, req: Record<string, unknown> = {}) {
  const res = fakeRes() as unknown as ServerResponse;
  const full = Object.assign(
    {
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'content-type': 'application/json' },
      url: '/',
      method: 'POST',
    },
    req,
  ) as IncomingMessage & { body?: Buffer | string };

  if (req.body !== undefined) {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body as string);
    (full as unknown as { [Symbol.asyncIterator]?: () => AsyncIterator<Buffer> })[Symbol.asyncIterator] = () => {
      let done = false;
      return {
        next: async (): Promise<IteratorResult<Buffer>> => {
          if (done) return { done: true, value: undefined as unknown as Buffer };
          done = true;
          return { done: false, value: buf };
        },
      };
    };
  }
  return Promise.resolve(h(full, res)).then(() => (res as unknown as { getData(): { status: number; body: unknown } }).getData());
}

const json = (o: unknown) => ({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

describe('GET /channels (doc §29)', () => {
  it('returns { channels: [...] } rows', async () => {
    const { status, body } = await call('/channels');
    expect(status).toBe(200);
    const rows = (body as { channels: Array<Record<string, unknown>> }).channels;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0]).toMatchObject({ id: KNOWN, configured: true, runtime: 'running' });
  });
});

describe('GET /channels/:id/setup (doc §29)', () => {
  it('returns the setup descriptor', async () => {
    const { status, body } = await call('/channels/qq/setup');
    expect(status).toBe(200);
    expect(body).toEqual(SETUP);
  });

  it('unknown channel → 404', async () => {
    const { status, body } = await call('/channels/nope/setup');
    expect(status).toBe(404);
    expect((body as { error?: { code?: string } }).error?.code).toBe('CHANNEL_NOT_FOUND');
  });
});

describe('PATCH /channels/:id/config (doc §30)', () => {
  it('calls saveConfig with a non-secret patch and returns configured state', async () => {
    const { status, body } = await call('/channels/qq/config', json({ appId: 'cli_123' }));
    expect(status).toBe(200);
    expect(sharedFakes.calls.saveConfig).toContainEqual([KNOWN, { appId: 'cli_123' }]);
    expect(body).toMatchObject({ configured: true, fields: expect.any(Object) });
  });

  it('rejects a secret field with 400 SECRET_FIELD_REJECTED', async () => {
    const fresh = makeControl();
    const handler = wireV2(fresh.control);
    const out = await invokeDirect(handler, {
      method: 'PATCH',
      url: '/dsh-channels/api/v2/channels/qq/config',
      body: JSON.stringify({ appSecret: 'topsecret' }),
    });
    expect(out.status).toBe(400);
    expect((out.body as { error?: { code?: string } }).error?.code).toBe('SECRET_FIELD_REJECTED');
  });
});

describe('PUT /channels/:id/enabled (doc §23)', () => {
  it('enable → 200 + summary with runtime started', async () => {
    const fresh = makeControl();
    const handler = wireV2(fresh.control);
    const { status, body } = await invokeDirect(handler, {
      method: 'PUT',
      url: '/dsh-channels/api/v2/channels/qq/enabled',
      body: JSON.stringify({ enabled: true }),
    });
    expect(status).toBe(200);
    expect(fresh.calls.setEnabled).toEqual([[KNOWN, true]]);
    expect(body).toMatchObject({ id: KNOWN, enabled: true, mounted: true, runtime: 'running' });
  });

  it('disable → 200 + summary with runtime stopped', async () => {
    const fresh = makeControl();
    const handler = wireV2(fresh.control);
    const { status, body } = await invokeDirect(handler, {
      method: 'PUT',
      url: '/dsh-channels/api/v2/channels/qq/enabled',
      body: JSON.stringify({ enabled: false }),
    });
    expect(status).toBe(200);
    expect(fresh.calls.setEnabled).toEqual([[KNOWN, false]]);
    expect(body).toMatchObject({ id: KNOWN, enabled: false, mounted: false, runtime: 'stopped' });
  });

  it('non-boolean body → 400 INVALID_INPUT', async () => {
    const fresh = makeControl();
    const handler = wireV2(fresh.control);
    const out = await invokeDirect(handler, {
      method: 'PUT',
      url: '/dsh-channels/api/v2/channels/qq/enabled',
      body: JSON.stringify({ enabled: 'yes' }),
    });
    expect(out.status).toBe(400);
    expect((out.body as { error?: { code?: string } }).error?.code).toBe('INVALID_INPUT');
    expect(fresh.calls.setEnabled).toEqual([]);
  });

  it('missing boolean body → 400 INVALID_INPUT', async () => {
    const fresh = makeControl();
    const handler = wireV2(fresh.control);
    const out = await invokeDirect(handler, {
      method: 'PUT',
      url: '/dsh-channels/api/v2/channels/qq/enabled',
      body: '{}',
    });
    expect(out.status).toBe(400);
    expect(fresh.calls.setEnabled).toEqual([]);
  });

  it('unknown channel → 404 CHANNEL_NOT_FOUND', async () => {
    const fresh = makeControl();
    const handler = wireV2(fresh.control);
    const { status, body } = await invokeDirect(handler, {
      method: 'PUT',
      url: '/dsh-channels/api/v2/channels/nope/enabled',
      body: JSON.stringify({ enabled: true }),
    });
    expect(status).toBe(404);
    expect((body as { error?: { code?: string } }).error?.code).toBe('CHANNEL_NOT_FOUND');
  });

  it('unsupported control plane → 400 ENABLE_NOT_SUPPORTED', async () => {
    const fresh = makeControl();
    fresh.control.setEnabled = async () => {
      throw new ControlError('ENABLE_NOT_SUPPORTED', 'channel has no setEnabled');
    };
    const handler = wireV2(fresh.control);
    const { status, body } = await invokeDirect(handler, {
      method: 'PUT',
      url: '/dsh-channels/api/v2/channels/qq/enabled',
      body: JSON.stringify({ enabled: true }),
    });
    expect(status).toBe(400);
    expect((body as { error?: { code?: string } }).error?.code).toBe('ENABLE_NOT_SUPPORTED');
  });
});

describe('PUT /channels/:id/credentials/:field (doc §31)', () => {
  it('calls saveCredential and never echoes the value', async () => {
    const fresh = makeControl();
    const handler = wireV2(fresh.control);
    const { status, body } = await invokeDirect(handler, {
      method: 'PUT',
      url: '/dsh-channels/api/v2/channels/qq/credentials/appSecret',
      body: JSON.stringify({ value: 's3cret-value' }),
    });
    expect(status).toBe(200);
    expect(fresh.calls.saveCredential).toEqual([[KNOWN, 'appSecret', 's3cret-value']]);
    expect('value' in (body as Record<string, unknown>)).toBe(false);
    expect(JSON.stringify(body)).not.toContain('s3cret-value');
    expect(body).toMatchObject({ configured: true, writable: true });
  });
});

describe('PUT /channels/:id/setup', () => {
  it('submits config and credentials in one action', async () => {
    const fresh = makeControl();
    const handler = wireV2(fresh.control);
    const input = { config: { appId: '102345678' }, credentials: { appSecret: 's3cret-value' } };
    const { status, body } = await invokeDirect(handler, {
      method: 'PUT',
      url: '/dsh-channels/api/v2/channels/qq/setup',
      body: JSON.stringify(input),
    });
    expect(status).toBe(200);
    expect(fresh.calls.applySetup).toEqual([[KNOWN, input]]);
    expect(body).toEqual({ configured: true, connection: 'connected' });
    expect(JSON.stringify(body)).not.toContain('s3cret-value');
  });

  it('forwards an explicit deferred runtime reconciliation request', async () => {
    const fresh = makeControl();
    const handler = wireV2(fresh.control);
    const input = {
      config: { appId: 'cli_123' },
      credentials: { appSecret: 's3cret-value' },
      reconcile: false,
    };
    const { status } = await invokeDirect(handler, {
      method: 'PUT',
      url: '/dsh-channels/api/v2/channels/qq/setup',
      body: JSON.stringify(input),
    });
    expect(status).toBe(200);
    expect(fresh.calls.applySetup).toEqual([[KNOWN, input]]);
  });
});

describe('auth session lifecycle (doc §32)', () => {
  it('POST /channels/qq/auth/sessions → 201 + session id', async () => {
    const fresh = makeControl();
    const handler = wireV2(fresh.control);
    const { status, body } = await invokeDirect(handler, {
      method: 'POST',
      url: '/dsh-channels/api/v2/channels/qq/auth/sessions',
      body: JSON.stringify({ method: 'credentials' }),
    });
    expect(status).toBe(201);
    expect(fresh.calls.beginAuth).toEqual([[KNOWN, { method: 'credentials' }]]);
    expect((body as { id?: string }).id).toBe('session-1');
  });

  it('GET session → pollAuth → status', async () => {
    const fresh = makeControl();
    const handler = wireV2(fresh.control);
    const { status, body } = await invokeDirect(handler, {
      method: 'GET',
      url: '/dsh-channels/api/v2/channels/qq/auth/sessions/session-1',
    });
    expect(status).toBe(200);
    expect(fresh.calls.pollAuth).toEqual(['session-1']);
    expect(body).toMatchObject({ state: 'pending', phase: 'waiting-scan' });
  });

  it('POST session/input → submitAuthInput → status', async () => {
    const fresh = makeControl();
    const handler = wireV2(fresh.control);
    const { status, body } = await invokeDirect(handler, {
      method: 'POST',
      url: '/dsh-channels/api/v2/channels/qq/auth/sessions/session-1/input',
      body: JSON.stringify({ kind: 'verification-code', value: '123456' }),
    });
    expect(status).toBe(200);
    expect(fresh.calls.submitInput).toEqual([['session-1', { kind: 'verification-code', value: '123456' }]]);
    expect(body).toMatchObject({ phase: 'verification-required' });
  });

  it('DELETE session → cancelAuth → 204', async () => {
    const fresh = makeControl();
    const handler = wireV2(fresh.control);
    const { status, body } = await invokeDirect(handler, {
      method: 'DELETE',
      url: '/dsh-channels/api/v2/channels/qq/auth/sessions/session-1',
    });
    expect(status).toBe(204);
    expect(fresh.calls.cancelAuth).toEqual(['session-1']);
    expect(body).toBeNull();
  });
});

describe('runtime lifecycle is not exposed by Web', () => {
  it('POST /channels/qq/restart → 404', async () => {
    const fresh = makeControl();
    const handler = wireV2(fresh.control);
    const { status, body } = await invokeDirect(handler, {
      method: 'POST',
      url: '/dsh-channels/api/v2/channels/qq/restart',
      body: '{}',
    });
    expect(status).toBe(404);
    expect(body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('control-error → HTTP status mapping', () => {
  it('unknown channel → 404', async () => {
    const fresh = makeControl();
    const handler = wireV2(fresh.control);
    const out = await invokeDirect(handler, {
      method: 'GET',
      url: '/dsh-channels/api/v2/channels/nope/setup',
    });
    expect(out.status).toBe(404);
    expect((out.body as { error?: { code?: string } }).error?.code).toBe('CHANNEL_NOT_FOUND');
  });

  it('unknown session → 404', async () => {
    const fresh = makeControl({ pollAuth: async () => { throw new ControlError('AUTH_SESSION_NOT_FOUND'); } });
    const handler = wireV2(fresh.control);
    const out = await invokeDirect(handler, {
      method: 'GET',
      url: '/dsh-channels/api/v2/channels/qq/auth/sessions/ghost',
    });
    expect(out.status).toBe(404);
    expect((out.body as { error?: { code?: string } }).error?.code).toBe('AUTH_SESSION_NOT_FOUND');
  });

  it('expired session → 410', async () => {
    const fresh = makeControl({ pollAuth: async () => { throw new ControlError('AUTH_SESSION_EXPIRED'); } });
    const handler = wireV2(fresh.control);
    const out = await invokeDirect(handler, {
      method: 'GET',
      url: '/dsh-channels/api/v2/channels/qq/auth/sessions/old',
    });
    expect(out.status).toBe(410);
    expect((out.body as { error?: { code?: string } }).error?.code).toBe('AUTH_SESSION_EXPIRED');
  });
});

describe('handler security guards', () => {
  const fresh = makeControl();
  const handler = wireV2(fresh.control);

  it('403 for a non-loopback mutation', async () => {
    const out = await invokeDirect(handler, {
      method: 'POST',
      socket: { remoteAddress: '192.168.1.10' },
      url: '/dsh-channels/api/v2/channels/qq/auth/sessions',
      body: JSON.stringify({ method: 'qr' }),
    });
    expect(out.status).toBe(403);
    expect((out.body as { error?: { code?: string } }).error?.code).toBe('FORBIDDEN');
  });

  it('415 for a non-JSON Content-Type on PATCH', async () => {
    const out = await invokeDirect(handler, {
      method: 'PATCH',
      headers: { 'content-type': 'text/plain' },
      url: '/dsh-channels/api/v2/channels/qq/config',
      body: 'appId=cli_123',
    });
    expect(out.status).toBe(415);
  });

  it('413 for an oversize body over 64 KiB', async () => {
    const big = 'x'.repeat(70 * 1024);
    const out = await invokeDirect(handler, {
      method: 'PUT',
      url: '/dsh-channels/api/v2/channels/qq/credentials/appSecret',
      body: JSON.stringify({ value: big }),
    });
    expect(out.status).toBe(413);
  });
});

describe('v2 control provider lifecycle (HMR)', () => {
  it('resolves the control provider per request: unload degrades to 503, reload is picked up without a stale delegate', async () => {
    const handlersByPath = new Map<string, Handler>();
    const fakeWebServer = {
      register(opts: { kind: string; path: string; handler: Handler }) {
        handlersByPath.set(opts.path, opts.handler);
        return () => {};
      },
    };
    // ctx.get() mirrors Cordis: only the CURRENTLY ACTIVE provider is returned;
    // an unloaded (HMR-removed) provider resolves to undefined.
    let current: ChannelControlLike | undefined;
    const fakeCtx = {
      inject(_deps: unknown, cb: (webCtx: Record<string, unknown>) => unknown) {
        return cb({ webServer: fakeWebServer });
      },
      get(name: string) {
        return name === 'channelControl' ? current : undefined;
      },
    };
    apply(fakeCtx as never);
    const handler = handlersByPath.get('/dsh-channels/api/v2');
    if (!handler) throw new Error('v2 handler was not captured');

    // Provider A serves the first request.
    const a = makeControl();
    current = a.control;
    const first = await invokeDirect(handler, { method: 'GET', url: '/dsh-channels/api/v2/channels' });
    expect(first.status).toBe(200);
    expect(a.calls.listChannels).toBe(1);

    // HMR unload of the control plugin: no active provider -> 503, never a stale call.
    current = undefined;
    const unloaded = await invokeDirect(handler, { method: 'GET', url: '/dsh-channels/api/v2/channels' });
    expect(unloaded.status).toBe(503);
    expect(a.calls.listChannels).toBe(1);

    // HMR reload provides a NEW object: the next request must hit the new
    // provider — the API wrapper must not keep delegating to provider A.
    const b = makeControl();
    current = b.control;
    const reloaded = await invokeDirect(handler, { method: 'GET', url: '/dsh-channels/api/v2/channels' });
    expect(reloaded.status).toBe(200);
    expect(b.calls.listChannels).toBe(1);
    expect(a.calls.listChannels).toBe(1);
  });
});
