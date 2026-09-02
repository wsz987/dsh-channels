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
  interactiveCardContent,
  streamingCardJson,
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
  cardCreateResult: { code?: number; data?: { card_id?: string } } = {
    code: 0,
    data: { card_id: 'cc_out_1' },
  };

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

  cardkit = {
    v1: {
      card: {
        create: async (payload: { data: { type: string; data: string } }) => {
          this.calls.push({ method: 'cardkit.card.create', payload });
          return this.cardCreateResult;
        },
        settings: async (payload: unknown) => {
          this.calls.push({ method: 'cardkit.card.settings', payload });
          return { code: 0 };
        },
      },
      cardElement: {
        content: async (payload: unknown) => {
          this.calls.push({ method: 'cardkit.cardElement.content', payload });
          return { code: 0 };
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

  it('rejects a nonzero platform code instead of treating it as success', async () => {
    const client = new FakeOpenApiClient();
    client.messageCreateResult = { code: 999, msg: 'permission denied' };
    const outbound = new LarkOpenApiOutbound({ client });
    await expect(outbound.sendText('ou_user1', 'hi')).rejects.toThrow(/999.*permission denied/);
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

describe('LarkOpenApiOutbound CardKit 2.0 entity + streaming', () => {
  it('creates a CardKit card entity from Card JSON 2.0 and returns the card_id', async () => {
    const client = new FakeOpenApiClient();
    const outbound = new LarkOpenApiOutbound({ client });
    const spec = streamingCardJson('hello');
    const result = await outbound.createCardEntity(spec);
    expect(result).toEqual({ cardId: 'cc_out_1' });
    const call = createCall(client, 'cardkit.card.create');
    expect(call?.payload).toEqual({
      data: { type: 'card_json', data: spec },
    });
  });

  it('throws when the entity create returns no card_id', async () => {
    const client = new FakeOpenApiClient();
    client.cardCreateResult = { code: 0 };
    const outbound = new LarkOpenApiOutbound({ client });
    await expect(outbound.createCardEntity(streamingCardJson('x'))).rejects.toMatchObject({
      code: 'CHANNEL_ERROR',
    });
  });

  it('sends a card reference message ({ type: card, data: { card_id } })', async () => {
    const client = new FakeOpenApiClient();
    const outbound = new LarkOpenApiOutbound({ client });
    const result = await outbound.sendCardEntity('oc_456', 'cc_out_1');
    expect(result).toEqual({ messageId: 'om_out_1' });
    const call = createCall(client, 'message.create');
    expect(call?.payload).toMatchObject({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'oc_456',
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: 'cc_out_1' } }),
      },
    });
  });

  it('throws when the card reference send returns no message_id', async () => {
    const client = new FakeOpenApiClient();
    client.messageCreateResult = { code: 0, data: {} };
    const outbound = new LarkOpenApiOutbound({ client });
    await expect(outbound.sendCardEntity('oc_456', 'cc_out_1')).rejects.toMatchObject({
      code: 'CHANNEL_ERROR',
    });
  });

  it('streams content via cardkit.cardElement.content with sequence + uuid', async () => {
    const client = new FakeOpenApiClient();
    const outbound = new LarkOpenApiOutbound({ client });
    await outbound.updateCardElementContent('cc_out_1', 'stream_md', 'hello', 3, 'c_cc_out_1_3');
    const call = createCall(client, 'cardkit.cardElement.content');
    expect(call?.payload).toEqual({
      path: { card_id: 'cc_out_1', element_id: 'stream_md' },
      data: { uuid: 'c_cc_out_1_3', content: 'hello', sequence: 3 },
    });
  });

  it('rejects nonzero CardKit update responses', async () => {
    const client = new FakeOpenApiClient();
    client.cardkit.v1.cardElement.content = async (payload: unknown) => {
      client.calls.push({ method: 'cardkit.cardElement.content', payload });
      return { code: 230099, msg: 'element too large' };
    };
    const outbound = new LarkOpenApiOutbound({ client });
    await expect(outbound.updateCardElementContent('cc_out_1', 'stream_md', 'x', 1, 'u'))
      .rejects.toThrow(/230099.*element too large/);
  });

  it('closes streaming via cardkit.card.settings with streaming_mode false and a summary', async () => {
    const client = new FakeOpenApiClient();
    const outbound = new LarkOpenApiOutbound({ client });
    await outbound.finishStreamingCard('cc_out_1', 5, 'final summary');
    const call = createCall(client, 'cardkit.card.settings');
    expect(call?.payload).toEqual({
      path: { card_id: 'cc_out_1' },
      data: {
        settings: JSON.stringify({
          config: { streaming_mode: false, summary: { content: 'final summary' } },
        }),
        sequence: 5,
        uuid: 's_cc_out_1_5',
      },
    });
  });
});

describe('streamingCardJson', () => {
  it('builds a Card JSON 2.0 streaming spec with streaming_mode + a stable element_id', () => {
    const spec = JSON.parse(streamingCardJson('thinking…')) as Record<string, any>;
    expect(spec.schema).toBe('2.0');
    expect(spec.config).toMatchObject({
      streaming_mode: true,
      summary: { content: '[Generating...]' },
      streaming_config: { print_strategy: 'fast' },
    });
    const element = (spec.body as { elements: Array<Record<string, unknown>> }).elements[0];
    expect(element).toMatchObject({
      tag: 'markdown',
      element_id: 'stream_md',
      content: 'thinking…',
    });
  });

  it('never emits a legacy lark_md element or action container', () => {
    const spec = streamingCardJson('hi');
    expect(spec).not.toContain('lark_md');
    expect(spec).not.toContain('"tag":"action"');
  });
});

describe('LarkOpenApiOutbound interactive actions', () => {
  it('uses direct Card 2.0 buttons with callback behaviors', async () => {
    const client = new FakeOpenApiClient();
    const outbound = new LarkOpenApiOutbound({ client });
    await outbound.sendInteractive('oc_456', 'Choose one', [
      { actions: [{ id: 'question:option:1', label: 'Option A', style: 'primary' }] },
    ]);
    const call = createCall(client, 'message.create');
    expect(call?.payload).toMatchObject({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: 'oc_456', msg_type: 'interactive' },
    });
    expect(JSON.parse((call?.payload as LarkCreateMessagePayload).data.content)).toEqual({
      schema: '2.0',
      config: { wide_screen_mode: true },
      body: {
        elements: [
          { tag: 'markdown', content: 'Choose one' },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: 'Option A' },
            type: 'primary',
            behaviors: [{
              type: 'callback',
              value: { actionId: 'question:option:1' },
            }],
          },
        ],
      },
    });
  });

  it('never emits the legacy action container in a Card 2.0 payload', () => {
    const card = interactiveCardContent('Choose one', [
      {
        actions: [
          { id: 'question:option:1', label: 'Option A' },
          { id: 'question:option:2', label: 'Option B' },
        ],
      },
    ]);
    expect(card).not.toContain('"tag":"action"');
    expect(JSON.parse(card).body.elements.filter((element: { tag?: string }) => element.tag === 'button'))
      .toHaveLength(2);
  });

  it('rewrites the card with no action elements when actions are cleared', async () => {
    const client = new FakeOpenApiClient();
    const outbound = new LarkOpenApiOutbound({ client });
    await outbound.updateInteractive('om_card_1', 'Answered', []);
    const call = createCall(client, 'message.patch');
    expect(call?.payload).toEqual({
      path: { message_id: 'om_card_1' },
      data: { content: interactiveCardContent('Answered', []) },
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

    // Official method mapping: im.v1.file.create then im.v1.message.create.
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
