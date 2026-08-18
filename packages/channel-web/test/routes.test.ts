import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { apply } from '../src/index.js';
import type {
  AuthChallenge,
  AuthInput,
  AuthStatePoll,
  ChannelAdapter,
  ChannelHealth,
  ChannelTarget,
  OutboundMessage,
  SendResult,
} from '@wsz987/channel-core';

/**
 * Routes integration tests (M1).
 *
 * Drives the REAL prefix handler produced by apply() over a real node:http
 * server, backed by a fake ctx.channels + fake ChannelAdapter. Captures the
 * registered handler by stubbing ctx.inject. Covers happy paths plus the
 * security surface (403 loopback, 415, 413, schema, 404, expired) and the
 * invariant that challenge payloads/tokens never leave the host.
 */

class FakeAdapter implements ChannelAdapter {
  readonly id = 'weixin';
  readonly capabilities = {
    text: true, image: true, file: false, audio: false, video: false,
    markdown: false, cards: false, reactions: false, threads: false, streaming: 'buffered' as const,
  };
  lastInput?: AuthInput;
  private challengeExpiry: () => number;
  private pollState: string;

  constructor(opts: { expiresAt?: () => number; pollState?: string } = {}) {
    this.challengeExpiry = opts.expiresAt ?? (() => Date.now() + 300_000);
    this.pollState = opts.pollState ?? 'pending';
  }

  async start(_ctx: unknown): Promise<void> {}
  async stop(): Promise<void> {}
  async send(_t: ChannelTarget, _m: OutboundMessage): Promise<SendResult> {
    return { ok: true, id: 'x' };
  }
  async getHealth(): Promise<ChannelHealth> {
    return { status: 'down', detail: 'not authenticated', authenticated: false };
  }
  async beginAuth(): Promise<AuthChallenge> {
    return {
      id: 'challenge-1',
      instruction: 'scan with WeChat',
      qrUrl: 'data:image/png;base64,Q1JMT0FDUkFORE9NRlg=',
      expiresAt: this.challengeExpiry(),
      payload: { token: 'TOPSECRETTOKEN' }, // must never leak
    };
  }
  async pollAuth(_c: AuthChallenge): Promise<AuthStatePoll> {
    if (this.pollState === 'authenticated') return { state: 'authenticated', detail: 'confirmed' };
    if (this.pollState === 'expired') return { state: 'expired', detail: 'expired' };
    if (this.pollState === 'needverify') return { state: 'pending', detail: 'weixin QR requires a phone-verified code' };
    return { state: 'pending', detail: 'waiting for scan' };
  }
  submitAuthInput(_c: AuthChallenge, input: AuthInput): void {
    this.lastInput = input;
  }
}

class NoAuthAdapter implements ChannelAdapter {
  readonly id = 'qq';
  readonly capabilities = { text: true, image: false };
  async start(_ctx: unknown): Promise<void> {}
  async stop(): Promise<void> {}
  async send(_t: ChannelTarget, _m: OutboundMessage): Promise<SendResult> {
    return { ok: true, id: 'x' };
  }
  async getHealth(): Promise<ChannelHealth> {
    return { status: 'unknown', detail: 'no health' };
  }
}

function makeChannels(adapters: ChannelAdapter[]) {
  const map = new Map(adapters.map((a) => [a.id, a] as const));
  return {
    get: (id: string) => map.get(id),
    list: () => [...map.values()],
  };
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

/**
 * Drive the real prefix handlers produced by apply() over a fake ctx. apply()
 * registers both /dsh-channels/api/v1 and /dsh-channels/api/v2; this helper
 * captures every registered handler by path and returns the v1 handler (or an
 * arbitrary registered handler when `path` is supplied).
 */
function wireHandler(adapters: ChannelAdapter[]): Handler {
  const handlersByPath = new Map<string, Handler>();
  const channels = makeChannels(adapters);
  const fakeWebServer = {
    register(opts: { kind: string; path: string; handler: Handler }) {
      handlersByPath.set(opts.path, opts.handler);
      return () => {};
    },
  };
  const fakeCtx = {
    inject(_deps: unknown, cb: (webCtx: Record<string, unknown>) => unknown) {
      return cb({ webServer: fakeWebServer, channels });
    },
    get(_name: string) {
      return undefined; // no channelControl in the v1 suite
    },
  };
  apply(fakeCtx as never);
  const captured = handlersByPath.get('/dsh-channels/api/v1');
  if (!captured) throw new Error('v1 handler was not captured');
  return captured;
}

function fakeRes() {
  const state: { status?: number; body?: string } = {};
  const res = {
    result: undefined as { status: number; body: unknown } | undefined,
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

interface DirectReq {
  method?: string;
  url?: string;
  socket?: { remoteAddress?: string };
  headers?: Record<string, string | undefined>;
  body?: Buffer | string;
}

function invokeDirect(h: Handler, req: DirectReq = {}) {
  const res = fakeRes() as unknown as ServerResponse;
  const full = Object.assign(
    { socket: { remoteAddress: '127.0.0.1' }, headers: { 'content-type': 'application/json' }, url: '/', method: 'POST' },
    req,
  ) as IncomingMessage & { body?: Buffer | string };

  // readJsonBody consumes the request stream; provide an async iterable when a
  // body is supplied (mirrors a real IncomingMessage).
  if (req.body !== undefined) {
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
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

  return Promise.resolve(h(full, res)).then(
    () => (res as unknown as ReturnType<typeof fakeRes>).getData(),
  );
}

let server: http.Server;
let base: string;
const weixin = new FakeAdapter();
const qq = new NoAuthAdapter();

beforeAll(async () => {
  const handler = wireHandler([weixin, qq]);
  server = http.createServer((req, res) => {
    void handler(req as IncomingMessage, res as ServerResponse);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  base = 'http://127.0.0.1:' + addr.port + '/dsh-channels/api/v1';
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

const jsonInit = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
const json = (o: unknown) => ({ ...jsonInit, body: JSON.stringify(o) });

describe('GET /channels', () => {
  const STATUS_ENUM = ['connected', 'degraded', 'unconfigured', 'error'];

  it('always lists the four-card catalog, mixing mounted adapters with offline views', async () => {
    const { status, body } = await call('/channels');
    expect(status).toBe(200);
    const arr = body as Array<Record<string, unknown>>;
    const ids = arr.map((c) => c.id);
    expect(ids).toEqual(['weixin', 'qq', 'dingtalk', 'lark']);

    // Weixin + qq are mounted; dingtalk + lark are unmounted offline views.
    const weixin = arr.find((c) => c.id === 'weixin')!;
    const qq = arr.find((c) => c.id === 'qq')!;
    const dingtalk = arr.find((c) => c.id === 'dingtalk')!;
    const lark = arr.find((c) => c.id === 'lark')!;
    expect(weixin.mounted).toBe(true);
    expect(qq.mounted).toBe(true);
    expect(dingtalk).toMatchObject({ enabled: false, configured: false, mounted: false, status: 'unconfigured', health: null, capabilities: null, lastError: null });
    expect(lark).toMatchObject({ enabled: false, configured: false, mounted: false, status: 'unconfigured' });

    // Every status is a spec enum value.
    for (const c of arr) {
      expect(STATUS_ENUM).toContain(c.status);
    }
    expect(JSON.stringify(body)).not.toContain('TOPSECRETTOKEN');
    expect(JSON.stringify(body)).not.toContain('token');
  });

  it('GET /channels/weixin returns a single mounted view', async () => {
    const { status, body } = await call('/channels/weixin');
    expect(status).toBe(200);
    expect((body as { id?: string }).id).toBe('weixin');
    expect((body as { mounted?: boolean }).mounted).toBe(true);
  });

  it('GET /channels/dingtalk returns 200 offline view for a known-but-unmounted catalog id', async () => {
    const { status, body } = await call('/channels/dingtalk');
    expect(status).toBe(200);
    expect((body as { id?: string }).id).toBe('dingtalk');
    expect((body as { mounted?: boolean }).mounted).toBe(false);
    expect((body as { status?: string }).status).toBe('unconfigured');
  });

  it('GET /channels/nope returns 404 with a structured error for a truly unknown id', async () => {
    const { status, body } = await call('/channels/nope');
    expect(status).toBe(404);
    expect((body as { error?: { code?: string } }).error?.code).toBe('CHANNEL_NOT_FOUND');
  });
});

describe('POST auth/start', () => {
  it('returns a public challenge without the adapter payload', async () => {
    const { status, body } = await call('/channels/weixin/auth/start', jsonInit);
    expect(status).toBe(200);
    const c = body as Record<string, unknown>;
    expect(c.id).toBe('challenge-1');
    expect(c.qrUrl).toContain('data:image/png;base64');
    expect('payload' in c).toBe(false);
    expect(JSON.stringify(body)).not.toContain('TOPSECRETTOKEN');
  });

  it('start on a channel without beginAuth returns AUTH_NOT_SUPPORTED', async () => {
    const { status, body } = await call('/channels/qq/auth/start', jsonInit);
    expect(status).toBe(400);
    expect((body as { error?: { code?: string } }).error?.code).toBe('AUTH_NOT_SUPPORTED');
  });
});

describe('POST auth/poll', () => {
  it('polls to pending and derives a prompt', async () => {
    await call('/channels/weixin/auth/start', jsonInit);
    const { status, body } = await call('/channels/weixin/auth/poll', json({ challengeId: 'challenge-1' }));
    expect(status).toBe(200);
    expect((body as { state?: string }).state).toBe('pending');
    expect(typeof (body as { prompt?: unknown }).prompt).toBe('string');
  });

  it('poll with an unknown challenge returns 404', async () => {
    const { status, body } = await call('/channels/weixin/auth/poll', json({ challengeId: 'does-not-exist' }));
    expect(status).toBe(404);
    expect((body as { error?: { code?: string } }).error?.code).toBe('CHALLENGE_NOT_FOUND');
  });

  it('poll on a channel without pollAuth returns AUTH_NOT_SUPPORTED', async () => {
    const { status, body } = await call('/channels/qq/auth/poll', json({ challengeId: 'challenge-1' }));
    expect(status).toBe(400);
    expect((body as { error?: { code?: string } }).error?.code).toBe('AUTH_NOT_SUPPORTED');
  });

  it('maps a need-verifycode poll to prompt verify-code', async () => {
    const vc = new FakeAdapter({ pollState: 'needverify' });
    const handler = wireHandler([vc]);
    const res = await invokeDirect(handler, {
      method: 'POST',
      url: '/dsh-channels/api/v1/channels/weixin/auth/start',
      body: '{}',
    });
    expect(res.status).toBe(200);
    const vcRes = await invokeDirect(handler, {
      method: 'POST',
      url: '/dsh-channels/api/v1/channels/weixin/auth/poll',
      body: JSON.stringify({ challengeId: (res.body as { id?: string }).id }),
    });
    expect(vcRes.status).toBe(200);
    expect((vcRes.body as { prompt?: string }).prompt).toBe('verify-code');
  });
});

describe('POST auth/input', () => {
  it('forwards a verification-code input to the adapter', async () => {
    await call('/channels/weixin/auth/start', jsonInit);
    const { status, body } = await call(
      '/channels/weixin/auth/input',
      json({ challengeId: 'challenge-1', input: { kind: 'verification-code', value: '123456' } }),
    );
    expect(status).toBe(200);
    expect(weixin.lastInput).toEqual({ kind: 'verification-code', value: '123456' });
    expect((body as { state?: string }).state).toBeDefined();
  });

  it('rejects a malformed input with 400', async () => {
    await call('/channels/weixin/auth/start', jsonInit);
    const { status, body } = await call(
      '/channels/weixin/auth/input',
      json({ challengeId: 'challenge-1', input: { kind: 'sms' } }),
    );
    expect(status).toBe(400);
    expect((body as { error?: { code?: string } }).error?.code).toBe('INVALID_INPUT');
  });
});

describe('expired challenge', () => {
  it('returns 410 CHALLENGE_EXPIRED for an already-expired challenge', async () => {
    const expired = new FakeAdapter({ expiresAt: () => Date.now() - 5000 });
    const handler = wireHandler([expired]);
    const start = await invokeDirect(handler, {
      method: 'POST',
      url: '/dsh-channels/api/v1/channels/weixin/auth/start',
      body: '{}',
    });
    expect(start.status).toBe(200);
    const cid = (start.body as { id?: string }).id!;
    const poll = await invokeDirect(handler, {
      method: 'POST',
      url: '/dsh-channels/api/v1/channels/weixin/auth/poll',
      body: JSON.stringify({ challengeId: cid }),
    });
    void cid;
    expect(poll.status).toBe(410);
    expect((poll.body as { error?: { code?: string } }).error?.code).toBe('CHALLENGE_EXPIRED');
  });
});


describe('status enum mapping', () => {
  class HealthAdapter implements ChannelAdapter {
    constructor(readonly id: string, readonly health: ChannelHealth) {
      this.capabilities = { text: true };
    }
    readonly capabilities: { text: boolean };
    async start(_ctx: unknown): Promise<void> {}
    async stop(): Promise<void> {}
    async send(_t: ChannelTarget, _m: OutboundMessage): Promise<SendResult> {
      return { ok: true, id: 'x' };
    }
    async getHealth(): Promise<ChannelHealth> {
      return this.health;
    }
  }

  async function viewFor(adapter: ChannelAdapter, id: string) {
    const handler = wireHandler([adapter]);
    const out = await invokeDirect(handler, {
      method: 'GET',
      url: '/dsh-channels/api/v1/channels/' + id,
    });
    return out;
  }

  it('ok + authenticated -> connected', async () => {
    const out = await viewFor(new HealthAdapter('weixin', { status: 'ok', authenticated: true, connection: 'connected' }), 'weixin');
    expect(out.status).toBe(200);
    expect((out.body as { status?: string }).status).toBe('connected');
  });

  it('down + authenticated -> degraded (receive loop down)', async () => {
    const out = await viewFor(new HealthAdapter('weixin', { status: 'down', authenticated: true }), 'weixin');
    expect(out.status).toBe(200);
    expect((out.body as { status?: string }).status).toBe('degraded');
  });

  it('down + not authenticated -> unconfigured', async () => {
    const out = await viewFor(new HealthAdapter('weixin', { status: 'down', authenticated: false, detail: 'not authed' }), 'weixin');
    expect(out.status).toBe(200);
    expect((out.body as { status?: string }).status).toBe('unconfigured');
  });

  it('unknown + not authenticated -> unconfigured', async () => {
    const out = await viewFor(new HealthAdapter('weixin', { status: 'unknown' }), 'weixin');
    expect(out.status).toBe(200);
    expect((out.body as { status?: string }).status).toBe('unconfigured');
  });

  it('health.error present -> error', async () => {
    const out = await viewFor(new HealthAdapter('weixin', { status: 'down', error: 'boom token=abc' }), 'weixin');
    expect(out.status).toBe(200);
    expect((out.body as { status?: string }).status).toBe('error');
  });

  it('no mounted adapter -> unconfigured offline view', async () => {
    const handler = wireHandler([]);
    const out = await invokeDirect(handler, {
      method: 'GET',
      url: '/dsh-channels/api/v1/channels/qq',
    });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ id: 'qq', mounted: false, configured: false, status: 'unconfigured' });
  });
});

describe('handler security guards (direct invocation)', () => {
  const handler = wireHandler([weixin, qq]);

  it('403 for a non-loopback remote address', async () => {
    const out = await invokeDirect(handler, {
      method: 'POST',
      socket: { remoteAddress: '192.168.1.10' },
      url: '/dsh-channels/api/v1/channels/weixin/auth/start',
    });
    expect(out.status).toBe(403);
    expect((out.body as { error?: { code?: string } }).error?.code).toBe('FORBIDDEN');
  });

  it('415 for a non-JSON Content-Type on POST', async () => {
    const out = await invokeDirect(handler, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      url: '/dsh-channels/api/v1/channels/weixin/auth/start',
    });
    expect(out.status).toBe(415);
  });
});

describe('body limits over real HTTP', () => {
  it('413 for a body over 64 KiB', async () => {
    const big = 'x'.repeat(70 * 1024);
    const { status } = await call('/channels/weixin/auth/poll', {
      ...jsonInit,
      body: JSON.stringify({ challengeId: 'challenge-1', padding: big }),
    });
    expect(status).toBe(413);
  });

  it('400 for a valid-size malformed JSON body', async () => {
    const { status } = await call('/channels/weixin/auth/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });
    expect(status).toBe(400);
  });
});
