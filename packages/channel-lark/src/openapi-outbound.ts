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
import type { CardCreateResult, LarkMediaRef, LarkOutbound } from './upstream.js';

/** The SDK `receive_id_type` union (matches the real `Client` type). */
export type LarkReceiveIdType = 'open_id' | 'user_id' | 'union_id' | 'email' | 'chat_id';

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
    };
  };
}

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

  private async resolveImageBytes(media: LarkMediaRef): Promise<Buffer> {
    if (media.dataUri) return dataUriToBuffer(media.dataUri);
    if (media.url) return this.fetchImage(media.url);
    throw new ChannelError('CHANNEL_ERROR', 'lark sendMedia requires an image url or dataUri');
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
