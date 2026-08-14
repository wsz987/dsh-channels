/**
 * QQ official-protocol gateway driver tests (offline).
 *
 * Runs a real `ws` `WebSocketServer` on 127.0.0.1:0 as a mock QQ gateway
 * plus a fake fetch for the token/gateway/send OpenAPI calls — no network
 * leaves the machine and no QQ credentials are involved. Covers token
 * acquisition, the Hello→Identify→Ready handshake, heartbeats, dispatch →
 * raw → MessageReceived (dm + group), abort teardown, reconnect/resume,
 * invalid-session re-identify, real v2 sends (text + media), token refresh,
 * and the credentials/token-never-leak guarantee.
 */
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, ChannelError, type MessageReceived } from '@dsh/channel-core';
import { createTestContext } from '@dsh/channel-testkit';
import {
  InboundProcessor,
  QQGatewayUpstream,
  toGatewayRaw,
  QQ_OP,
  QQ_INTENT_GROUP_AND_C2C,
  QQ_EVENT_C2C_MESSAGE_CREATE,
  QQ_EVENT_GROUP_AT_MESSAGE_CREATE,
  type QQGatewayFrame,
  type QQGatewayUpstreamOptions,
} from '../src/index.ts';

const APP_ID = 'APP_ID_123';
const CLIENT_SECRET = 'super-secret-client-secret';
const ACCESS_TOKEN = 'fake-access-token';

/** Deterministic fetch double: records calls, serves token/gateway/v2 routes. */
class FakeFetch {
  calls: { url: string; init: RequestInit }[] = [];
  gatewayUrl = '';
  token = ACCESS_TOKEN;
  tokenExpiresIn = 7200;
  tokenStatus = 200;
  private readonly routes = new Map<string, (init: RequestInit) => unknown>();

  fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    this.calls.push({ url, init: init ?? {} });
    const path = new URL(url).pathname;
    if (path === '/app/getAppAccessToken') {
      const body = this.tokenStatus === 200
        ? { access_token: this.token, expires_in: this.tokenExpiresIn }
        : { err_code: 100016, message: 'invalid appid or secret' };
      return jsonResponse(body, this.tokenStatus);
    }
    if (path === '/gateway') {
      return jsonResponse({ url: this.gatewayUrl });
    }
    const route = this.routes.get(path);
    if (!route) return jsonResponse({ err_code: 404, message: `no fake fetch route for ${path}` }, 404);
    return jsonResponse(route(init ?? {}));
  };

  route(path: string, handler: (init: RequestInit) => unknown): this {
    this.routes.set(path, handler);
    return this;
  }

  callsFor(urlPart: string): { url: string; init: RequestInit }[] {
    return this.calls.filter((c) => c.url.includes(urlPart));
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface RecordedFrame {
  connIndex: number;
  frame: QQGatewayFrame;
}

/** Mock QQ gateway: a real ws server that plays the official protocol. */
class MockGateway {
  private readonly server: WebSocketServer;
  readonly url: string;
  private readonly sockets: WebSocket[] = [];
  private readonly frames: RecordedFrame[] = [];

  private constructor(server: WebSocketServer, url: string) {
    this.server = server;
    this.url = url;
    server.on('connection', (socket) => {
      const connIndex = this.sockets.length;
      this.sockets.push(socket);
      socket.on('message', (data) => {
        let frame: QQGatewayFrame;
        try {
          frame = JSON.parse(data.toString()) as QQGatewayFrame;
        } catch {
          return;
        }
        this.frames.push({ connIndex, frame });
      });
    });
  }

  static async start(): Promise<MockGateway> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    return new MockGateway(server, `ws://127.0.0.1:${port}`);
  }

  get connectionCount(): number {
    return this.sockets.length;
  }

  allFrames(): RecordedFrame[] {
    return [...this.frames];
  }

  socket(connIndex = 0): WebSocket {
    const socket = this.sockets[connIndex];
    if (!socket) throw new Error(`no mock socket ${connIndex}`);
    return socket;
  }

  send(connIndex: number, frame: unknown): void {
    const socket = this.socket(connIndex);
    if (socket.readyState !== 1) throw new Error(`mock socket ${connIndex} not open`);
    socket.send(JSON.stringify(frame));
  }

  hello(connIndex = 0, heartbeatIntervalMs = 45000): void {
    this.send(connIndex, { op: 10, d: { heartbeat_interval: heartbeatIntervalMs } });
  }

  ready(connIndex = 0, sessionId = 'session-abc'): void {
    this.send(connIndex, {
      op: 0,
      s: 1,
      t: 'READY',
      d: { version: 1, session_id: sessionId, user: { id: 'bot', username: 'bot', bot: true }, shard: [0, 1] },
    });
  }

  resumed(connIndex = 0): void {
    this.send(connIndex, { op: 0, s: 2, t: 'RESUMED', d: '' });
  }

  dispatch(connIndex: number, frame: { s: number; t: string; id?: string; d: unknown }): void {
    this.send(connIndex, { op: 0, ...frame });
  }

  closeConnection(connIndex = 0): void {
    const socket = this.sockets[connIndex];
    if (socket && (socket.readyState === 1 || socket.readyState === 0)) socket.close();
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      if (socket.readyState === 1 || socket.readyState === 0) socket.close();
    }
    this.server.close();
    await sleep(100);
  }
}

async function waitForFrame(
  gateway: MockGateway,
  predicate: (frame: QQGatewayFrame, connIndex: number) => boolean,
  timeoutMs = 3000,
): Promise<RecordedFrame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = gateway.allFrames().find((f) => predicate(f.frame, f.connIndex));
    if (found) return found;
    await sleep(10);
  }
  throw new Error('timeout waiting for gateway frame');
}

function c2cDispatch(s: number, overrides: Record<string, unknown> = {}): { op: number; s: number; t: string; id?: string; d: unknown } {
  return {
    op: QQ_OP.DISPATCH,
    s,
    t: QQ_EVENT_C2C_MESSAGE_CREATE,
    id: `evt-c2c-${s}`,
    d: {
      id: `ROBOT1.0_c2c${s}`,
      author: { id: 'USER_OPENID_1', user_openid: 'USER_OPENID_1', username: 'alice', bot: false },
      content: 'hello from c2c',
      message_type: 0,
      timestamp: '2026-07-21T10:00:00+08:00',
      ...overrides,
    },
  };
}

function groupDispatch(s: number, overrides: Record<string, unknown> = {}): { op: number; s: number; t: string; id?: string; d: unknown } {
  return {
    op: QQ_OP.DISPATCH,
    s,
    t: QQ_EVENT_GROUP_AT_MESSAGE_CREATE,
    id: `evt-group-${s}`,
    d: {
      id: `ROBOT1.0_group${s}`,
      author: { id: 'MEMBER_OPENID_1', member_openid: 'MEMBER_OPENID_1', member_role: 'member', username: 'bob', bot: false },
      content: 'hello group',
      group_openid: 'GROUP_OPENID_1',
      message_type: 0,
      timestamp: '2026-07-21T10:01:00+08:00',
      ...overrides,
    },
  };
}

function makeDriver(fetchImpl: typeof fetch, overrides: Partial<QQGatewayUpstreamOptions> = {}): QQGatewayUpstream {
  return new QQGatewayUpstream({
    appId: APP_ID,
    clientSecret: CLIENT_SECRET,
    fetchImpl,
    maxReconnectRetries: 2,
    ...overrides,
  });
}

interface EstablishedSession {
  driver: QQGatewayUpstream;
  controller: AbortController;
  loop: Promise<void>;
  received: unknown[];
}

/** Connect the driver to the mock gateway: Hello → Identify → Ready. */
async function establishSession(
  gateway: MockGateway,
  fetchImpl: typeof fetch,
  opts: { onMessage?: (raw: unknown) => void } = {},
): Promise<EstablishedSession> {
  const controller = new AbortController();
  const driver = makeDriver(fetchImpl);
  const received: unknown[] = [];
  const loop = driver.receive(controller.signal, (raw) => {
    received.push(raw);
    opts.onMessage?.(raw);
  });
  await vi.waitFor(() => expect(gateway.connectionCount).toBeGreaterThan(0), { timeout: 3000 });
  gateway.hello();
  await waitForFrame(gateway, (f) => f.op === QQ_OP.IDENTIFY);
  gateway.ready();
  return { driver, controller, loop, received };
}

describe('toGatewayRaw (dispatch → shared raw shape)', () => {
  it('maps a C2C text dispatch to the dm raw shape', () => {
    const raw = toGatewayRaw(c2cDispatch(5) as unknown as QQGatewayFrame);
    expect(raw).toEqual({
      eventId: 'evt-c2c-5',
      seq: 5,
      msgId: 'ROBOT1.0_c2c5',
      senderId: 'USER_OPENID_1',
      conversationId: 'USER_OPENID_1',
      conversationType: 'dm',
      type: 'text',
      content: 'hello from c2c',
    });
  });

  it('maps a group-@ dispatch to the group raw shape keyed by group_openid', () => {
    const raw = toGatewayRaw(groupDispatch(6) as unknown as QQGatewayFrame);
    expect(raw).toMatchObject({
      eventId: 'evt-group-6',
      msgId: 'ROBOT1.0_group6',
      senderId: 'MEMBER_OPENID_1',
      conversationId: 'GROUP_OPENID_1',
      conversationType: 'group',
      type: 'text',
      content: 'hello group',
    });
  });

  it('maps an image attachment to an image raw with picUrl', () => {
    const raw = toGatewayRaw(
      c2cDispatch(7, {
        content: '',
        attachments: [
          { url: 'https://example.com/pic.png', filename: 'pic.png', content_type: 'image/png', size: 1234 },
        ],
      }) as unknown as QQGatewayFrame,
    );
    expect(raw).toMatchObject({
      type: 'image',
      picUrl: 'https://example.com/pic.png',
      mediaUrl: 'https://example.com/pic.png',
      title: 'pic.png',
    });
  });

  it('maps a voice attachment to an audio raw preferring the wav url', () => {
    const raw = toGatewayRaw(
      c2cDispatch(8, {
        content: '',
        attachments: [
          { url: 'https://example.com/a.silk', filename: 'a.silk', content_type: 'voice', voice_wav_url: 'https://example.com/a.wav' },
        ],
      }) as unknown as QQGatewayFrame,
    );
    expect(raw).toMatchObject({ type: 'audio', mediaUrl: 'https://example.com/a.wav', title: 'a.silk' });
  });

  it('maps a structured-card (message_type 3) dispatch to a link raw', () => {
    const raw = toGatewayRaw(
      c2cDispatch(9, {
        message_type: 3,
        content: '[卡片消息] 小程序',
        ark_data: { ark_type: 'miniapp', prompt: '快来完成今日学习打卡', fields: { title: '学习打卡' } },
      }) as unknown as QQGatewayFrame,
    );
    expect(raw).toMatchObject({ type: 'link', title: '学习打卡' });
  });

  it('returns undefined for non-dispatch or non-message frames', () => {
    expect(toGatewayRaw({ op: 10, d: { heartbeat_interval: 45000 } })).toBeUndefined();
    expect(toGatewayRaw({ op: 0, t: 'READY', s: 1, d: { session_id: 's' } })).toBeUndefined();
    expect(toGatewayRaw({ op: 0, t: 'GUILD_CREATE', s: 2, d: {} })).toBeUndefined();
    expect(toGatewayRaw(undefined)).toBeUndefined();
  });
});

describe('QQGatewayUpstream token + gateway handshake', () => {
  it('acquires a token, resolves the gateway, identifies with the right intents, and heartbeats', async () => {
    const gateway = await MockGateway.start();
    const fetch = new FakeFetch();
    fetch.gatewayUrl = gateway.url;
    try {
      const controller = new AbortController();
      const driver = makeDriver(fetch.fetchImpl);
      const loop = driver.receive(controller.signal, () => {});
      await vi.waitFor(() => expect(gateway.connectionCount).toBeGreaterThan(0), { timeout: 3000 });
      gateway.hello(0, 60);

      const identify = await waitForFrame(gateway, (f) => f.op === QQ_OP.IDENTIFY);
      expect(identify.frame.d).toMatchObject({
        token: `QQBot ${ACCESS_TOKEN}`,
        intents: QQ_INTENT_GROUP_AND_C2C,
        shard: [0, 1],
      });

      gateway.ready();
      await waitForFrame(gateway, (f) => f.op === QQ_OP.HEARTBEAT, 1500);

      const tokenCall = fetch.callsFor('/app/getAppAccessToken');
      expect(tokenCall).toHaveLength(1);
      expect(JSON.parse(String(tokenCall[0]?.init.body))).toEqual({ appId: APP_ID, clientSecret: CLIENT_SECRET });
      expect((tokenCall[0]?.init.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();

      const gatewayCall = fetch.callsFor('/gateway');
      expect(gatewayCall).toHaveLength(1);
      expect((gatewayCall[0]?.init.headers as Record<string, string>).authorization).toBe(`QQBot ${ACCESS_TOKEN}`);

      controller.abort();
      await loop;
    } finally {
      await gateway.close();
    }
  }, 8000);

  it('reuses the cached token within its lifetime and refreshes after expiry', async () => {
    const gateway = await MockGateway.start();
    const fetch = new FakeFetch();
    fetch.gatewayUrl = gateway.url;
    fetch.tokenExpiresIn = 7200;
    let clock = 0;
    try {
      const driver = makeDriver(fetch.fetchImpl, { now: () => clock });
      const first = new AbortController();
      const loop1 = driver.receive(first.signal, () => {});
      await vi.waitFor(() => expect(gateway.connectionCount).toBeGreaterThan(0), { timeout: 3000 });
      gateway.hello();
      await waitForFrame(gateway, (f) => f.op === QQ_OP.IDENTIFY);
      gateway.ready();
      first.abort();
      await loop1;

      clock = 5000;
      const second = new AbortController();
      const loop2 = driver.receive(second.signal, () => {});
      await vi.waitFor(() => expect(gateway.connectionCount).toBe(2), { timeout: 3000 });
      gateway.hello(1);
      await waitForFrame(gateway, (f) => f.op === QQ_OP.IDENTIFY);
      gateway.ready(1);
      second.abort();
      await loop2;
      expect(fetch.callsFor('/app/getAppAccessToken')).toHaveLength(1); // cached

      clock = 7_300_000; // past expiry
      const third = new AbortController();
      const loop3 = driver.receive(third.signal, () => {});
      await vi.waitFor(() => expect(gateway.connectionCount).toBe(3), { timeout: 3000 });
      gateway.hello(2);
      await waitForFrame(gateway, (f) => f.op === QQ_OP.IDENTIFY);
      gateway.ready(2);
      third.abort();
      await loop3;
      expect(fetch.callsFor('/app/getAppAccessToken')).toHaveLength(2); // refreshed
    } finally {
      await gateway.close();
    }
  }, 8000);
});

describe('QQGatewayUpstream.receive (dispatch pipeline)', () => {
  it('routes C2C and group dispatches through the inbound processor to MessageReceived', async () => {
    const gateway = await MockGateway.start();
    const fetch = new FakeFetch();
    fetch.gatewayUrl = gateway.url;
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const processor = new InboundProcessor({
      ctx,
      meta: { channel: 'qq' as never, accountId: 'main' as never },
      dedupEnabled: false,
      dedupWindowMs: 5000,
    });
    const listener = vi.fn();
    service.on(listener);
    try {
      const session = await establishSession(gateway, fetch.fetchImpl, { onMessage: (raw) => {
        void processor.handle(raw).catch(() => undefined);
      } });
      gateway.dispatch(0, c2cDispatch(5));
      gateway.dispatch(0, groupDispatch(6));
      await vi.waitFor(
        () => {
          const events = listener.mock.calls.map((call) => call[0] as MessageReceived);
          expect(events.filter((e) => e.type === 'message.received')).toHaveLength(2);
        },
        { timeout: 3000 },
      );
      const events = listener.mock.calls
        .map((call) => call[0] as MessageReceived)
        .filter((e) => e.type === 'message.received');
      const dm = events.find((e) => e.conversation.type === 'dm')!;
      expect(dm.message.id).toBe('ROBOT1.0_c2c5');
      expect(dm.message.content).toEqual([{ type: 'text', text: 'hello from c2c' }]);
      expect(dm.conversation.id).toBe('USER_OPENID_1');
      expect(dm.sender.id).toBe('USER_OPENID_1');
      const group = events.find((e) => e.conversation.type === 'group')!;
      expect(group.message.id).toBe('ROBOT1.0_group6');
      expect(group.message.content).toEqual([{ type: 'text', text: 'hello group' }]);
      expect(group.conversation.id).toBe('GROUP_OPENID_1');
      expect(group.sender.id).toBe('MEMBER_OPENID_1');
      session.controller.abort();
      await session.loop;
    } finally {
      await gateway.close();
    }
  }, 8000);

  it('maps an image attachment dispatch to an image MessageReceived', async () => {
    const gateway = await MockGateway.start();
    const fetch = new FakeFetch();
    fetch.gatewayUrl = gateway.url;
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const processor = new InboundProcessor({
      ctx,
      meta: { channel: 'qq' as never, accountId: 'main' as never },
      dedupEnabled: false,
      dedupWindowMs: 5000,
    });
    const listener = vi.fn();
    service.on(listener);
    try {
      const session = await establishSession(gateway, fetch.fetchImpl, { onMessage: (raw) => {
        void processor.handle(raw).catch(() => undefined);
      } });
      gateway.dispatch(
        0,
        c2cDispatch(7, {
          content: '',
          attachments: [
            { url: 'https://example.com/pic.png', filename: 'pic.png', content_type: 'image/png', size: 100 },
          ],
        }),
      );
      await vi.waitFor(
        () => {
          const events = listener.mock.calls.map((call) => call[0] as MessageReceived);
          expect(events.some((e) => e.type === 'message.received')).toBe(true);
        },
        { timeout: 3000 },
      );
      const event = listener.mock.calls
        .map((call) => call[0] as MessageReceived)
        .find((e) => e.type === 'message.received')!;
      expect(event.message.content).toEqual([
        { type: 'image', url: 'https://example.com/pic.png', alt: 'pic.png' },
      ]);
      session.controller.abort();
      await session.loop;
    } finally {
      await gateway.close();
    }
  }, 8000);

  it('abort tears down: receive resolves and the socket is closed', async () => {
    const gateway = await MockGateway.start();
    const fetch = new FakeFetch();
    fetch.gatewayUrl = gateway.url;
    try {
      const controller = new AbortController();
      const driver = makeDriver(fetch.fetchImpl);
      const loop = driver.receive(controller.signal, () => {});
      await vi.waitFor(() => expect(gateway.connectionCount).toBeGreaterThan(0), { timeout: 3000 });
      gateway.hello();
      await waitForFrame(gateway, (f) => f.op === QQ_OP.IDENTIFY);
      gateway.ready();
      controller.abort();
      await loop; // must resolve, not hang
      await vi.waitFor(() => expect(gateway.socket(0).readyState).toBe(3), { timeout: 3000 });
    } finally {
      await gateway.close();
    }
  }, 8000);

  it('reconnects with resume after the server closes the connection', async () => {
    const gateway = await MockGateway.start();
    const fetch = new FakeFetch();
    fetch.gatewayUrl = gateway.url;
    try {
      const session = await establishSession(gateway, fetch.fetchImpl);
      gateway.dispatch(0, c2cDispatch(5));
      await vi.waitFor(() => expect(session.received).toHaveLength(1), { timeout: 3000 });

      gateway.closeConnection(0);
      await vi.waitFor(() => expect(gateway.connectionCount).toBeGreaterThanOrEqual(2), { timeout: 5000 });
      gateway.hello(1);
      const resume = await waitForFrame(gateway, (f) => f.op === QQ_OP.RESUME, 5000);
      expect(resume.connIndex).toBe(1);
      expect(resume.frame.d).toMatchObject({ session_id: 'session-abc', seq: 5 });
      gateway.resumed(1);

      session.controller.abort();
      await session.loop;
    } finally {
      await gateway.close();
    }
  }, 10000);

  it('reconnects on server Reconnect (op 7) with resume', async () => {
    const gateway = await MockGateway.start();
    const fetch = new FakeFetch();
    fetch.gatewayUrl = gateway.url;
    try {
      const session = await establishSession(gateway, fetch.fetchImpl);
      gateway.dispatch(0, c2cDispatch(5));
      await vi.waitFor(() => expect(session.received).toHaveLength(1), { timeout: 3000 });

      gateway.send(0, { op: 7 });
      await vi.waitFor(() => expect(gateway.connectionCount).toBeGreaterThanOrEqual(2), { timeout: 5000 });
      gateway.hello(1);
      const resume = await waitForFrame(gateway, (f) => f.op === QQ_OP.RESUME, 5000);
      expect(resume.frame.d).toMatchObject({ session_id: 'session-abc' });
      gateway.resumed(1);

      session.controller.abort();
      await session.loop;
    } finally {
      await gateway.close();
    }
  }, 10000);

  it('clears the session on Invalid Session (op 9) and identifies again', async () => {
    const gateway = await MockGateway.start();
    const fetch = new FakeFetch();
    fetch.gatewayUrl = gateway.url;
    try {
      const session = await establishSession(gateway, fetch.fetchImpl);
      gateway.dispatch(0, c2cDispatch(5));
      await vi.waitFor(() => expect(session.received).toHaveLength(1), { timeout: 3000 });

      gateway.send(0, { op: 9, d: false });
      await vi.waitFor(() => expect(gateway.connectionCount).toBeGreaterThanOrEqual(2), { timeout: 5000 });
      gateway.hello(1);
      const identify = await waitForFrame(gateway, (f, i) => f.op === QQ_OP.IDENTIFY && i === 1, 5000);
      expect(identify.connIndex).toBe(1);
      gateway.ready(1, 'session-xyz');

      session.controller.abort();
      await session.loop;
    } finally {
      await gateway.close();
    }
  }, 10000);

  it('fails loudly (with retry budget) when the token endpoint rejects', async () => {
    const fetch = new FakeFetch();
    fetch.gatewayUrl = 'ws://127.0.0.1:1';
    fetch.tokenStatus = 500;
    const driver = makeDriver(fetch.fetchImpl);
    const controller = new AbortController();
    let caught: unknown;
    try {
      await driver.receive(controller.signal, () => {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChannelError);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain(CLIENT_SECRET);
    expect(message).not.toContain(APP_ID);
  }, 8000);
});

describe('QQGatewayUpstream outbound (real v2 sends)', () => {
  it('sendText posts to the v2 C2C endpoint with QQBot auth and the text payload', async () => {
    const gateway = await MockGateway.start();
    const fetch = new FakeFetch();
    fetch.gatewayUrl = gateway.url;
    try {
      const session = await establishSession(gateway, fetch.fetchImpl);
      gateway.dispatch(0, c2cDispatch(5));
      await vi.waitFor(() => expect(session.received).toHaveLength(1), { timeout: 3000 });
      session.controller.abort();
      await session.loop;

      fetch.route('/v2/users/USER_OPENID_1/messages', () => ({ id: 'out-1', timestamp: '2026-07-21T12:00:00+08:00' }));
      const result = await session.driver.sendText('USER_OPENID_1', 'hi there');
      expect(result).toEqual({ id: 'out-1', timestamp: '2026-07-21T12:00:00+08:00' });
      const call = fetch.callsFor('/v2/users/USER_OPENID_1/messages')[0]!;
      expect((call.init.headers as Record<string, string>).authorization).toBe(`QQBot ${ACCESS_TOKEN}`);
      expect(JSON.parse(String(call.init.body))).toEqual({ msg_type: 0, content: 'hi there', msg_seq: 1 });
    } finally {
      await gateway.close();
    }
  }, 8000);

  it('sendText routes group conversations to the v2 group endpoint', async () => {
    const gateway = await MockGateway.start();
    const fetch = new FakeFetch();
    fetch.gatewayUrl = gateway.url;
    try {
      const session = await establishSession(gateway, fetch.fetchImpl);
      gateway.dispatch(0, groupDispatch(6));
      await vi.waitFor(() => expect(session.received).toHaveLength(1), { timeout: 3000 });
      session.controller.abort();
      await session.loop;

      fetch.route('/v2/groups/GROUP_OPENID_1/messages', () => ({ id: 'out-g' }));
      await session.driver.sendText('GROUP_OPENID_1', 'hi group');
      const call = fetch.callsFor('/v2/groups/GROUP_OPENID_1/messages')[0]!;
      expect((call.init.headers as Record<string, string>).authorization).toBe(`QQBot ${ACCESS_TOKEN}`);
      expect(JSON.parse(String(call.init.body))).toEqual({ msg_type: 0, content: 'hi group', msg_seq: 1 });
    } finally {
      await gateway.close();
    }
  }, 8000);

  it('sendText defaults unknown conversations to the C2C endpoint', async () => {
    const fetch = new FakeFetch();
    fetch.gatewayUrl = 'ws://127.0.0.1:1';
    fetch.route('/v2/users/SOME_OPENID/messages', () => ({ id: 'out-u' }));
    const driver = makeDriver(fetch.fetchImpl);
    await driver.sendText('SOME_OPENID', 'hi');
    const call = fetch.callsFor('/v2/users/SOME_OPENID/messages')[0]!;
    expect(JSON.parse(String(call.init.body))).toEqual({ msg_type: 0, content: 'hi', msg_seq: 1 });
  });

  it('sendMedia uploads by URL then sends a msg_type 7 media message', async () => {
    const fetch = new FakeFetch();
    fetch.gatewayUrl = 'ws://127.0.0.1:1';
    fetch.route('/v2/users/USER_OPENID_1/files', () => ({ file_info: 'FILE_INFO_1', ttl: 300 }));
    fetch.route('/v2/users/USER_OPENID_1/messages', () => ({ id: 'out-2' }));
    const driver = makeDriver(fetch.fetchImpl);

    const result = await driver.sendMedia('USER_OPENID_1', { type: 'image', url: 'https://example.com/pic.png' });
    expect(result).toEqual({ id: 'out-2' });
    const filesCall = fetch.callsFor('/v2/users/USER_OPENID_1/files')[0]!;
    expect((filesCall.init.headers as Record<string, string>).authorization).toBe(`QQBot ${ACCESS_TOKEN}`);
    expect(JSON.parse(String(filesCall.init.body))).toEqual({
      file_type: 1,
      url: 'https://example.com/pic.png',
      srv_send_msg: false,
    });
    const msgCall = fetch.callsFor('/v2/users/USER_OPENID_1/messages')[0]!;
    expect(JSON.parse(String(msgCall.init.body))).toEqual({ msg_type: 7, media: { file_info: 'FILE_INFO_1' }, msg_seq: 1 });
  });

  it('send failures never embed the token or secret in the error', async () => {
    const fetch = new FakeFetch();
    fetch.gatewayUrl = 'ws://127.0.0.1:1';
    fetch.route('/v2/users/USER_OPENID_1/messages', () => {
      throw new Error('platform exploded');
    });
    const driver = makeDriver(fetch.fetchImpl);
    let caught: unknown;
    try {
      await driver.sendText('USER_OPENID_1', 'hi');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ChannelError);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain(ACCESS_TOKEN);
    expect(message).not.toContain(CLIENT_SECRET);
    expect(message).not.toContain(APP_ID);
    // The secret appears only in the token request body — never in the send call.
    const nonTokenCalls = fetch.calls.filter((c) => !c.url.includes('/app/getAppAccessToken'));
    expect(JSON.stringify(nonTokenCalls)).not.toContain(CLIENT_SECRET);
  });

  it('rejects QR auth methods (gateway-only)', async () => {
    const fetch = new FakeFetch();
    const driver = makeDriver(fetch.fetchImpl);
    await expect(driver.login()).rejects.toMatchObject({ code: 'CHANNEL_ERROR' });
    await expect(driver.pollAuth()).rejects.toMatchObject({ code: 'CHANNEL_ERROR' });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
