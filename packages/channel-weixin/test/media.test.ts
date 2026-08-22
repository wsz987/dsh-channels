/**
 * WX5 media + WX5/WX6 unit tests (offline, fake transport).
 *
 * - downloadMedia resolves CDN URL (full_url / cdnBaseUrl + encrypt_query_param)
 *   and AES-128-ECB decrypts with hex aeskey (preferred) or base64 aes_key.
 * - uploadMedia encrypts, calls getuploadurl, posts ciphertext, returns refs.
 * - OutboundSender routes an image part through uploadMedia + sendMedia.
 * - TypingController start/stop is best-effort (sendTyping failure does not
 *   fail the main send).
 * - runId is stable within one turn (target.runId reused across sends).
 */
import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '@wsz987/channel-core';
import type { ChannelTarget } from '@wsz987/channel-core';
import {
  aes128Decrypt,
  aes128Encrypt,
  downloadMedia,
  resolveDownloadUrl,
  uploadMedia,
  buildUploadUrlRequest,
  aesEcbPaddedSize,
  sendMedia,
  buildSendMediaPayload,
  OutboundSender,
  ContextTokenStore,
  TypingController,
  ILinkClient,
  type ILinkCDNMedia,
} from '../src/index.js';

const KEY = '00112233445566778899aabbccddeeff'; // hex, 16 bytes
const KEY_BUF = Buffer.from(KEY, 'hex');

function target(conversationId: string, runId?: string): ChannelTarget {
  return { channelId: 'weixin' as never, accountId: 'main' as never, conversationId: conversationId as never, runId };
}

describe('downloadMedia', () => {
  it('resolves full_url and cdnBaseUrl + encrypt_query_param', () => {
    expect(resolveDownloadUrl({ full_url: 'https://c/img' }, 'https://cdn')).toBe('https://c/img');
    expect(resolveDownloadUrl({ encrypt_query_param: 'abc?x=1' }, 'https://cdn/')).toBe('https://cdn/abc?x=1');
    expect(resolveDownloadUrl({}, 'https://cdn')).toBeUndefined();
  });

  it('downloads and AES-128-ECB decrypts with hex aeskey', async () => {
    const plain = Buffer.from('hello image body');
    const cipher = aes128Encrypt(plain, KEY_BUF);
    const fetchImpl = async () =>
      new Response(new Uint8Array(cipher), { status: 200 }) as unknown as Response;
    const media: ILinkCDNMedia = { encrypt_query_param: 'x' };
    const out = await downloadMedia(media, {
      cdnBaseUrl: 'https://cdn',
      aesKey: KEY,
      mimeType: 'image/jpeg',
      fetchImpl,
    });
    expect(out.data.toString('utf-8')).toBe('hello image body');
    expect(out.mimeType).toBe('image/jpeg');
  });

  it('decrypts with base64 aes_key when no hex aeskey', async () => {
    const plain = Buffer.from('body2');
    const cipher = aes128Encrypt(plain, KEY_BUF);
    const fetchImpl = async () =>
      new Response(new Uint8Array(cipher), { status: 200 }) as unknown as Response;
    const media: ILinkCDNMedia = { encrypt_query_param: 'x', aes_key: KEY_BUF.toString('base64') };
    const out = await downloadMedia(media, { cdnBaseUrl: 'https://cdn', fetchImpl });
    expect(out.data.toString('utf-8')).toBe('body2');
  });

  it('returns bytes untouched when no AES key is available', async () => {
    const body = Buffer.from('plaintext-no-key');
    const fetchImpl = async () => new Response(new Uint8Array(body), { status: 200 }) as unknown as Response;
    const out = await downloadMedia({ full_url: 'https://c/i' }, { cdnBaseUrl: 'https://cdn', fetchImpl });
    expect(out.data.toString('utf-8')).toBe('plaintext-no-key');
  });

  it('throws when no resolvable URL and no key target', async () => {
    await expect(downloadMedia({}, { cdnBaseUrl: 'https://cdn' })).rejects.toThrow(/full_url/);
  });
});

describe('uploadMedia', () => {
  it('encrypts, calls getuploadurl, posts ciphertext, returns refs', async () => {
    const file = Buffer.from('image bytes');
    let posted: FormData | undefined;
    let uploadRequest: Record<string, unknown> | undefined;
    const uploaded = await uploadMedia(file, {
      cdnBaseUrl: 'https://cdn',
      apiBaseUrl: 'https://api',
      toUserId: 'user_1',
      filekey: 'fk-1',
      now: () => 1234,
      getUploadUrl: async (req) => {
        uploadRequest = req;
        expect(req.to_user_id).toBe('user_1');
        expect(req.filekey).toBe('fk-1');
        return { upload_full_url: 'https://cdn/put', upload_param: 'up-enc', thumb_upload_param: 'th' };
      },
      upload: async (_url, form) => {
        posted = form;
        return new Response(null, { status: 200, headers: { 'x-encrypted-param': 'download-enc' } }) as unknown as Response;
      },
    });
    expect(uploaded.filekey).toBe('fk-1');
    expect(uploaded.uploadFullUrl).toBe('https://cdn/put');
    expect(uploaded.downloadEncryptedQueryParam).toBe('download-enc');
    expect(uploaded.aeskey).toMatch(/^[0-9a-f]{32}$/);
    expect(uploaded.fileSize).toBe(file.length);
    expect(uploaded.fileSizeCiphertext).toBeGreaterThan(file.length); // padded
    expect(uploadRequest).toMatchObject({
      media_type: 1,
      rawsize: file.length,
      filesize: uploaded.fileSizeCiphertext,
      aeskey: uploaded.aeskey,
    });
    expect(posted).toBeDefined();
  });

  it('builds the upload url request with a media digest', () => {
    const req = buildUploadUrlRequest(Buffer.from('data'), { cdnBaseUrl: 'c', apiBaseUrl: 'a', now: () => 5 });
    expect(req.media_type).toBe(1);
    expect(req.rawsize).toBe(4);
    expect(req.filesize).toBe(16);
    expect(req.aeskey).toMatch(/^[0-9a-f]{32}$/);
    expect(req.rawfilemd5).toBeTypeOf('string');
    expect(String(req.filekey)).toContain('wx5-');
  });

  it('calculates AES-ECB PKCS#7 ciphertext sizes', () => {
    expect(aesEcbPaddedSize(0)).toBe(16);
    expect(aesEcbPaddedSize(15)).toBe(16);
    expect(aesEcbPaddedSize(16)).toBe(32);
  });

  it('derives the CDN upload URL when only upload_param is returned', async () => {
    let receivedUrl: string | undefined;
    await uploadMedia(Buffer.from('data'), {
      cdnBaseUrl: 'https://cdn.example/',
      apiBaseUrl: 'https://api',
      filekey: 'file key',
      getUploadUrl: async () => ({ upload_param: 'upload param' }),
      upload: async (url) => {
        receivedUrl = url;
        return new Response(null, { status: 200, headers: { 'x-encrypted-param': 'download-param' } });
      },
    });
    expect(receivedUrl).toBe('https://cdn.example/upload?encrypted_query_param=upload%20param&filekey=file%20key');
  });

  it('rejects empty file with CHANNEL_UNSUPPORTED', async () => {
    await expect(uploadMedia(Buffer.alloc(0), { cdnBaseUrl: 'c', apiBaseUrl: 'a' })).rejects.toMatchObject({ code: 'CHANNEL_UNSUPPORTED' });
  });
});

describe('sendMedia / buildSendMediaPayload', () => {
  it('builds an image item sendmessage payload with media + run_id', () => {
    const payload = buildSendMediaPayload({
      to: 'user_1',
      media: { encrypt_query_param: 'e', aes_key: 'ak' },
      runId: 'run-9',
    }) as any;
    expect(payload.msg.to_user_id).toBe('user_1');
    expect(payload.msg.run_id).toBe('run-9');
    expect(payload.msg.item_list).toEqual([{
      type: 2,
      image_item: {
        media: { encrypt_query_param: 'e', aes_key: 'ak', encrypt_type: 1 },
        mid_size: 0,
      },
    }]);
  });

  it('builds Tencent 2.4.6 file and video item shapes', () => {
    const file = buildSendMediaPayload({
      kind: 'file', to: 'user_1', media: { encrypt_query_param: 'e', aes_key: 'ak' },
      fileName: 'report.pdf', fileSize: 1024, fileSizeCiphertext: 1040,
    }) as any;
    expect(file.msg.item_list).toEqual([{
      type: 4,
      file_item: {
        media: { encrypt_query_param: 'e', aes_key: 'ak', encrypt_type: 1 },
        file_name: 'report.pdf', len: '1024',
      },
    }]);

    const video = buildSendMediaPayload({
      kind: 'video', to: 'user_1', media: { encrypt_query_param: 'e', aes_key: 'ak' }, fileSizeCiphertext: 2080,
    }) as any;
    expect(video.msg.item_list).toEqual([{
      type: 5,
      video_item: {
        media: { encrypt_query_param: 'e', aes_key: 'ak', encrypt_type: 1 },
        video_size: 2080,
      },
    }]);
  });
});

describe('OutboundSender image path', () => {
  it('uploads and sends an image part', async () => {
    const storage = new MemoryStorage();
    const ct = new ContextTokenStore({ storage, accountId: 'main' });
    await ct.set('user_1', 'ctx-7');

    const sent: any[] = [];
    const client = {
      cdnUrl: 'https://cdn',
      baseUrl: 'https://api',
      token: undefined,
      sendMessage: async (payload: any) => { sent.push(payload); return { ret: 0 }; },
    } as any;

    // Patch uploadMedia via the real fake fetch is awkward; instead assert the
    // image path is attempted by observing the sender throws on empty localData?
    // We instead give real bytes and stub the upload through a subclass seam.

    const sender = new OutboundSender({
      client,
      contextTokens: ct,
      cdnBaseUrl: 'https://cdn',
      apiBaseUrl: 'https://api',
      getUploadUrl: async () => ({ upload_full_url: 'https://cdn/put', upload_param: 'up-enc' }),
      upload: async () => new Response(null, { status: 200, headers: { 'x-encrypted-param': 'download-enc' } }) as unknown as Response,
    });
    const file = Buffer.from('fake-image-bytes');
    const result = await sender.send(target('user_1', 'run-1'), { parts: [{ type: 'image', url: 'u', mimeType: 'image/jpeg', localData: file }] } as any);
    expect(result.delivered).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].msg.item_list[0].type).toBe(2);
    expect((sent[0].msg.item_list[0] as any).image_item.media.encrypt_query_param).toBeTruthy();
    expect((sent[0].msg.item_list[0] as any).image_item.media.aes_key).toBeTruthy();
    expect(sent[0].msg.run_id).toBe('run-1');
  });

  it('sends caption text before media and encodes the ASCII hex AES key', async () => {
    const storage = new MemoryStorage();
    const ct = new ContextTokenStore({ storage, accountId: 'main' });
    const sent: any[] = [];
    let uploadSlotCalls = 0;
    const client = {
      cdnUrl: 'https://cdn',
      baseUrl: 'https://api',
      token: undefined,
      sendMessage: async (payload: any) => { sent.push(payload); return { ret: 0 }; },
      getUploadUrl: async () => {
        uploadSlotCalls += 1;
        return { upload_full_url: 'https://cdn/put', upload_param: 'up-enc' };
      },
    } as any;
    const sender = new OutboundSender({
      client,
      contextTokens: ct,
      upload: async () => new Response(null, { status: 200, headers: { 'x-encrypted-param': 'download-enc' } }),
    });

    await sender.send(target('user_1', 'run-caption'), {
      text: 'caption',
      parts: [{ type: 'image', localData: Buffer.from('image'), mimeType: 'image/jpeg' }],
    } as any);

    expect(sent.map((payload) => payload.msg.item_list[0].type)).toEqual([1, 2]);
    expect(sent[0].msg.item_list[0].text_item.text).toBe('caption');
    const encodedKey = sent[1].msg.item_list[0].image_item.media.aes_key;
    expect(Buffer.from(encodedKey, 'base64').toString('ascii')).toMatch(/^[0-9a-f]{32}$/);
    expect(sent.map((payload) => payload.msg.run_id)).toEqual(['run-caption', 'run-caption']);
    expect(uploadSlotCalls).toBe(1);
  });

  it('uploads and sends every media part in source order', async () => {
    const storage = new MemoryStorage();
    const ct = new ContextTokenStore({ storage, accountId: 'main' });
    const sent: any[] = [];
    let uploadSlotCalls = 0;
    const client = {
      cdnUrl: 'https://cdn',
      baseUrl: 'https://api',
      token: undefined,
      sendMessage: async (payload: any) => { sent.push(payload); return { ret: 0 }; },
      getUploadUrl: async () => {
        uploadSlotCalls += 1;
        return { upload_full_url: 'https://cdn/put', upload_param: 'up-enc' };
      },
    } as any;
    const sender = new OutboundSender({
      client,
      contextTokens: ct,
      upload: async () => new Response(null, { status: 200, headers: { 'x-encrypted-param': 'download-enc' } }),
    });

    const result = await sender.send(target('user_1', 'run-multi'), {
      text: 'caption',
      parts: [
        { type: 'file', localData: Buffer.from('file'), name: 'one.txt' },
        { type: 'image', localData: Buffer.from('image'), mimeType: 'image/jpeg' },
        { type: 'video', localData: Buffer.from('video'), mimeType: 'video/mp4' },
      ],
    });

    expect(sent.map((payload) => payload.msg.item_list[0].type)).toEqual([1, 4, 2, 5]);
    expect(sent.map((payload) => payload.msg.run_id)).toEqual([
      'run-multi', 'run-multi', 'run-multi', 'run-multi',
    ]);
    expect(uploadSlotCalls).toBe(3);
    expect(result.messageId).toBe(sent[3].msg.client_id);
  });
});

describe('TypingController best-effort', () => {
  it('start/stop swallow sendTyping failures (never throws)', async () => {
    const client = { sendTyping: async () => { throw new Error('boom'); } } as any;
    const tc = new TypingController({ client, enabled: true, typingTicket: 'ticket' });
    await expect(tc.start('user_1')).resolves.toBeUndefined();
    await expect(tc.stop('user_1')).resolves.toBeUndefined();
    expect(tc.isActive).toBe(false);
  });

  it('is a no-op when disabled', async () => {
    let calls = 0;
    const client = { sendTyping: async () => { calls += 1; } } as any;
    const tc = new TypingController({ client, enabled: false });
    await tc.start('u');
    await tc.stop('u');
    expect(calls).toBe(0);
  });

  it('main send continues even when typing is unavailable', async () => {
    // Regression: a typing failure must not fail the text send.
    const storage = new MemoryStorage();
    const ct = new ContextTokenStore({ storage, accountId: 'main' });
    const sent: any[] = [];
    const client = { sendMessage: async (p: any) => { sent.push(p); return { ret: 0 }; }, sendTyping: async () => { throw new Error('nope'); } } as any;
    const typing = new TypingController({ client, enabled: true });
    await typing.start('user_1'); // best-effort, swallows
    const sender = new OutboundSender({ client, contextTokens: ct });
    const result = await sender.send(target('user_1'), { text: 'hi' });
    expect(result.delivered).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

describe('runId correlation', () => {
  it('reuses target.runId across sends within one turn', async () => {
    const storage = new MemoryStorage();
    const ct = new ContextTokenStore({ storage, accountId: 'main' });
    const sent: any[] = [];
    const client = { sendMessage: async (p: any) => { sent.push(p); return { ret: 0 }; } } as any;
    const sender = new OutboundSender({ client, contextTokens: ct });
    await sender.send(target('user_1', 'run-t'), { text: 'a' });
    await sender.send(target('user_1', 'run-t'), { text: 'b' });
    expect(sent.map((s) => s.msg.run_id)).toEqual(['run-t', 'run-t']);
  });

  it('falls back to a fresh UUID when no runId is supplied', async () => {
    const storage = new MemoryStorage();
    const ct = new ContextTokenStore({ storage, accountId: 'main' });
    const sent: any[] = [];
    const client = { sendMessage: async (p: any) => { sent.push(p); return { ret: 0 }; } } as any;
    const sender = new OutboundSender({ client, contextTokens: ct });
    await sender.send(target('user_1'), { text: 'a' });
    await sender.send(target('user_1'), { text: 'b' });
    expect(sent[0].msg.run_id).toBeTruthy();
    expect(sent[0].msg.run_id).not.toBe(sent[1].msg.run_id);
  });
});
