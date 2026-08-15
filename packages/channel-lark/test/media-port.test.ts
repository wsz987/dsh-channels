/**
 * LarkOpenApiMediaPort tests (offline, fake media client) — plan §96.
 *
 * Verifies the official-SDK method mapping: downloadMessageResource calls
 * `im.v1.messageResource.get` with `message_id` + `file_key`, normalizes the
 * returned binary stream to a `Uint8Array`, and best-effort copies
 * content-type / content-disposition into mimeType / name. Also covers
 * uploadImage -> `im.v1.image.create` and uploadFile -> `im.v1.file.create`.
 */
import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { ChannelError } from '@wsz987/channel-core';
import {
  LarkOpenApiMediaPort,
  type LarkMediaClient,
} from '../src/index.ts';

/**
 * Fake official SDK client exposing only the media surface: records every
 * call and returns deterministic binary-stream/image-key/file-key results.
 */
class FakeMediaClient implements LarkMediaClient {
  calls: { method: string; payload?: unknown }[] = [];
  streamChunks: Buffer[] = [Buffer.from('\x89PNG-fake-image-bytes')];
  headers?: Record<string, unknown> = { 'content-type': 'image/png; charset=utf-8' };
  messageResourceError?: Error;
  imageCreateResult: { image_key?: string } | null = { image_key: 'img_v2_up' };
  fileCreateResult: { file_key?: string } | null = { file_key: 'file_v2_up' };

  im = {
    v1: {
      messageResource: {
        get: async (payload: unknown) => {
          this.calls.push({ method: 'messageResource.get', payload });
          if (this.messageResourceError) throw this.messageResourceError;
          return {
            writeFile: async () => undefined,
            getReadableStream: () => Readable.from([...this.streamChunks]),
            headers: this.headers,
          };
        },
      } as never,
      image: {
        create: async (payload: unknown) => {
          this.calls.push({ method: 'image.create', payload });
          return this.imageCreateResult;
        },
      },
      file: {
        create: async (payload: unknown) => {
          this.calls.push({ method: 'file.create', payload });
          return this.fileCreateResult;
        },
      },
    },
  } as never;
}

function port(client: FakeMediaClient): LarkOpenApiMediaPort {
  return new LarkOpenApiMediaPort({ client });
}

describe('LarkOpenApiMediaPort.downloadMessageResource (M2A image ingress)', () => {
  it('calls im.v1.messageResource.get with message_id + file_key and returns normalized Uint8Array', async () => {
    const client = new FakeMediaClient();
    const result = await port(client).downloadMessageResource({
      messageId: 'om_in_1',
      resourceKey: 'img_v2_xyz',
      type: 'image',
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.method).toBe('messageResource.get');
    expect(client.calls[0]?.payload).toEqual({
      params: { type: 'image' },
      path: { message_id: 'om_in_1', file_key: 'img_v2_xyz' },
    });

    expect(result.data).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(result.data).toString()).toBe('\x89PNG-fake-image-bytes');
    // content-type copied into mimeType (sans charset params).
    expect(result.mimeType).toBe('image/png');
  });

  it('normalizes multiple stream chunks and copies a content-disposition filename', async () => {
    const client = new FakeMediaClient();
    client.streamChunks = [Buffer.from('chunk-1-'), Buffer.from('chunk-2')];
    client.headers = {
      'content-type': 'image/jpeg',
      'content-disposition': 'attachment; filename="photo.jpg"',
    };
    const result = await port(client).downloadMessageResource({
      messageId: 'om_in_2',
      resourceKey: 'file_v2_photo',
      type: 'file',
    });
    expect(Buffer.from(result.data).toString()).toBe('chunk-1-chunk-2');
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.name).toBe('photo.jpg');
    expect(client.calls[0]?.payload).toMatchObject({ params: { type: 'file' } });
  });

  it('does not fabricate a mimeType/name when headers are absent', async () => {
    const client = new FakeMediaClient();
    client.headers = undefined;
    const result = await port(client).downloadMessageResource({
      messageId: 'om_in_3',
      resourceKey: 'img_v2_h',
      type: 'image',
    });
    expect(result.mimeType).toBeUndefined();
    expect(result.name).toBeUndefined();
  });
});

describe('LarkOpenApiMediaPort.uploadImage / uploadFile', () => {
  it('uploadImage calls im.v1.image.create and returns the image_key', async () => {
    const client = new FakeMediaClient();
    const result = await port(client).uploadImage({ data: new Uint8Array([1, 2, 3]) });
    expect(result).toEqual({ imageKey: 'img_v2_up' });
    expect(client.calls[0]?.method).toBe('image.create');
    expect((client.calls[0]?.payload as { data: { image_type: string } }).data.image_type).toBe('message');
  });

  it('uploadImage throws a ChannelError when no image_key is returned', async () => {
    const client = new FakeMediaClient();
    client.imageCreateResult = null;
    await expect(port(client).uploadImage({ data: new Uint8Array([1]) })).rejects.toBeInstanceOf(ChannelError);
  });

  it('uploadFile calls im.v1.file.create with file_type/file_name and returns file_key', async () => {
    const client = new FakeMediaClient();
    const result = await port(client).uploadFile({
      data: new Uint8Array([9, 9]),
      name: 'report.pdf',
      fileType: 'pdf',
    });
    expect(result).toEqual({ fileKey: 'file_v2_up' });
    expect(client.calls[0]?.method).toBe('file.create');
    const data = (client.calls[0]?.payload as { data: { file_type: string; file_name: string; duration?: number } }).data;
    expect(data.file_type).toBe('pdf');
    expect(data.file_name).toBe('report.pdf');
    // No duration provided -> key dropped.
    expect('duration' in data).toBe(false);
  });

  it('uploadFile forwards durationMs and throws when no file_key is returned', async () => {
    const client = new FakeMediaClient();
    client.fileCreateResult = null;
    await expect(port(client).uploadFile({ data: new Uint8Array([1]), name: 'voice.opus', fileType: 'opus', durationMs: 4200 }))
      .rejects.toBeInstanceOf(ChannelError);
    const data = (client.calls[0]?.payload as { data: { duration?: number; file_type: string } }).data;
    expect(data.file_type).toBe('opus');
    expect(data.duration).toBe(4200);
  });
});
