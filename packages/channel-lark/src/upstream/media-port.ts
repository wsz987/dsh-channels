/**
 * Lark media port - Media ingress/egress over the official
 * @larksuiteoapi/node-sdk OpenAPI Client (Milestone M2A, plan section 26/27).
 *
 * The port is the ONLY module in channel-lark that resolves platform media.
 * downloadMessageResource is the M2A Native Image Ingress path; it goes
 * strictly through client.im.v1.messageResource.get (official SDK) - never
 * hand-written /open-apis/im/v1/... URLs, no tenant-token logic. The SDK
 * returns a binary stream ({ getReadableStream }) which this port normalizes
 * to a Uint8Array, best-effort copying the content-type header into mimeType.
 *
 * Since plan section 23-A4 the port resolves ALL four binary resource kinds:
 * the official `message.resource` API documents its scope as 音频、视频、图片和文件
 * ("resource files in the specified message, including audio, video, image
 * and file", see the SDK-embedded doc statement for im.v1.messageResource.get
 * in @larksuiteoapi/node-sdk@1.73.1), and the SDK `type` query param is typed
 * `string` - NOT restricted to image/file. The mapper therefore routes
 * audio/video file_keys through the same `type: 'audio'` / `type: 'video'`
 * download seam as image/file. Platform-level limits stay official facts:
 * <= 100 MB per resource, no stickers, no sub-messages of merged-forward /
 * card messages (error 234043) - those surface as port failures that the
 * hydrator maps to a stable ingressFailure.
 *
 * uploadImage -> client.im.v1.image.create and uploadFile ->
 * client.im.v1.file.create are declared now (needed by the outbound-media
 * milestone M7A later) and implemented because they are straightforward.
 *
 * To stay offline-testable this module consumes only a minimal structural
 * subset of the real SDK Client (mirrors the LarkOpenApiClient split in
 * openapi-outbound.ts); the real Client satisfies the shape and tests inject
 * a fake. Credentials are never referenced here - the Client is built
 * elsewhere from config.
 *
 * The SDK messageResource.get signature bound here (1.73.1 types):
 *   get(payload: { params: { type: string }; path: { message_id: string;
 *                             file_key: string } }, options?):
 *     Promise<{ writeFile(fp): Promise<unknown>;
 *               getReadableStream(): Readable; headers: any }>
 */
import {
  BodyTooLargeError,
  ChannelError,
  RemoteMediaAbortedError,
  concatenate,
} from '@wsz987/channel-core';

/** Official per-resource limit, also enforced locally while reading. */
export const LARK_MESSAGE_RESOURCE_MAX_BYTES = 100 * 1024 * 1024;

/** The four binary resource kinds the official message.resource API resolves. */
export type LarkResourceType = 'image' | 'file' | 'audio' | 'video';

/** Minimal im.v1.messageResource.get payload/result shapes consumed here. */
export interface LarkMessageResourceGetPayload {
  params: { type: LarkResourceType | string };
  path: { message_id: string; file_key: string };
}

/** The binary-stream result the official SDK returns for resource downloads. */
export interface LarkMessageResourceResult {
  /** Persist the downloaded resource to a local file path. */
  writeFile?(filePath: string): Promise<unknown>;
  /** The downloaded resource as a Node readable stream. */
  getReadableStream(): import('node:stream').Readable;
  /** Response headers (may carry content-type / content-disposition). */
  headers?: Record<string, unknown>;
}

/** Minimal im.v1.image.get payload shape (image download). */
export interface LarkImageGetPayload {
  path: { image_key: string };
}

/** Minimal im.v1.image.create payload/result shapes. */
export interface LarkImageCreatePayload {
  data: { image_type: 'message' | 'avatar'; image: Uint8Array };
}

export interface LarkImageCreateResult {
  image_key?: string;
}

/** Minimal im.v1.file.create payload/result shapes. */
export interface LarkFileCreatePayload {
  data: {
    file_type: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
    file_name: string;
    duration?: number;
    file: Uint8Array;
  };
}

export interface LarkFileCreateResult {
  file_key?: string;
}

/**
 * Structural subset of the official SDK Client required by the media port.
 * The real Client (1.73.1) satisfies this shape; tests inject a fake.
 * Mirrors the LarkOpenApiClient pattern from openapi-outbound.ts.
 */
export interface LarkMediaClient {
  im: {
    v1: {
      messageResource: {
        get(payload: LarkMessageResourceGetPayload): Promise<LarkMessageResourceResult>;
      };
      image: {
        create(payload: LarkImageCreatePayload): Promise<LarkImageCreateResult | null>;
      };
      file: {
        create(payload: LarkFileCreatePayload): Promise<LarkFileCreateResult | null>;
      };
    };
  };
}

/**
 * Media port contract (plan section 26). The adapter depends on this
 * interface so it is fully injectable in offline tests.
 */
export interface LarkMediaPort {
  /**
   * Download a resource (image/file/audio/video) embedded in a message.
   * resourceKey is the platform image_key/file_key (a resourceRef), resolved
   * via the official messageResource.get against the owning messageId. The
   * per-kind `type` mirrors the resource kind the official API documents for
   * audio/video downloads (plan section 23-A4).
   */
  downloadMessageResource(input: {
    messageId: string;
    resourceKey: string;
    type: LarkResourceType;
    signal?: AbortSignal;
    /** Hard cap enforced while consuming the SDK stream. */
    maxBytes?: number;
  }): Promise<{ data: Uint8Array; mimeType?: string; name?: string }>;

  /** Upload an image; returns the platform image_key. */
  uploadImage(input: { data: Uint8Array; signal?: AbortSignal }): Promise<{ imageKey: string }>;

  /** Upload a generic file; returns the platform file_key. */
  uploadFile(input: {
    data: Uint8Array;
    name: string;
    fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
    durationMs?: number;
    signal?: AbortSignal;
  }): Promise<{ fileKey: string }>;
}

export interface LarkMediaPortOptions {
  /** Official OpenAPI client (real Client or injected fake). */
  client: LarkMediaClient;
}

/**
 * Official-SDK implementation of the media port. downloadMessageResource is
 * the M2A image-ingress surface; uploadImage/uploadFile are declared now and
 * implemented via the official image/file clients so the later outbound-media
 * milestone (M7A) can reuse them.
 */
export class LarkOpenApiMediaPort implements LarkMediaPort {
  constructor(private readonly options: LarkMediaPortOptions) {}

  async downloadMessageResource(input: {
    messageId: string;
    resourceKey: string;
    type: LarkResourceType;
    signal?: AbortSignal;
    maxBytes?: number;
  }): Promise<{ data: Uint8Array; mimeType?: string; name?: string }> {
    if (input.signal?.aborted) throw new RemoteMediaAbortedError();
    const result = await this.options.client.im.v1.messageResource.get({
      params: { type: input.type },
      path: { message_id: input.messageId, file_key: input.resourceKey },
    });
    const data = await streamToUint8Array(
      result,
      input.maxBytes ?? LARK_MESSAGE_RESOURCE_MAX_BYTES,
      input.signal,
    );
    return { data, mimeType: contentTypeOf(result), name: fileNameOf(result) };
  }

  async uploadImage(input: { data: Uint8Array; signal?: AbortSignal }): Promise<{ imageKey: string }> {
    void input.signal;
    const result = await this.options.client.im.v1.image.create({
      data: { image_type: 'message', image: input.data },
    });
    const imageKey = result?.image_key;
    if (!imageKey) {
      throw new ChannelError('CHANNEL_ERROR', 'lark image upload returned no image_key');
    }
    return { imageKey };
  }

  async uploadFile(input: {
    data: Uint8Array;
    name: string;
    fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
    durationMs?: number;
    signal?: AbortSignal;
  }): Promise<{ fileKey: string }> {
    void input.signal;
    const data: LarkFileCreatePayload['data'] = {
      file_type: input.fileType,
      file_name: input.name,
      duration: input.durationMs,
      file: input.data,
    };
    if (input.durationMs === undefined) delete data.duration;
    const result = await this.options.client.im.v1.file.create({ data });
    const fileKey = result?.file_key;
    if (!fileKey) {
      throw new ChannelError('CHANNEL_ERROR', 'lark file upload returned no file_key');
    }
    return { fileKey };
  }
}

/** Consume the official Node stream under a hard cumulative byte cap. */
async function streamToUint8Array(
  result: LarkMessageResourceResult,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (maxBytes <= 0) {
    throw new BodyTooLargeError(maxBytes, `maxBytes must be positive, got ${maxBytes}`);
  }
  if (signal?.aborted) throw new RemoteMediaAbortedError();

  const stream = result.getReadableStream();
  const chunks: Uint8Array[] = [];
  let received = 0;
  const onAbort = () => stream.destroy(new RemoteMediaAbortedError());
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const rawChunk of stream) {
      if (signal?.aborted) throw new RemoteMediaAbortedError();
      const chunk = normalizeStreamChunk(rawChunk);
      if (chunk === undefined) {
        stream.destroy();
        throw new ChannelError('CHANNEL_ERROR', 'lark media stream returned a non-binary chunk');
      }
      received += chunk.byteLength;
      if (received > maxBytes) {
        stream.destroy();
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (signal?.aborted) throw new RemoteMediaAbortedError(undefined, { cause: error });
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  return concatenate(chunks, received);
}

function normalizeStreamChunk(chunk: unknown): Uint8Array | undefined {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return undefined;
}

/** Best-effort content-type from the SDK response headers. */
function contentTypeOf(result: LarkMessageResourceResult): string | undefined {
  const headers = result.headers;
  if (!headers) return undefined;
  const raw = headers['content-type'] ?? headers['Content-Type'];
  if (typeof raw === 'string') return raw.split(';')[0]?.trim() || undefined;
  return undefined;
}

/** Best-effort filename from the SDK response headers (content-disposition). */
function fileNameOf(result: LarkMessageResourceResult): string | undefined {
  const headers = result.headers;
  if (!headers) return undefined;
  const disposition = headers['content-disposition'] ?? headers['Content-Disposition'];
  if (typeof disposition !== 'string') return undefined;
  const match = disposition.match(/filename=([^;]+)/i);
  const value = match?.[1]?.trim().replace(/^"|"$/g, '');
  return value || undefined;
}
