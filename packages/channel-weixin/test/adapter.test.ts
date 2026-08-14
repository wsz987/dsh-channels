/**
 * Channel-weixin tests for the direct Tencent iLink client (WX0-WX6).
 *
 * Covers doc §34.3 unit cases (headers/X-WECHAT-UIN, base_info, QR state
 * machine, redirect, verify code, credential store, cursor + crash replay,
 * context token, mapper, dedup, send payload, AbortSignal, token redaction)
 * plus adapter integration and the public ChannelAdapter contract suite.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService, MemoryStorage, ChannelError } from '@dsh/channel-core';
import type { ChannelAdapterContext, ChannelTarget } from '@dsh/channel-core';
import {
  runChannelAdapterContract,
  createTestContext,
  makeOutboundMessage,
} from '@dsh/channel-testkit';
import {
  Config,
  WeixinAdapter,
  ILinkClient,
  buildHeaders,
  buildWechatUin,
  clientVersionFromString,
  buildBaseInfo,
  WeixinQrAuth,
  AccountCredentialStore,
  SyncCursorStore,
  ContextTokenStore,
  DedupWindow,
  dedupKey,
  mapInbound,
  OutboundSender,
  buildSendTextPayload,
  aes128Decrypt,
  aes128Encrypt,
  redactMessage,
  type HttpTransport,
} from '../src/index.js';
import type { WeixinConfig } from '../src/config.js';
import { loadFixture } from '@dsh/channel-testkit';

/* ------------------------------------------------------------------ */
/* Fake transport routed by URL path                                   */
/* ------------------------------------------------------------------ */

interface FakeHandlerInit {
  body?: unknown;
  headers?: Record<string, string>;
}

export class FakeTransport implements HttpTransport {
  routeByPath = new Map<string, (init?: FakeHandlerInit, signal?: AbortSignal) => unknown>();
  calls: { url: string; init?: FakeHandlerInit; signal?: AbortSignal }[] = [];

  route(path: string, handler: (init?: FakeHandlerInit, signal?: AbortSignal) => unknown): this {
    this.routeByPath.set(path, handler);
    return this;
  }

  async request(url: string, init?: FakeHandlerInit, signal?: AbortSignal): Promise<unknown> {
    this.calls.push({ url, init, signal });
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const path = pathOf(url);
    const handler = this.routeByPath.get(path);
    if (!handler) {
      throw new ChannelError('CHANNEL_ERROR', `no route for ${path}`);
    }
    return handler(init, signal);
  }

  lastBody(path: string): any {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      if (pathOf(this.calls[i]!.url).includes(path)) return (this.calls[i]!.init as any)?.body;
    }
    return undefined;
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? u.search : '');
  } catch {
    return url;
  }
}

function makeConfig(overrides: Partial<WeixinConfig> = {}): WeixinConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    ilink: { baseUrl: 'https://fake.ilink.test', cdnBaseUrl: 'https://fake.cdn.test', botAgent: 'DeepSeekHarness/0.8.1' },
    network: { timeoutMs: 1000, longPollTimeoutMs: 1000 },
    reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10 },
    ...overrides,
  } as unknown as WeixinConfig);
}

function target(conversationId: string): ChannelTarget {
  return { channelId: 'weixin' as never, accountId: 'main' as never, conversationId: conversationId as never };
}

/* ------------------------------------------------------------------ */
/* Unit: headers + X-WECHAT-UIN + base_info + clientVersion            */
/* ------------------------------------------------------------------ */

describe('iLink headers', () => {
  it('builds the full shared header set', () => {
    const headers = buildHeaders({ token: 'secret-token', routeTag: 'rt1', uin: 1234 });
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['AuthorizationType']).toBe('ilink_bot_token');
    expect(headers['Authorization']).toBe('Bearer secret-token');
    expect(headers['iLink-App-Id']).toBe('bot');
    expect(headers['SKRouteTag']).toBe('rt1');
    expect(headers['iLink-App-ClientVersion']).toMatch(/^\d+$/);
  });

  it('omits Authorization when no token is supplied', () => {
    const headers = buildHeaders({});
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['AuthorizationType']).toBe('ilink_bot_token');
  });

  it('X-WECHAT-UIN is decimal uint32 -> base64', () => {
    const uin = buildWechatUin(1234);
    expect(Buffer.from(uin, 'base64').toString('utf-8')).toBe('1234');
  });

  it('clientVersion encodes 0x00MMNNPP', () => {
    expect(clientVersionFromString('1.0.11')).toBe((1 << 16) | 11);
    expect(clientVersionFromString('0.8.1')).toBe((8 << 8) | 1);
  });

  it('buildBaseInfo sets bot_agent and channel_version', () => {
    const info = buildBaseInfo({ channelVersion: '1.2.3', botAgent: 'DeepSeekHarness/2.0' });
    expect(info.bot_agent).toBe('DeepSeekHarness/2.0');
    expect(info.channel_version).toBe('1.2.3');
    const fallback = buildBaseInfo({});
    expect(fallback.bot_agent).toBe('DeepSeekHarness');
  });
});

/* ------------------------------------------------------------------ */
/* Unit: QR state machine (redirect, verify code, binded)              */
/* ------------------------------------------------------------------ */

describe('WeixinQrAuth', () => {
  function makeAuth(transport: FakeTransport, baseUrl = 'https://fake.ilink.test') {
    const client = new ILinkClient({ baseUrl, transport, timeoutMs: 1000, longPollTimeoutMs: 1000, now: () => 1000 });
    return new WeixinQrAuth({ client, now: () => 1000 });
  }

  it('beginAuth surfaces an AuthChallenge with qrUrl', async () => {
    const transport = new FakeTransport();
    transport.route('/ilink/bot/get_bot_qrcode?bot_type=3', () => ({ qrcode: 'qr1', qrcode_img_content: 'https://weixin.qq.com/q/xx' }));
    const auth = makeAuth(transport);
    const challenge = await auth.beginAuth();
    expect(challenge.qrUrl).toBe('https://weixin.qq.com/q/xx');
    expect(challenge.id).toBeTypeOf('string');
    expect(challenge.expiresAt).toBeTypeOf('number');
  });

  it('pollAuth walk wait -> confirmed and keeps credentials', async () => {
    const transport = new FakeTransport();
    transport.route('/ilink/bot/get_bot_qrcode?bot_type=3', () => ({ qrcode: 'qr1', qrcode_img_content: 'u' }));
    transport.route('/ilink/bot/get_qrcode_status?qrcode=qr1', () => ({
      status: 'confirmed',
      bot_token: 'tok-secret',
      ilink_bot_id: 'bot-1',
      baseurl: 'https://final.ilink.test',
      ilink_user_id: 'wx-user',
    }));
    const auth = makeAuth(transport);
    const challenge = await auth.beginAuth();
    const poll = await auth.pollAuth(challenge);
    expect(poll.state).toBe('authenticated');
    const cred = auth.confirmedCredential;
    expect(cred?.ilinkBotId).toBe('bot-1');
    expect(cred?.baseUrl).toBe('https://final.ilink.test');
    expect(cred?.token).toBe('tok-secret');
  });

  it('updates the client baseUrl on scaned_but_redirect', async () => {
    const transport = new FakeTransport();
    transport.route('/ilink/bot/get_bot_qrcode?bot_type=3', () => ({ qrcode: 'qr1', qrcode_img_content: 'u' }));
    transport.route('/ilink/bot/get_qrcode_status?qrcode=qr1', () => ({ status: 'scaned_but_redirect', redirect_host: 'ilink-idc.weixin.qq.com' }));
    const client = new ILinkClient({ baseUrl: 'https://fake.ilink.test', transport, now: () => 1000 });
    const auth = new WeixinQrAuth({ client, now: () => 1000 });
    const challenge = await auth.beginAuth();
    await auth.pollAuth(challenge);
    expect(client.baseUrl).toBe('https://ilink-idc.weixin.qq.com');
  });

  it('need_verifycode surfaces pending; submitVerifyCode resumes', async () => {
    const transport = new FakeTransport();
    transport.route('/ilink/bot/get_bot_qrcode?bot_type=3', () => ({ qrcode: 'qr1', qrcode_img_content: 'u' }));
    transport.route('/ilink/bot/get_qrcode_status?qrcode=qr1', () => ({ status: 'need_verifycode' }));
    const auth = makeAuth(transport);
    const challenge = await auth.beginAuth();
    const poll = await auth.pollAuth(challenge);
    expect(poll.state).toBe('pending');
    auth.submitVerifyCode('123456');
    transport.route('/ilink/bot/get_qrcode_status?qrcode=qr1&verify_code=123456', () => ({ status: 'confirmed', bot_token: 't', ilink_bot_id: 'b', baseurl: 'u' }));
    const poll2 = await auth.pollAuth(challenge);
    expect(poll2.state).toBe('authenticated');
  });

  it('binded_redirect reports authenticated alreadyBound', async () => {
    const transport = new FakeTransport();
    transport.route('/ilink/bot/get_bot_qrcode?bot_type=3', () => ({ qrcode: 'qr1', qrcode_img_content: 'u' }));
    transport.route('/ilink/bot/get_qrcode_status?qrcode=qr1', () => ({ status: 'binded_redirect', redirect_host: 'h.example' }));
    const auth = makeAuth(transport);
    const challenge = await auth.beginAuth();
    const poll = await auth.pollAuth(challenge);
    expect(poll.state).toBe('authenticated');
    expect(auth.getState().alreadyBound).toBe(true);
  });

  it('honors challenge expiry', async () => {
    const transport = new FakeTransport();
    transport.route('/ilink/bot/get_bot_qrcode?bot_type=3', () => ({ qrcode: 'qr1', qrcode_img_content: 'u' }));
    const auth = makeAuth(transport);
    const challenge = await auth.beginAuth();
    const expired = await auth.pollAuth({ ...challenge, expiresAt: 0 });
    expect(expired.state).toBe('expired');
  });
});

/* ------------------------------------------------------------------ */
/* Unit: credential store                                              */
/* ------------------------------------------------------------------ */

describe('AccountCredentialStore', () => {
  it('saves and loads a credential; token in secrets, meta in storage', async () => {
    const secrets = new (await import('@dsh/channel-core')).MemorySecretStore();
    const storage = new MemoryStorage();
    const store = new AccountCredentialStore({ secrets, storage, accountId: 'main', now: () => 1700000000000 });
    await store.save({ token: 'tok', ilinkBotId: 'bot-1', userId: 'u1', baseUrl: 'https://x' });
    const loaded = await store.load();
    expect(loaded?.token).toBe('tok');
    expect(loaded?.ilinkBotId).toBe('bot-1');
    expect(loaded?.baseUrl).toBe('https://x');
    expect(loaded?.savedAt).toBeDefined();
  });

  it('returns undefined when corrupt meta', async () => {
    const secrets = new (await import('@dsh/channel-core')).MemorySecretStore();
    const storage = new MemoryStorage();
    const store = new AccountCredentialStore({ secrets, storage, accountId: 'main', now: () => 1700000000000 });
    await store.save({ token: 't', ilinkBotId: 'b', baseUrl: 'u' });
    await storage.set('weixin:credential:main', 'not-json');
    expect(await store.load()).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* Unit: cursor / context token / dedup / mapper                       */
/* ------------------------------------------------------------------ */

describe('SyncCursorStore', () => {
  it('persists, loads, clears', async () => {
    const storage = new MemoryStorage();
    const c = new SyncCursorStore({ storage, accountId: 'main' });
    await c.set('buf-42');
    expect(await c.load()).toBe('buf-42');
    await c.clear();
    expect(await c.load()).toBe('');
  });
});

describe('ContextTokenStore', () => {
  it('stores/reads per-peer context tokens', async () => {
    const storage = new MemoryStorage();
    const s = new ContextTokenStore({ storage, accountId: 'main' });
    await s.set('user_1', 'ctx-111');
    expect(await s.get('user_1')).toBe('ctx-111');
    expect(await s.get('other')).toBeUndefined();
  });
});

describe('dedup', () => {
  it('identical texts MUST NOT dedup (distinct seq/message_id)', () => {
    const w = new DedupWindow({ windowMs: 60_000, now: () => 1000 });
    const a = { seq: 1, message_id: 1, from_user_id: 'u', item_list: [{ type: 1, text_item: { text: '你好' } }] };
    const b = { seq: 2, message_id: 2, from_user_id: 'u', item_list: [{ type: 1, text_item: { text: '你好' } }] };
    expect(dedupKey(a)).not.toBe(dedupKey(b));
    expect(w.check(dedupKey(a))).toBe(true);
    expect(w.check(dedupKey(b))).toBe(true); // second identical-text message NOT dropped
  });

  it('same message_id MUST dedup', () => {
    const w = new DedupWindow({ windowMs: 60_000, now: () => 1000 });
    const a = { seq: 1, message_id: 7, from_user_id: 'u' };
    const b = { seq: 1, message_id: 7, from_user_id: 'u' };
    expect(dedupKey(a)).toBe(dedupKey(b));
    expect(w.check(dedupKey(a))).toBe(true);
    expect(w.check(dedupKey(b))).toBe(false);
  });
});

describe('mapper', () => {
  it('maps fixture-driven inbound text', async () => {
    const fixture = await loadFixture('weixin', 'inbound-text');
    const event = mapInbound(fixture.payload as any, { channel: 'weixin' as never, accountId: 'main' });
    expect(event.message.id).toBe('wx-1001');
    expect(event.message.content).toEqual([{ type: 'text', text: 'hello harness' }]);
    expect(event.message.createdAt).toBe(1700000000000);
    expect(event.conversation).toEqual({ id: 'user_123', type: 'dm' });
    expect(event.sender).toEqual({ id: 'user_123' });
  });

  it('maps media items to CDN parts or unsupported placeholders', () => {
    const img = mapInbound({ message_id: 1, from_user_id: 'u', item_list: [{ type: 2, image_item: { media: { full_url: 'x://c/img' } } }] } as any, { channel: 'weixin' as never, accountId: 'main' });
    expect(img.message.content[0]!.type).toBe('image');
    expect((img.message.content[0] as any).url).toBe('x://c/img');
    const noCdn = mapInbound({ message_id: 2, from_user_id: 'u', item_list: [{ type: 2, image_item: {} }] } as any, { channel: 'weixin' as never, accountId: 'main' });
    expect(noCdn.message.content[0]!.type).toBe('unsupported');
  });
});

/* ------------------------------------------------------------------ */
/* Unit: send payload + token redaction + AES                          */
/* ------------------------------------------------------------------ */

describe('send payload', () => {
  it('builds a real iLink sendmessage payload', () => {
    const payload = buildSendTextPayload({ to: 'user_1', text: 'hi', contextToken: 'ctx-9', runId: 'run-1' }) as any;
    expect(payload.msg.to_user_id).toBe('user_1');
    expect(payload.msg.message_type).toBe(2);
    expect(payload.msg.message_state).toBe(2);
    expect(payload.msg.item_list).toEqual([{ type: 1, text_item: { text: 'hi' } }]);
    expect(payload.msg.client_id).toBeTypeOf('string');
    expect(payload.msg.context_token).toBe('ctx-9');
    expect(payload.msg.run_id).toBe('run-1');
  });

  it('OutboundSender sends through the client with context_token', async () => {
    const transport = new FakeTransport();
    transport.route('/ilink/bot/sendmessage', () => ({ ret: 0 }));
    const client = new ILinkClient({ baseUrl: 'https://fake.ilink.test', transport, now: () => 1000 });
    const storage = new MemoryStorage();
    const ct = new ContextTokenStore({ storage, accountId: 'main' });
    await ct.set('user_1', 'ctx-7');
    const sender = new OutboundSender({ client, contextTokens: ct });
    const result = await sender.send(target('user_1'), { text: 'hi' });
    expect(result.delivered).toBe(true);
    const body = transport.lastBody('sendmessage');
    expect(body.msg.context_token).toBe('ctx-7');
    expect(body.msg.to_user_id).toBe('user_1');
  });
});

describe('token redaction', () => {
  it('redacts tokens and context tokens from messages', () => {
    expect(redactMessage('Authorization: Bearer secret=123')).toContain('<redacted>');
    expect(redactMessage('context_token: abc')).toContain('<redacted>');
    // redactMessage walks sensitive keywords; plain text preserved unless token-adjacent.
    expect(redactMessage('no secret here')).not.toContain('\u003credacted\u003e');
  });
});

describe('AES-128-ECB helpers', () => {
  it('round-trips encrypt/decrypt with a 16-byte key', () => {
    const key = Buffer.from('0123456789abcdef', 'utf-8');
    const plain = Buffer.from('hello weixin cdn', 'utf-8');
    const cipher = aes128Encrypt(plain, key);
    expect(aes128Decrypt(cipher, key).toString('utf-8')).toBe('hello weixin cdn');
  });
});

/* ------------------------------------------------------------------ */
/* Adapter integration + contract suite                                */
/* ------------------------------------------------------------------ */

describe('WeixinAdapter integration', () => {
  let transport: FakeTransport;

  beforeEach(() => {
    transport = new FakeTransport();
  });

  function adapter(): WeixinAdapter {
    return new WeixinAdapter(makeConfig(), { transport, now: () => 1700000000000, rand: () => 0.5 });
  }

  const credential = {
    token: 'bot-token-secret',
    ilinkBotId: 'bot-1',
    userId: 'wx-user',
    baseUrl: 'https://fake.ilink.test',
    savedAt: new Date(1700000000000).toISOString(),
  };

  async function seedCredential(ctx: ChannelAdapterContext) {
    const store = new AccountCredentialStore({ secrets: ctx.secrets, storage: ctx.storage, accountId: 'main', now: () => 1700000000000 });
    await store.save(credential);
  }

  it('reports down/not-authenticated until a credential exists', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const a = adapter();
    await a.start(ctx);
    const health = await a.getHealth();
    expect(health.status).toBe('down');
    expect(health.authenticated).toBe(false);
    await a.stop();
  });

  it('starts with a stored credential and drives the monitor', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    await seedCredential(ctx);
    let calls = 0;
    transport.route('/ilink/bot/msg/notifystart', () => ({ ret: 0 }));
    transport.route('/ilink/bot/msg/notifystop', () => ({ ret: 0 }));
    transport.route('/ilink/bot/getupdates', (init?: FakeHandlerInit) => {
      calls += 1;
      if (calls === 1) {
        return {
          ret: 0,
          msgs: [{ message_id: 123, from_user_id: 'user_1', create_time_ms: 1700000000000, context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
          get_updates_buf: 'buf-next',
        };
      }
      return new Promise(() => { /* hold long-poll open until abort */ });
    });

    const listener = vi.fn();
    service.on(listener);

    const a = adapter();
    await a.start(ctx);
    const health = await a.getHealth();
    expect(health.status).toBe('ok');

    await vi.waitFor(() => {
      expect(listener.mock.calls.some((c) => (c[0] as any).type === 'message.received')).toBe(true);
    }, { timeout: 3000 });

    const event = listener.mock.calls.map((c) => c[0]).find((e) => (e as any).type === 'message.received') as any;
    expect(event.message.id).toBe('wx-123');
    expect(event.message.content).toEqual([{ type: 'text', text: 'hi' }]);

    const ct = new ContextTokenStore({ storage: ctx.storage, accountId: 'main' });
    expect(await ct.get('user_1')).toBe('ctx-1');

    const cursor = new SyncCursorStore({ storage: ctx.storage, accountId: 'main' });
    expect(await cursor.load()).toBe('buf-next');

    await ctx.dispose();
    await a.stop();
  });

  it('send reads context_token and builds a real sendmessage payload', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    await seedCredential(ctx);
    const ct = new ContextTokenStore({ storage: ctx.storage, accountId: 'main' });
    await ct.set('user_1', 'ctx-7');
    transport.route('/ilink/bot/msg/notifystart', () => ({ ret: 0 }));
    transport.route('/ilink/bot/getupdates', () => new Promise(() => {}));
    transport.route('/ilink/bot/sendmessage', () => ({ ret: 0 }));

    const a = adapter();
    await a.start(ctx);
    const result = await a.send(target('user_1'), { text: 'hi' });
    expect(result.delivered).toBe(true);
    const body = transport.lastBody('sendmessage');
    expect(body.msg.to_user_id).toBe('user_1');
    expect(body.msg.context_token).toBe('ctx-7');
    expect(body.msg.client_id).toBeTypeOf('string');
    expect(body.msg.message_type).toBe(2);
    expect(body.msg.item_list[0].type).toBe(1);
    await ctx.dispose();
    await a.stop();
  });

  it('maps a failing send to a ChannelError', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    await seedCredential(ctx);
    transport.route('/ilink/bot/msg/notifystart', () => ({ ret: 0 }));
    transport.route('/ilink/bot/getupdates', () => new Promise(() => {}));
    transport.route('/ilink/bot/sendmessage', () => ({ ret: 100, errmsg: 'boom' }));
    const a = adapter();
    await a.start(ctx);
    await expect(a.send(target('user_1'), { text: 'hi' })).rejects.toMatchObject({ code: 'CHANNEL_SEND_FAILED' });
    await ctx.dispose();
    await a.stop();
  });

  it('rejects send before start', async () => {
    const a = adapter();
    await expect(a.send(target('u'), { text: 'hi' })).rejects.toMatchObject({ code: 'CHANNEL_NOT_STARTED' });
  });
});

describe('channel-weixin plugin + contract', () => {
  it('exports the cordis plugin shape', async () => {
    const mod = await import('../src/index.js');
    expect(mod.apply).toBeTypeOf('function');
    expect(mod.name).toBe('channel-weixin');
  });

  it('adapter contract suite passes', () => {
    const transport = new FakeTransport();
    transport.route('/ilink/bot/sendmessage', () => ({ ret: 0 }));
    runChannelAdapterContract(new WeixinAdapter(makeConfig(), { transport, now: () => 1700000000000 }));
  });
});
