/**
 * M7C: `DingTalkOpenApiPortImpl` — method inventory + official-behavior basis
 * (plan §33) and media upload/send (plan §86). Fully offline (fake transport).
 */
import { describe, expect, it } from 'vitest';
import type { ChannelTarget } from '@wsz987/channel-core';
import { ChannelError } from '@wsz987/channel-core';
import {
  DingTalkOpenApiPortImpl,
  OFFICIAL_BASIS,
  type HttpRequestInit,
  type HttpTransport,
} from '../src/index.ts';
import type { DingTalkOpenApiPort } from '../src/index.ts';

const API = 'https://api.dingtalk.com';
const tokenPath = `${API}/v1.0/oauth2/accessToken`;

class FakeTransport implements HttpTransport {
  readonly calls: { path: string; init?: HttpRequestInit }[] = [];
  readonly routes = new Map<string, () => unknown>();

  route(path: string, response: () => unknown): this {
    this.routes.set(path, response);
    return this;
  }

  request(path: string, init?: HttpRequestInit): Promise<unknown> {
    this.calls.push({ path, init });
    const handler = this.routes.get(path);
    if (!handler) return Promise.reject(new ChannelError('CHANNEL_ERROR', `no route for ${path}`));
    return Promise.resolve(handler());
  }
}

function target(raw: Record<string, unknown> = {}): ChannelTarget {
  return {
    channelId: 'dingtalk' as never,
    accountId: 'main' as never,
    conversationId: 'cid_123' as never,
    conversationType: 'dm',
    raw,
  };
}

/** The full method surface the port must expose (plan §33 + §32A). */
const PORT_METHODS = [
  'getAccessToken',
  'sendProactiveText',
  'uploadMedia',
  'sendMedia',
  'createCard',
  'updateCard',
  'finishCard',
  'resolveMedia',
  'getMediaDownloadUrl',
];

describe('DingTalkOpenApiPortImpl — method inventory (plan §33)', () => {
  it('exposes the full DingTalkOpenApiPort interface (shape)', () => {
    const port: DingTalkOpenApiPort = new DingTalkOpenApiPortImpl({
      transport: new FakeTransport(),
      clientId: 'ding-app',
      clientSecret: 'secret',
    });
    for (const method of PORT_METHODS) {
      expect(typeof (port as unknown as Record<string, unknown>)[method], method).toBe('function');
    }
  });

  it('every port method documents an official-behavior basis (marker presence)', () => {
    for (const method of PORT_METHODS) {
      const basis = OFFICIAL_BASIS[method];
      expect(basis, method).toBeDefined();
      expect(basis!.trim().length, method).toBeGreaterThan(0);
      // Every entry either names the official connector oracle/endpoint,
      // or is an explicit upstream-gap/deprecated marker with a reason.
      const hasBasis =
        basis!.includes('@dingtalk-real-ai/dingtalk-connector') ||
        basis!.includes('@upstream-gap') ||
        basis!.includes('@deprecated');
      expect(hasBasis, `${method}: ${basis}`).toBe(true);
    }
  });

  it('opaque media resolution follows the official downloadCode flow (M2A fix)', async () => {
    // Official basis: connector downloadMediaByCode/getFileDownloadUrl —
    // POST /v1.0/robot/messageFiles/download {downloadCode, robotCode} ->
    // {downloadUrl} -> GET raw bytes.
    expect(OFFICIAL_BASIS.resolveMedia).toContain('@dingtalk-real-ai/dingtalk-connector');
    expect(OFFICIAL_BASIS.getMediaDownloadUrl).toContain('@dingtalk-real-ai/dingtalk-connector');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const transport = new FakeTransport()
      .route(tokenPath, () => ({ accessToken: 'token-1', expireIn: 7200 }))
      .route(`${API}/v1.0/robot/messageFiles/download`, () => ({ downloadUrl: 'https://dl.example.com/pic' }))
      .route('https://dl.example.com/pic', () => png);
    const port = new DingTalkOpenApiPortImpl({
      transport,
      clientId: 'ding-app',
      clientSecret: 'secret',
      now: () => 1_000,
    });
    const resolved = await port.resolveMedia('@lADP-media', {
      downloadCode: 'dl-code-1',
      robotCode: 'callback-robot-code-must-not-win',
    });
    expect(resolved.data).toEqual(png);
    expect(resolved.mimeType).toBe('image/png');
    expect(resolved.size).toBe(png.byteLength);
    const downloadCall = transport.calls.find((c) => c.path.endsWith('/messageFiles/download'));
    expect(downloadCall?.init?.body).toEqual({ downloadCode: 'dl-code-1', robotCode: 'ding-app' });
    const bytesCall = transport.calls.find((c) => c.path === 'https://dl.example.com/pic');
    expect(bytesCall?.init?.responseType).toBe('arraybuffer');
  });

  it('resolves an embedded richText downloadCode reference', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const transport = new FakeTransport()
      .route(tokenPath, () => ({ accessToken: 'token-1', expireIn: 7200 }))
      .route(`${API}/v1.0/robot/messageFiles/download`, () => ({ downloadUrl: 'https://dl.example.com/rich' }))
      .route('https://dl.example.com/rich', () => png);
    const port = new DingTalkOpenApiPortImpl({ transport, clientId: 'ding-app', clientSecret: 'secret' });
    await port.resolveMedia('downloadCode:dl-rich');
    const call = transport.calls.find((entry) => entry.path.endsWith('/messageFiles/download'));
    expect(call?.init?.body).toEqual({ downloadCode: 'dl-rich', robotCode: 'ding-app' });
  });

  it('opaque media resolution without downloadCode fails closed (no invented protocol)', async () => {
    const port = new DingTalkOpenApiPortImpl({ transport: new FakeTransport(), clientId: 'a', clientSecret: 'b' });
    await expect(port.resolveMedia('mediaId_1')).rejects.toThrow('downloadCode');
  });

  it('resolveMedia passes a genuine http(s) ref through directly', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
    const transport = new FakeTransport()
      .route('https://cdn.example.com/a.jpg', () => jpeg);
    const port = new DingTalkOpenApiPortImpl({ transport, clientId: 'a', clientSecret: 'b' });
    const resolved = await port.resolveMedia('https://cdn.example.com/a.jpg');
    expect(resolved.data).toEqual(jpeg);
    expect(resolved.mimeType).toBe('image/jpeg');
  });
});

describe('DingTalkOpenApiPortImpl — media upload/send (plan §86)', () => {
  it('uploadMedia then sendMedia: upload called first, mediaId flows into send', async () => {
    const transport = new FakeTransport()
      .route(tokenPath, () => ({ accessToken: 'token-1', expireIn: 7200 }))
      .route(`${API}/v1.0/robot/messageFiles/uploadRobotFile`, () => ({ mediaId: 'media_abc' }))
      .route(`${API}/v1.0/robot/groupMessages/send`, () => ({ messageId: 'msg_1' }));
    const port = new DingTalkOpenApiPortImpl({
      transport,
      clientId: 'ding-app',
      clientSecret: 'secret',
      now: () => 1_000,
    });

    const uploaded = await port.uploadMedia({
      robotCode: 'ding-app',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      data: new Uint8Array([10, 20, 30]),
    });
    expect(uploaded.mediaId).toBe('media_abc');

    const sent = await port.sendMedia({
      conversationId: 'cid_1',
      robotCode: 'ding-app',
      mediaId: uploaded.mediaId,
      msgtype: 'file',
      name: 'report.pdf',
    });
    expect(sent.messageId).toBe('msg_1');

    // Official method mapping: upload endpoint first, then robot groupMessages/send
    // carrying the SAME mediaId returned by the upload.
    const uploadCall = transport.calls.find((c) => c.path.includes('/messageFiles/uploadRobotFile'));
    const sendCall = transport.calls.find((c) => c.path.includes('/v1.0/robot/groupMessages/send'));
    expect(uploadCall).toBeDefined();
    expect(uploadCall!.init!.body).toMatchObject({ agentId: 'ding-app', robotCode: 'ding-app', filename: 'report.pdf' });
    expect(sendCall).toBeDefined();
    const msgParam = JSON.parse((sendCall!.init!.body as Record<string, string>).msgParam);
    expect(msgParam).toEqual({ fileName: 'report.pdf', fileMediaId: 'media_abc', fileSize: 0 });
    expect((sendCall!.init!.body as Record<string, unknown>).msgKey).toBe('sampleFile');
    expect(sendCall!.init!.headers?.['x-acs-dingtalk-access-token']).toBe('token-1');
  });

  it('rejects a media upload response missing mediaId', async () => {
    const transport = new FakeTransport()
      .route(tokenPath, () => ({ accessToken: 'token-1', expireIn: 7200 }))
      .route(`${API}/v1.0/robot/messageFiles/uploadRobotFile`, () => ({ ok: true }));
    const port = new DingTalkOpenApiPortImpl({ transport, clientId: 'a', clientSecret: 'b' });
    await expect(port.uploadMedia({ robotCode: 'a', fileName: 'x.bin', data: new Uint8Array([1]) }))
      .rejects.toThrow('missing mediaId');
  });
});
