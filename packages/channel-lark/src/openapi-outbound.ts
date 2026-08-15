/**
 * Lark outbound over the official `@larksuiteoapi/node-sdk` OpenAPI `Client`
 * (release plan R7B).
 *
 * Replaces the self-hosted HTTP gateway endpoints (`/message/send`,
 * `/card/create`, `/card/update`, `/card/finish`, `/card/fail`) with the
 * official OpenAPI surface so `upstream.mode: 'sdk'` needs no localhost
 * gateway at all:
 *
 * - `sendText`    → `im.v1.message.create` (`msg_type: 'text'`)
 * - `sendMedia`   → `im.v1.image.create` (upload → `image_key`) + `im.v1.message.create` (`msg_type: 'image'`)
 * - `sendFile`    → `im.v1.file.create` (upload → `file_key`) + `im.v1.message.create` (`msg_type: 'file'`)
 * - `createCard`  → `im.v1.message.create` (`msg_type: 'interactive'`), card id = `message_id`
 * - `updateCard`  → `im.v1.message.patch` (update card content)
 * - `failCard`    → `im.v1.message.patch` (rewrite the card to a failure state)
 * - `finishCard`  → no-op: the final `patch` already carries the finished text
 *
 * Only a minimal structural client surface is consumed so offline tests can
 * inject a fake; the real `Client` satisfies it structurally (mirrors the
 * `LarkSdkClient`/`WSClient` split used for the inbound leg). Credentials are
 * never referenced here — the `Client` is built elsewhere from config.
 */
import { ChannelError } from '@wsz987/channel-core';
import { z } from 'zod';
import type { CardCreateResult, LarkFileRef, LarkMediaRef, LarkOutbound } from './upstream.js';

/** The SDK `receive_id_type` union (matches the real `Client` type). */
export type LarkReceiveIdType = 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id';

/** SDK `file_type` union for im.v1.file.create (matches the SDK type). */
export type LarkFileType = 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';

/** Minimal `im.v1.message.create` payload/result shapes consumed here. */
export interface LarkCreateMessagePayload {
  params: { receive_id_type: LarkReceiveIdType; uuid?: string };
  data: { receive_id: string; msg_type: string; content: string; uuid?: string };
}

export interface LarkCreateMessageResult {
  message_id?: string;
}

/** Minimal `im.v1.message.patch` payload shape (update card content). */
export interface LarkPatchMessagePayload {
  path: { message_id: string };
  data: { content: string };
}

/** Minimal `im.v1.image.create` payload/result shapes consumed here. */
export interface LarkCreateImagePayload {
  data: { image_type: 'message' | 'avatar'; image: Buffer };
}

export interface LarkCreateImageResult {
  image_key?: string;
}

/** Minimal im.v1.file.create payload/result shapes consumed here (M7A). */
export interface LarkCreateFilePayload {
  data: {
    file_type: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream';
    file_name: string;
    duration?: number;
    file: Buffer;
  };
}

export interface LarkCreateFileResult {
  file_key?: string;
}

/** Common OpenAPI envelope: `code` 0 means success. */
export interface LarkApiResponse<T = Record<string, unknown>> {
  code?: number;
  msg?: string;
  data?: T;
}

/**
 * Structural subset of the real SDK `Client` used for outbound. The real
 * `Client` (from `@larksuiteoapi/node-sdk`) satisfies this shape; tests inject
 * a fake.
 */
export interface LarkOpenApiClient {
  im: {
    v1: {
      message: {
        create(payload: LarkCreateMessagePayload): Promise<LarkApiResponse<LarkCreateMessageResult>>;
        patch(payload: LarkPatchMessagePayload): Promise<LarkApiResponse>;
      };
      image: {
        create(payload: LarkCreateImagePayload): Promise<LarkCreateImageResult | null>;
      };
      file: {
        create(payload: LarkCreateFilePayload): Promise<LarkCreateFileResult | null>;
      };
    };
    messageReaction?: unknown;
  };
  addReaction?(messageId: string, emojiType: string): Promise<string>;
  removeReaction?(messageId: string, reactionId: string): Promise<void>;
}

interface ReactionClient {
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

const reactionIdSchema = z.string().trim().min(1);

export interface LarkOpenApiOutboundOptions {
  /** Official OpenAPI client (real `Client` or injected fake). */
  client: LarkOpenApiClient;
  /** Injectable image-byte fetch for `sendMedia` URLs (tests); defaults to `fetch`. */
  fetchImage?: (url: string) => Promise<Buffer>;
}

/**
 * Official-OpenAPI implementation of the outbound surface. No `receive` here:
 * in SDK mode the inbound leg stays on the WS long-connection, and this driver
 * is composed as the `outbound` half of `LarkSdkUpstream`.
 */
export class LarkOpenApiOutbound implements LarkOutbound {
  private readonly fetchImage: (url: string) => Promise<Buffer>;
  private readonly typingReactions = new Map<string, string>();
  private readonly typingOperations = new Map<string, Promise<void>>();

  constructor(private readonly options: LarkOpenApiOutboundOptions) {
    this.fetchImage = options.fetchImage ?? defaultFetchImage;
  }

  sendText(to: string, text: string): Promise<unknown> {
    return this.options.client.im.v1.message.create({
      params: { receive_id_type: receiveIdType(to) },
      data: { receive_id: to, msg_type: 'text', content: JSON.stringify({ text }) },
    });
  }

  async sendMedia(to: string, media: LarkMediaRef): Promise<unknown> {
    const bytes = await this.resolveImageBytes(media);
    const uploaded = await this.options.client.im.v1.image.create({
      data: { image_type: 'message', image: bytes },
    });
    const imageKey = uploaded?.image_key;
    if (!imageKey) {
      throw new ChannelError('CHANNEL_ERROR', 'lark image upload returned no image_key');
    }
    return this.options.client.im.v1.message.create({
      params: { receive_id_type: receiveIdType(to) },
      data: {
        receive_id: to,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
    });
  }

  async sendFile(to: string, file: LarkFileRef): Promise<unknown> {
    const bytes = await this.resolveFileBytes(file);
    const name = file.name ?? 'file';
    const uploaded = await this.options.client.im.v1.file.create({
      data: {
        file_type: fileTypeFromName(name),
        file_name: name,
        file: bytes,
      },
    });
    const fileKey = uploaded?.file_key;
    if (!fileKey) {
      throw new ChannelError('CHANNEL_ERROR', 'lark file upload returned no file_key');
    }
    return this.options.client.im.v1.message.create({
      params: { receive_id_type: receiveIdType(to) },
      data: {
        receive_id: to,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
    });
  }

  async createCard(conversationId: string, text: string): Promise<CardCreateResult> {
    const response = await this.options.client.im.v1.message.create({
      params: { receive_id_type: receiveIdType(conversationId) },
      data: {
        receive_id: conversationId,
        msg_type: 'interactive',
        content: cardContent(text),
      },
    });
    return { cardId: response.data?.message_id ?? '' };
  }

  updateCard(cardId: string, text: string): Promise<unknown> {
    return this.options.client.im.v1.message.patch({
      path: { message_id: cardId },
      data: { content: cardContent(text) },
    });
  }

  finishCard(_cardId: string): Promise<unknown> {
    // Lark interactive cards have no separate "finish" state — the last
    // `patch` already carries the finished content. Keep the reply-handle
    // contract intact with a no-op.
    return Promise.resolve({});
  }

  failCard(cardId: string, reason?: string): Promise<unknown> {
    return this.options.client.im.v1.message.patch({
      path: { message_id: cardId },
      data: { content: cardContent(reason ? `❌ ${reason}` : '❌ 出错了') },
    });
  }

  async startTyping(messageId: string): Promise<void> {
    if (!messageId || this.typingReactions.has(messageId)) return;
    await this.serializeTyping(messageId, async () => {
      if (this.typingReactions.has(messageId)) return;
      const reaction = this.reactionClient();
      if (!reaction) return;
      const result = reactionIdSchema.safeParse(await reaction.addReaction(messageId, 'Typing'));
      if (!result.success) {
        throw new ChannelError('CHANNEL_ERROR', 'lark typing reaction returned an invalid reaction id');
      }
      this.typingReactions.set(messageId, result.data);
    });
  }

  async stopTyping(messageId: string): Promise<void> {
    await this.serializeTyping(messageId, async () => {
      const reactionId = this.typingReactions.get(messageId);
      if (!reactionId) return;
      const reaction = this.reactionClient();
      if (reaction) await reaction.removeReaction(messageId, reactionId);
      this.typingReactions.delete(messageId);
    });
  }

  private async serializeTyping(messageId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.typingOperations.get(messageId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.typingOperations.set(messageId, current);
    try {
      await current;
    } finally {
      if (this.typingOperations.get(messageId) === current) this.typingOperations.delete(messageId);
    }
  }

  private reactionClient(): ReactionClient | undefined {
    if (this.options.client.addReaction && this.options.client.removeReaction) {
      return {
        addReaction: this.options.client.addReaction.bind(this.options.client),
        removeReaction: this.options.client.removeReaction.bind(this.options.client),
      };
    }
    const nested = this.options.client.im.messageReaction as ReactionClient | undefined;
    return nested && typeof nested.addReaction === 'function' && typeof nested.removeReaction === 'function'
      ? nested
      : undefined;
  }

  private async resolveImageBytes(media: LarkMediaRef): Promise<Buffer> {
    if (media.dataUri) return dataUriToBuffer(media.dataUri);
    if (media.url) return this.fetchImage(media.url);
    throw new ChannelError('CHANNEL_ERROR', 'lark sendMedia requires an image url or dataUri');
  }

  private async resolveFileBytes(file: LarkFileRef): Promise<Buffer> {
    if (file.localData) {
      return Buffer.isBuffer(file.localData) ? file.localData : Buffer.from(file.localData);
    }
    if (file.dataUri) return dataUriToBuffer(file.dataUri);
    if (file.url) return this.fetchImage(file.url);
    throw new ChannelError('CHANNEL_ERROR', 'lark sendFile requires localData, url, or dataUri');
  }
}

/**
 * Resolve the SDK `receive_id_type` from a Lark conversation id: group chats
 * carry an `oc_` prefix (`chat_id`), p2p chats carry the peer's `ou_` open id
 * (`open_id`).
 */
export function receiveIdType(to: string): LarkReceiveIdType {
  return to.startsWith('oc_') ? 'chat_id' : 'open_id';
}

/**
 * Derive the SDK `file_type` from a filename extension, defaulting to
 * 'stream' for anything unrecognised. Matches the SDK union for im.v1.file.create.
 */
export function fileTypeFromName(name: string): LarkFileType {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  switch (ext) {
    case 'opus': return 'opus';
    case 'mp4': return 'mp4';
    case 'pdf': return 'pdf';
    case 'doc':
    case 'docx': return 'doc';
    case 'xls':
    case 'xlsx': return 'xls';
    case 'ppt':
    case 'pptx': return 'ppt';
    default: return 'stream';
  }
}

/** Build the minimal interactive card JSON used for streaming replies. */
export function cardContent(text: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }],
  });
}

function dataUriToBuffer(dataUri: string): Buffer {
  const comma = dataUri.indexOf(',');
  const payload = comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
  return Buffer.from(payload, 'base64');
}

async function defaultFetchImage(url: string): Promise<Buffer> {
  const response = await globalThis.fetch(url);
  if (!response.ok) {
    throw new ChannelError('CHANNEL_ERROR', `lark image fetch failed with ${response.status}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
