/**
 * `LarkOpenApiOutbound` tests (offline, fake OpenAPI client) — release R7B.
 *
 * Verifies the official-OpenAPI outbound leg: text send, image send (upload →
 * image_key → image message), interactive card create/update/finish/fail,
 * `receive_id_type` resolution, image-byte resolution (dataUri / url), and the
 * credentials-never-leak guarantee (the client never sees secrets here — it is
 * built elsewhere from config).
 */
import { describe, expect, it } from 'vitest';
import { ChannelError } from '@wsz987/channel-core';
import {
  LarkOpenApiOutbound,
  receiveIdType,
  fileTypeFromName,
  cardContent,
  type LarkApiResponse,
  type LarkCreateImagePayload,
  type LarkCreateImageResult,
  type LarkCreateFilePayload,
  type LarkCreateFileResult,
  type LarkCreateMessagePayload,
  type LarkCreateMessageResult,
  type LarkPatchMessagePayload,
  type LarkOpenApiClient,
} from '../src/index.ts';

/** Deterministic fake OpenAPI client recording every call. */
class FakeOpenApiClient implements LarkOpenApiClient {
  calls: { method: string; payload?: unknown }[] = [];
  messageCreateResult: LarkApiResponse<LarkCreateMessageResult> = {
    code: 0,
    data: { message_id: 'om_out_1' },
  };
  imageCreateResult: LarkCreateImageResult | null = { image_key: 'img_v2_out' };
  fileCreateResult: LarkCreateFileResult | null = { file_key: 'file_v2_out' };

  im = {
    v1: {
      message: {
        create: async (payload: LarkCreateMessagePayload) => {
          this.calls.push({ method: 'message.create', payload });
          return this.messageCreateResult;
        },
        patch: async (payload: LarkPatchMessagePayload) => {
          this.calls.push({ method: 'message.patch', payload });
          return { code: 0 };
        },
      },
      image: {
        create: async (payload: LarkCreateImagePayload) => {
          this.calls.push({ method: 'image.create', payload });
          return this.imageCreateResult;
        },
      },
      file: {
        create: async (payload: LarkCreateFilePayload) => {
          this.calls.push({ method: 'file.create', payload });
          return this.fileCreateResult;
        },
      },
    },
  };
}

function createCall(client: FakeOpenApiClient, method: string): { payload?: unknown } | undefined {
  return client.calls.find((call) => call.method === method);
}

describe('receiveIdType', () => {
  it('maps group chat ids (oc_) to chat_id and everything else to open_id', () => {
    expect(receiveIdType('oc_123')).toBe('chat_id');
    expect(receiveIdType('ou_456')).toBe('open_id');
    expect(receiveIdType('on_789')).toBe('open_id');
  });
});

describe('fileTypeFromName', () => {
  it('maps known extensions to SDK file_type values', () => {
    expect(fileTypeFromName('voice.opus')).toBe('opus');
    expect(fileTypeFromName('clip.mp4')).toBe('mp4');
    expect(fileTypeFromName('doc.pdf')).toBe('pdf');
    expect(fileTypeFromName('a.docx')).toBe('doc');
    expect(fileTypeFromName('b.xlsx')).toBe('xls');
    expect(fileTypeFromName('c.pptx')).toBe('ppt');
  });

  it('defaults to stream for unknown or missing extensions', () => {
    expect(fileTypeFromName('archive.bin')).toBe('stream');
    expect(fileTypeFromName('noextension')).toBe('stream');
    expect(fileTypeFromName('')).toBe('stream');
  });
});

describe('LarkOpenApiOutbound.sendText', () => {
  it('creates a text message with the resolved receive_id_type', async () => {
    const client = new FakeOpenApiClient();
    const outbound = new LarkOpenApiOutbound({ client });
    await outbound.sendText('oc_456', 'hello');
    const call = createCall(client, 'message.create');
    expect(call?.payload).toEqual({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_456', msg_type: 'text', content: JSON.stringify({ text: 'hello' }) },
    });
  });

  it('uses open_id receive_id_type for p2p chat ids', async () => {
    const client = new FakeOpenApiClient();
    const outbound = new LarkOpenApiOutbound({ client });
    await outbound.sendText('ou_user1', 'hi');
    const call = createCall(client, 'message.create');
    expect(call?.payload).toMatchObject({ params: { receive_id_type: 'open_id' } });
  });
});

describe('LarkOpenApiOutbound typing reaction', () => {
  it('adds the official Typing reaction once and removes the returned reaction id', async () => {
    const client = new FakeOpenApiClient() as FakeOpenApiClient & {
      addReaction: (messageId: string, emojiType: string) => Promise<string>;
      removeReaction: (messageId: string, reactionId: string) => Promise<void>;
    };
    const reactions: unknown[] = [];
    client.addReaction = async (messageId, emojiType) => {
      reactions.push(['add', messageId, emojiType]);
      return 'reaction-1';
    };
    client.removeReaction = async (messageId, reactionId) => {
      reactions.push(['remove', messageId, reactionId]);
    };
    const outbound = new LarkOpenApiOutbound({ client });
    await Promise.all([outbound.startTyping('om_in_1'), outbound.startTyping('om_in_1')]);
    await outbound.stopTyping('om_in_1');
    expect(reactions).toEqual([
      ['add', 'om_in_1', 'Typing'],
      ['remove', 'om_in_1', 'reaction-1'],
    ]);
  });
});

describe('LarkOpenApiOutbound.sendMedia', () => {
  it('uploads a dataUri image then sends an image message with the returned key', async () => {
    const client = new FakeOpenApiClient();
    const outbound = new LarkOpenApiOutbound({ client });
    await outbound.sendMedia('oc_456', { type: 'image', dataUri: 'data:image/png;base64,aGVsbG8=' });

    const upload = createCall(client, 'image.create');
    expect(upload?.payload).toMatchObject({ data: { image_type: 'message' } });
    const image = (upload?.payload as LarkCreateImagePayload).data.image;
    expect(Buffer.isBuffer(image)).toBe(true);
    expect((image as Buffer).toString()).toBe('hello');

    const create = client.calls.find((call) => call.method === 'message.create');
    expect(create?.payload).toMatchObject({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_456',
        msg_type: 'image',
        content: JSON.stringify({ image_key: 'img_v2_out' }),
      },
    });
  });

  it('fetches image bytes for a url via the injected fetchImage', async () => {
    const client = new FakeOpenApiClient();
    const fetchImage = async (url: string): Promise<Buffer> => {
      expect(url).toBe('https://x/p.png');
      return Buffer.from('png-bytes');
    };
    const outbound = new LarkOpenApiOutbound({ client, fetchImage });
    await outbound.sendMedia('oc_456', { type: 'image', url: 'https://x/p.png' });
    const upload = createCall(client, 'image.create');
    expect(((upload?.payload as LarkCreateImagePayload).data.image as Buffer).toString()).toBe('png-bytes');
  });

  it('throws when the upload returns no image_key', async () => {
    const client = new FakeOpenApiClient();
    client.imageCreateResult = null;
    const outbound = new LarkOpenApiOutbound({ client });
    await expect(
      outbound.sendMedia('oc_456', { type: 'image', dataUri: 'data:image/png;base64,aGVsbG8=' }),
    ).rejects.toMatchObject({ code: 'CHANNEL_ERROR' });
  });

  it('throws when neither url nor dataUri is provided', async () => {
    const outbound = new LarkOpenApiOutbound({ client: new FakeOpenApiClient() });
    await expect(outbound.sendMedia('oc_456', { type: 'image' })).rejects.toBeInstanceOf(ChannelError);
  });
});

describe('LarkOpenApiOutbound card operations', () => {
  it('creates an interactive card and returns message_id as cardId', async () => {
    const client = new FakeOpenApiClient();
    const outbound = new LarkOpenApiOutbound({ client });
    const result = await outbound.createCard('oc_456', 'hello');
    expect(result).toEqual({ cardId: 'om_out_1' });
    const call = createCall(client, 'message.create');
    expect(call?.payload).toMatchObject({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_456', msg_type: 'interactive' },
    });
    expect(JSON.parse((call?.payload as LarkCreateMessagePayload).data.content)).toMatchObject({
      config: { update_multi: true },
    });
  });

  it('updates a card via message.patch with the card content', async () => {
    const client = new FakeOpenApiClient();
    const outbound = new LarkOpenApiOutbound({ client });
    await outbound.updateCard('om_card_1', 'streaming…');
    const call = createCall(client, 'message.patch');
    expect(call?.payload).toEqual({
      path: { message_id: 'om_card_1' },
      data: { content: cardContent('streaming…') },
    });
  });

  it('finishCard is a no-op that performs no client call', async () => {
    const client = new FakeOpenApiClient();
    const outbound = new LarkOpenApiOutbound({ client });
    await expect(outbound.finishCard('om_card_1')).resolves.toEqual({});
    expect(client.calls).toHaveLength(0);
  });

  it('failCard patches the card to a failure state', async () => {
    const client = new FakeOpenApiClient();
    const outbound = new LarkOpenApiOutbound({ client });
    await outbound.failCard('om_card_1', 'boom');
    const call = createCall(client, 'message.patch');
    expect(call?.payload).toEqual({
      path: { message_id: 'om_card_1' },
      data: { content: cardContent('❌ boom') },
    });
  });
});

describe('LarkOpenApiOutbound.sendFile (M7A official mapping)', () => {
  it('uploads localData via im.v1.file.create then sends msg_type file with the returned file_key', async () => {
    const client = new FakeOpenApiClient();
    client.fileCreateResult = { file_key: 'file_v2_uploaded' };
    const outbound = new LarkOpenApiOutbound({ client });
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await outbound.sendFile('oc_456', { type: 'file', localData: bytes, name: 'report.pdf', mimeType: 'application/pdf' });

    // Official method mapping (plan §96): im.v1.file.create then im.v1.message.create.
    const upload = createCall(client, 'file.create');
    expect(upload).toBeDefined();
    const uploadData = (upload?.payload as LarkCreateFilePayload).data;
    expect(uploadData.file_type).toBe('pdf');
    expect(uploadData.file_name).toBe('report.pdf');
    expect(Buffer.isBuffer(uploadData.file)).toBe(true);
    expect(Buffer.from(uploadData.file)).toEqual(Buffer.from(bytes));

    const create = createCall(client, 'message.create');
    expect(create?.payload).toMatchObject({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_456',
        msg_type: 'file',
        content: JSON.stringify({ file_key: 'file_v2_uploaded' }),
      },
    });
  });

  it('derives file_type from the filename extension and defaults to stream', async () => {
    const client = new FakeOpenApiClient();
    const outbound = new LarkOpenApiOutbound({ client });
    await outbound.sendFile('oc_777', { type: 'file', localData: new Uint8Array([1]), name: 'notes.docx' });
    let upload = createCall(client, 'file.create');
    expect(((upload?.payload as LarkCreateFilePayload).data).file_type).toBe('doc');

    client.calls.length = 0;
    await outbound.sendFile('oc_777', { type: 'file', localData: new Uint8Array([1]), name: 'archive.bin' });
    upload = createCall(client, 'file.create');
    expect(((upload?.payload as LarkCreateFilePayload).data).file_type).toBe('stream');
  });

  it('throws when the file upload returns no file_key', async () => {
    const client = new FakeOpenApiClient();
    client.fileCreateResult = null;
    const outbound = new LarkOpenApiOutbound({ client });
    await expect(
      outbound.sendFile('oc_456', { type: 'file', localData: new Uint8Array([1]), name: 'f.bin' }),
    ).rejects.toMatchObject({ code: 'CHANNEL_ERROR' });
  });

  it('throws when no localData/url/dataUri is provided', async () => {
    const outbound = new LarkOpenApiOutbound({ client: new FakeOpenApiClient() });
    await expect(outbound.sendFile('oc_456', { type: 'file', name: 'f.bin' })).rejects.toBeInstanceOf(ChannelError);
  });
});
