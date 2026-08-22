/**
 * upstream-facade.test.ts — Weixin upstream facade (plan §96) + plan §78
 * zero-regression image ingress baseline.
 *
 * Two directions:
 *
 *   A. FakeWeixinUpstream driving the adapter (plan §96): a fake implements the
 *      `WeixinUpstream` port and is injected via `WeixinAdapterDeps.upstream`.
 *      Asserts the adapter routes its sends to the facade (sendImage for an
 *      image part, sendText for plain text) with the image localData passed
 *      through unchanged.
 *
 *   B. Real adapter + real facade end-to-end image ingress: an inbound
 *      getUpdates image message is hydrated through the facade's downloadImage
 *      (official AES decrypt) and the emitted event's image part.localData
 *      equals the decrypted plaintext — the plan §78 baseline:
 *
 *          Weixin image → localData → saveImage() → ImageBlock
 *
 *      (channel-harness asserts the saveImage / ImageBlock tail; this file
 *      asserts the localData head stays byte-identical.)
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService } from '@wsz987/channel-core';
import type { ChannelAdapterContext, ChannelTarget } from '@wsz987/channel-core';
import { createTestContext } from '@wsz987/channel-testkit';
import { WeixinAdapter } from '../src/adapter.js';
import { Config } from '../src/config.js';
import type { WeixinConfig } from '../src/config.js';
import type { HttpTransport } from '../src/index.js';
import { aes128Encrypt } from '../src/index.js';
import { AccountCredentialStore } from '../src/auth/account-store.js';
import { TencentWeixinUpstream } from '../src/upstream/tencent-upstream.js';
import type {
  WeixinQrTicket,
  WeixinQrAuthPoll,
  WeixinMediaRef,
  WeixinDownloadResult,
  WeixinSendResult,
  WeixinUpstreamHostEnv,
} from '../src/upstream/port.js';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

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
/* FakeWeixinUpstream — satisfies the adapter's AdapterUpstreamLike     */
/* ------------------------------------------------------------------ */

class FakeWeixinUpstream {
  readonly id = 'weixin';
  readonly calls: string[] = [];
  sendImageCalls: { to: string; data: Uint8Array; mimeType?: string; runId?: string }[] = [];
  sendTextCalls: { to: string; text: string; runId?: string }[] = [];
  credentialLoaded = false;

  async beginQrAuth(): Promise<WeixinQrTicket> { this.calls.push('beginQrAuth'); return { id: 't1', qrUrl: 'u', instruction: 'i', expiresAt: 0 }; }
  async pollQrAuth(_t: string): Promise<WeixinQrAuthPoll> { this.calls.push('pollQrAuth'); return { state: 'pending' }; }
  submitVerifyCode(): void { this.calls.push('submitVerifyCode'); }
  async startMonitor(): Promise<void> { this.calls.push('startMonitor'); }
  async stopMonitor(): Promise<void> { this.calls.push('stopMonitor'); }
  hasCredential(): boolean { return this.credentialLoaded; }
  async loadCredential(): Promise<boolean> { this.calls.push('loadCredential'); return this.credentialLoaded; }

  async sendText(p: { to: string; text: string; runId?: string }): Promise<WeixinSendResult> {
    this.calls.push('sendText');
    this.sendTextCalls.push(p);
    return { delivered: true, messageId: 't-' + p.text.length };
  }
  async sendImage(p: { to: string; data: Uint8Array; mimeType?: string; runId?: string }): Promise<WeixinSendResult> {
    this.calls.push('sendImage');
    this.sendImageCalls.push({ to: p.to, data: p.data, mimeType: p.mimeType, runId: p.runId });
    return { delivered: true, messageId: 'img' };
  }
  async sendFile(): Promise<WeixinSendResult> { this.calls.push('sendFile'); return { delivered: true, messageId: 'file' }; }
  async sendVideo(): Promise<WeixinSendResult> { this.calls.push('sendVideo'); return { delivered: true, messageId: 'video' }; }

  async downloadImage(ref: WeixinMediaRef): Promise<WeixinDownloadResult> {
    this.calls.push('downloadImage');
    return { data: new Uint8Array([1, 2, 3, 4]), mimeType: ref.mimeType ?? 'image/jpeg' };
  }
  async downloadFile(ref: WeixinMediaRef): Promise<WeixinDownloadResult> {
    this.calls.push('downloadFile');
    return { data: new Uint8Array([1, 2, 3, 4]), mimeType: ref.mimeType };
  }
  async downloadAudio(ref: WeixinMediaRef): Promise<WeixinDownloadResult> {
    this.calls.push('downloadAudio');
    return { data: new Uint8Array([1, 2, 3, 4]), mimeType: ref.mimeType };
  }
  async downloadVideo(ref: WeixinMediaRef): Promise<WeixinDownloadResult> {
    this.calls.push('downloadVideo');
    return { data: new Uint8Array([1, 2, 3, 4]), mimeType: ref.mimeType };
  }

  bind(_env: WeixinUpstreamHostEnv): void { this.calls.push('bind'); }
  async startTyping(): Promise<void> { this.calls.push('startTyping'); }
  async stopTyping(): Promise<void> { this.calls.push('stopTyping'); }
  async getHealthInfo(): Promise<{ authenticated: boolean; connection: string }> {
    return { authenticated: this.credentialLoaded, connection: 'connected' };
  }
  get_iLinkClient(): undefined { return undefined; }
}

/* ------------------------------------------------------------------ */
/* A. Adapter ↔ facade boundary (FakeWeixinUpstream)                   */
/* ------------------------------------------------------------------ */

describe('FakeWeixinUpstream driving the adapter (plan §96)', () => {
  let fake: FakeWeixinUpstream;

  beforeEach(() => { fake = new FakeWeixinUpstream(); });

  function adapter(): WeixinAdapter {
    return new WeixinAdapter(makeConfig(), { upstream: fake as any, now: () => 1700000000000 });
  }

  it('adapter image send routes to facade.sendImage with localData unchanged', async () => {
    const ctx = createTestContext(new ChannelService(new Context()));
    fake.credentialLoaded = true;
    const a = adapter();
    await a.start(ctx);

    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    const result = await a.send(target('user_1'), { parts: [{ type: 'image', localData: bytes, mimeType: 'image/png' }] } as any);
    expect(result.delivered).toBe(true);
    expect(fake.calls).toContain('sendImage');
    expect(fake.sendImageCalls).toHaveLength(1);
    // localData flows through unchanged (same ArrayBuffer reference).
    expect(fake.sendImageCalls[0]!.data).toBe(bytes);
    expect(fake.sendImageCalls[0]!.mimeType).toBe('image/png');
    await ctx.dispose();
    await a.stop();
  });

  it('adapter sends caption text before media as separate upstream requests', async () => {
    const ctx = createTestContext(new ChannelService(new Context()));
    fake.credentialLoaded = true;
    const a = adapter();
    await a.start(ctx);

    await a.send(target('user_1'), {
      text: 'caption',
      parts: [{ type: 'image', localData: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }],
    } as any);

    expect(fake.calls.filter((call) => call === 'sendText' || call === 'sendImage')).toEqual(['sendText', 'sendImage']);
    expect(fake.sendTextCalls[0]?.text).toBe('caption');
    await ctx.dispose();
    await a.stop();
  });

  it('adapter sends every media part in source order and returns the last message id', async () => {
    const ctx = createTestContext(new ChannelService(new Context()));
    fake.credentialLoaded = true;
    const a = adapter();
    await a.start(ctx);

    const result = await a.send(target('user_1'), {
      text: 'caption',
      parts: [
        { type: 'file', localData: new Uint8Array([1]), name: 'one.txt' },
        { type: 'image', localData: new Uint8Array([2]), mimeType: 'image/png' },
        { type: 'video', localData: new Uint8Array([3]), mimeType: 'video/mp4' },
      ],
    });

    expect(fake.calls.filter((call) => ['sendText', 'sendFile', 'sendImage', 'sendVideo'].includes(call)))
      .toEqual(['sendText', 'sendFile', 'sendImage', 'sendVideo']);
    expect(result).toMatchObject({ delivered: true, messageId: 'video' });
    await ctx.dispose();
    await a.stop();
  });

  it('adapter text send routes to facade.sendText', async () => {
    const ctx = createTestContext(new ChannelService(new Context()));
    fake.credentialLoaded = true;
    const a = adapter();
    await a.start(ctx);

    const result = await a.send(target('user_1'), { text: 'hello' });
    expect(result.delivered).toBe(true);
    expect(fake.calls).toContain('sendText');
    expect(fake.sendTextCalls).toHaveLength(1);
    expect(fake.sendTextCalls[0]!.text).toBe('hello');
    await ctx.dispose();
    await a.stop();
  });
});

/* ------------------------------------------------------------------ */
/* B. Real adapter + real facade end-to-end image ingress regression   */
/* ------------------------------------------------------------------ */

interface FakeHandlerInit { body?: unknown; headers?: Record<string, string> }

class FakeTransport implements HttpTransport {
  routeByPath = new Map<string, (init?: FakeHandlerInit, signal?: AbortSignal) => unknown>();
  calls: { url: string; init?: FakeHandlerInit; signal?: AbortSignal }[] = [];

  route(path: string, handler: (init?: FakeHandlerInit, signal?: AbortSignal) => unknown): this {
    this.routeByPath.set(path, handler);
    return this;
  }
  async request(url: string, init?: FakeHandlerInit, signal?: AbortSignal): Promise<unknown> {
    this.calls.push({ url, init, signal });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const path = pathOf(url);
    const handler = this.routeByPath.get(path);
    if (!handler) throw new Error('no route for ' + path);
    return handler(init, signal);
  }
}
function pathOf(url: string): string {
  try { const u = new URL(url); return u.pathname + (u.search ? u.search : ''); } catch { return url; }
}

const HEX_KEY = '00112233445566778899aabbccddeeff';
const KEY_BUF = Buffer.from(HEX_KEY, 'hex');
const PLAIN_BYTES = Buffer.from('hello weixin image plaintext', 'utf-8');

describe('real adapter image ingress → localData unchanged (plan §78)', () => {
  let transport: FakeTransport;
  const OLD_FETCH = globalThis.fetch;

  beforeEach(() => { transport = new FakeTransport(); });
  afterEach(() => { (globalThis as any).fetch = OLD_FETCH; });

  function adapter(): WeixinAdapter {
    return new WeixinAdapter(makeConfig(), { transport, now: () => 1700000000000, rand: () => 0.5 });
  }

  const credential = {
    token: 'bot-token-secret', ilinkBotId: 'bot-1', userId: 'wx-user',
    baseUrl: 'https://fake.ilink.test', savedAt: new Date(1700000000000).toISOString(),
  };

  async function seedCredential(ctx: ChannelAdapterContext) {
    const store = new AccountCredentialStore({ secrets: ctx.secrets, storage: ctx.storage, accountId: 'main', now: () => 1700000000000 });
    await store.save(credential);
  }

  it('rejects unsafe CDN URLs before issuing a network request', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const upstream = new TencentWeixinUpstream({ config: makeConfig(), fetchImpl: fetchImpl as typeof fetch });
    await expect(upstream.downloadFile({ fullUrl: 'http://127.0.0.1/private.pdf' })).rejects.toThrow(/http scheme requires explicit allowHttp/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('hydrates an inbound image through the facade and emits localData byte-identical', async () => {
    const cipher = aes128Encrypt(PLAIN_BYTES, KEY_BUF);
    const cdnCalls: string[] = [];
    (globalThis as any).fetch = async (url: unknown) => {
      cdnCalls.push(String(url));
      return new Response(new Uint8Array(cipher), { status: 200 }) as unknown as Response;
    };

    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    await seedCredential(ctx);

    let calls = 0;
    transport.route('/ilink/bot/msg/notifystart', () => ({ ret: 0 }));
    transport.route('/ilink/bot/msg/notifystop', () => ({ ret: 0 }));
    transport.route('/ilink/bot/getupdates', () => {
      calls += 1;
      if (calls === 1) {
        return {
          ret: 0,
          msgs: [{
            message_id: 99,
            from_user_id: 'user_1',
            create_time_ms: 1700000000000,
            context_token: 'ctx-1',
            item_list: [{
              type: 2,
              image_item: {
                url: 'https://c/i',
                aeskey: HEX_KEY,
                media: { full_url: 'https://c/i?enc=1', encrypt_query_param: 'x', aes_key: '' },
              },
            }],
          }],
          get_updates_buf: 'buf-next',
        };
      }
      return new Promise(() => { /* hold long-poll open */ });
    });

    const events: any[] = [];
    service.on((...args: any[]) => events.push(args[0]));
    const a = adapter();
    await a.start(ctx);
    await vi.waitFor(
      () => expect(events.some((e) => e?.type === 'message.received')).toBe(true),
      { timeout: 3000 },
    );

    const event = events.find((e) => e?.type === 'message.received');
    const imagePart = (event.message.content as any[]).find((p) => p.type === 'image');
    expect(imagePart).toBeDefined();
    // The facade's downloadImage hit the CDN (official AES-decrypt path).
    expect(cdnCalls.length).toBeGreaterThan(0);
    // localData === decrypted plaintext, byte-for-byte.
    const local = Buffer.from(imagePart.localData as Uint8Array);
    expect(local.toString('utf-8')).toBe(PLAIN_BYTES.toString('utf-8'));
    expect(imagePart.mimeType).toBe('image/jpeg');

    await ctx.dispose();
    await a.stop();
  });

  it('keeps the URL-only part when image hydration fails (text-fallback)', async () => {
    (globalThis as any).fetch = async () => { throw new Error('network down'); };

    const service2 = new ChannelService(new Context());
    const ctx2 = createTestContext(service2);
    await seedCredential(ctx2);

    let calls = 0;
    transport.route('/ilink/bot/msg/notifystart', () => ({ ret: 0 }));
    transport.route('/ilink/bot/getupdates', () => {
      calls += 1;
      if (calls === 1) {
        return {
          ret: 0,
          msgs: [{
            message_id: 100,
            from_user_id: 'user_1',
            create_time_ms: 1700000000000,
            item_list: [{ type: 2, image_item: { url: 'https://c/i', media: { full_url: 'https://c/i?enc=1' } } }],
          }],
          get_updates_buf: 'buf',
        };
      }
      return new Promise(() => {});
    });

    const events: any[] = [];
    service2.on((...args: any[]) => events.push(args[0]));
    const a = adapter();
    await a.start(ctx2);
    await vi.waitFor(() => expect(events.some((e) => e?.type === 'message.received')).toBe(true), { timeout: 3000 });
    const event = events.find((e) => e?.type === 'message.received');
    const imagePart = (event.message.content as any[]).find((p) => p.type === 'image');
    expect(imagePart).toBeDefined();
    expect(imagePart.localData).toBeUndefined();
    await ctx2.dispose();
    await a.stop();
  });

  it('hydrates an inbound PDF file with decrypted localData for the generic attachment store', async () => {
    const plaintext = Buffer.from('%PDF-1.7 simulated report');
    const cipher = aes128Encrypt(plaintext, KEY_BUF);
    (globalThis as any).fetch = async () =>
      new Response(new Uint8Array(cipher), { status: 200 }) as unknown as Response;

    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    await seedCredential(ctx);

    let calls = 0;
    transport.route('/ilink/bot/msg/notifystart', () => ({ ret: 0 }));
    transport.route('/ilink/bot/msg/notifystop', () => ({ ret: 0 }));
    transport.route('/ilink/bot/getupdates', () => {
      calls += 1;
      if (calls === 1) {
        return {
          ret: 0,
          msgs: [{
            message_id: 101,
            from_user_id: 'user_1',
            create_time_ms: 1700000000000,
            item_list: [{
              type: 4,
              file_item: {
                file_name: 'report.pdf',
                // Tencent file media uses base64(32 ASCII hex chars), unlike
                // images which commonly use base64(raw 16-byte key).
                media: { full_url: 'https://c/report?enc=1', aes_key: Buffer.from(HEX_KEY, 'ascii').toString('base64') },
              },
            }],
          }],
          get_updates_buf: 'file-buf-next',
        };
      }
      return new Promise(() => {});
    });

    const events: any[] = [];
    service.on((...args: any[]) => events.push(args[0]));
    const a = adapter();
    await a.start(ctx);
    await vi.waitFor(() => expect(events.some((e) => e?.type === 'message.received')).toBe(true), { timeout: 3000 });

    const event = events.find((e) => e?.type === 'message.received');
    const filePart = (event.message.content as any[]).find((p) => p.type === 'file');
    expect(filePart).toMatchObject({ name: 'report.pdf', mimeType: 'application/pdf', size: plaintext.byteLength });
    expect(Buffer.from(filePart.localData as Uint8Array)).toEqual(plaintext);

    await ctx.dispose();
    await a.stop();
  });

  it('hydrates inbound SILK voice and video without shifting media after transcription text', async () => {
    const voicePlain = Buffer.from('fixture silk bytes');
    const videoPlain = Buffer.from('fixture mp4 bytes');
    const encrypted = [aes128Encrypt(voicePlain, KEY_BUF), aes128Encrypt(videoPlain, KEY_BUF)];
    let fetchIndex = 0;
    (globalThis as any).fetch = async () =>
      new Response(new Uint8Array(encrypted[fetchIndex++]!), { status: 200 }) as unknown as Response;

    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    await seedCredential(ctx);
    let calls = 0;
    transport.route('/ilink/bot/msg/notifystart', () => ({ ret: 0 }));
    transport.route('/ilink/bot/msg/notifystop', () => ({ ret: 0 }));
    transport.route('/ilink/bot/getupdates', () => {
      calls += 1;
      if (calls > 1) return new Promise(() => {});
      return {
        ret: 0,
        msgs: [{
          message_id: 102, from_user_id: 'user_1', create_time_ms: 1700000000000,
          item_list: [
            { type: 3, voice_item: { text: 'ASR text', encode_type: 6, sample_rate: 16000, media: { full_url: 'https://c/voice', aes_key: KEY_BUF.toString('base64') } } },
            { type: 5, video_item: { media: { full_url: 'https://c/video', aes_key: KEY_BUF.toString('base64') } } },
          ],
        }],
        get_updates_buf: 'media-buf-next',
      };
    });

    const events: any[] = [];
    service.on((...args: any[]) => events.push(args[0]));
    const a = adapter();
    await a.start(ctx);
    await vi.waitFor(() => expect(events.some((event) => event?.type === 'message.received')).toBe(true), { timeout: 3000 });
    const content = events.find((event) => event?.type === 'message.received').message.content as any[];
    expect(content.find((part) => part.type === 'text')).toMatchObject({ text: 'ASR text' });
    const audio = content.find((part) => part.type === 'audio');
    const video = content.find((part) => part.type === 'video');
    expect(audio).toMatchObject({ mimeType: 'audio/silk' });
    expect(video).toMatchObject({ mimeType: 'video/mp4' });
    expect(Buffer.from(audio.localData)).toEqual(voicePlain);
    expect(Buffer.from(video.localData)).toEqual(videoPlain);
    await ctx.dispose();
    await a.stop();
  });
});
