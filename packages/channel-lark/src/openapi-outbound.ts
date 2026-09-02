/**
 * Lark outbound over the official `@larksuiteoapi/node-sdk` OpenAPI `Client`.
 *
 * This driver is the ONLY outbound implementation: plain text, media and file
 * messages, Card JSON 2.0 interactive cards, and CardKit 2.0 card entities with
 * native streaming (`cardElement.content`) are all routed through the official
 * client. There is no self-hosted gateway and no legacy `/message/*` or
 * `/card/*` endpoint anywhere.
 *
 * - `sendText`      → `im.v1.message.create` (`msg_type: 'text'`)
 * - `sendMedia`     → `im.v1.image.create` (upload → `image_key`) + `im.v1.message.create` (`msg_type: 'image'`)
 * - `sendFile`      → `im.v1.file.create` (upload → `file_key`) + `im.v1.message.create` (`msg_type: 'file'`)
 * - `sendInteractive` → `im.v1.message.create` (`msg_type: 'interactive'`) with Card JSON 2.0 buttons
 * - `updateInteractive` → `im.v1.message.patch` (rewrite an already-sent interactive card)
 * - `createCardEntity` → `cardkit.v1.card.create` (Card JSON 2.0 only)
 * - `sendCardEntity` → `im.v1.message.create` with content `{ type: "card", data: { card_id } }`
 * - `updateCardElementContent` → `cardkit.v1.cardElement.content` (native typewriter)
 * - `finishStreamingCard` → `cardkit.v1.card.settings` (`streaming_mode: false` + summary)
 *
 * Only a minimal structural client surface is consumed so offline tests can
 * inject a fake; the real `Client` satisfies it structurally. Credentials are
 * never referenced here — the `Client` is built elsewhere from config.
 *
 * Official responses are trust-boundary validated with zod `safeParse` before
 * their fields are read; invalid envelopes surface as `ChannelError`s.
 */
import { ChannelError } from '@wsz987/channel-core';
import type { OutboundActionRow } from '@wsz987/channel-core';
import { z } from 'zod';
import type {
  LarkFileRef,
  LarkMediaRef,
  LarkOutbound,
} from './upstream.js';

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

/** Minimal im.v1.file.create payload/result shapes consumed here. */
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

/** Minimal cardkit.v1.card.create payload/result shapes. */
export interface LarkCardkitCardCreatePayload {
  data: { type: 'card_json'; data: string };
}

export interface LarkCardkitCardCreateResult {
  card_id?: string;
}

/** Minimal cardkit.v1.cardElement.content payload (streaming element replace). */
export interface LarkCardElementContentPayload {
  path: { card_id: string; element_id: string };
  data: { uuid?: string; content: string; sequence: number };
}

/** Minimal cardkit.v1.card.settings payload (streaming close + summary). */
export interface LarkCardSettingsPayload {
  path: { card_id: string };
  data: { settings: string; sequence: number; uuid?: string };
}

/**
 * Structural subset of the real SDK `Client` used for outbound. The real
 * `Client` (from `@larksuiteoapi/node-sdk` at 1.73.1) satisfies this shape;
 * tests inject a fake.
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
      chat?: {
        get(payload: { path: { chat_id: string } }): Promise<unknown>;
      };
    };
    messageReaction?: unknown;
  };
  cardkit: {
    v1: {
      card: {
        create(payload: LarkCardkitCardCreatePayload): Promise<LarkApiResponse<LarkCardkitCardCreateResult>>;
        settings(payload: LarkCardSettingsPayload): Promise<LarkApiResponse>;
      };
      cardElement: {
        content(payload: LarkCardElementContentPayload): Promise<LarkApiResponse>;
      };
    };
  };
  addReaction?(messageId: string, emojiType: string): Promise<string>;
  removeReaction?(messageId: string, reactionId: string): Promise<void>;
}

interface ReactionClient {
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

const reactionIdSchema = z.string().trim().min(1);
const chatModeResponseSchema = z.object({
  code: z.number().optional(),
  data: z.object({
    chat_mode: z.enum(['p2p', 'group', 'topic']).optional(),
  }).optional(),
});

/** Trust-boundary envelope: any unknown extra keys are allowed, but the read fields are validated. */
const envelopeSchema = z.object({
  code: z.number().optional(),
  msg: z.string().optional(),
  data: z.unknown().optional(),
}).passthrough();

const cardIdResultSchema = z.object({
  card_id: z.string().trim().min(1),
});

const messageIdResultSchema = z.object({
  message_id: z.string().trim().min(1),
});

/** The stable id of the single streaming markdown element inside a CardKit card. */
export const STREAM_MARKDOWN_ELEMENT_ID = 'stream_md';

/**
 * The summary shown while a streaming card is still generating (Feishu
 * previews this in chat lists until streaming is closed and a real summary is
 * written).
 */
export const STREAM_GENERATING_SUMMARY = '[Generating...]';

/**
 * Build the Card JSON 2.0 payload of a native-streaming card entity. The
 * element carries a stable `element_id` and the card opens `streaming_mode`
 * with Feishu's typewriter `streaming_config`, matching the official "流式更新
 * 卡片" flow (cardkit.v1.card.create → cardElement.content → card.settings).
 */
export function streamingCardJson(initialText: string, summary: string = STREAM_GENERATING_SUMMARY): string {
  return JSON.stringify({
    schema: '2.0',
    config: {
      streaming_mode: true,
      summary: { content: summary },
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: 'fast',
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          element_id: STREAM_MARKDOWN_ELEMENT_ID,
          content: initialText,
        },
      ],
    },
  });
}

export interface LarkOpenApiOutboundOptions {
  /** Official OpenAPI client (real `Client` or injected fake). */
  client: LarkOpenApiClient;
  /** Injectable image-byte fetch for `sendMedia` URLs (tests); defaults to `fetch`. */
  fetchImage?: (url: string) => Promise<Buffer>;
}

/**
 * Official-OpenAPI implementation of the outbound surface (plain messages,
 * media, Card JSON 2.0 interactive cards and CardKit 2.0 entities + native
 * streaming). No `receive` here: in SDK mode the inbound leg stays on the WS
 * long-connection, and this driver is composed as the `outbound` half of
 * `LarkSdkUpstream`.
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

  sendInteractive(to: string, text: string, actions: OutboundActionRow[]): Promise<unknown> {
    return this.options.client.im.v1.message.create({
      params: { receive_id_type: receiveIdType(to) },
      data: {
        receive_id: to,
        msg_type: 'interactive',
        content: interactiveCardContent(text, actions),
      },
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

  async createCardEntity(cardJson: string): Promise<{ cardId: string }> {
    const response = await this.options.client.cardkit.v1.card.create({
      data: { type: 'card_json', data: cardJson },
    });
    const envelope = parseEnvelope(response);
    const parsed = cardIdResultSchema.safeParse(envelope.data);
    if (!parsed.success) {
      throw new ChannelError('CHANNEL_ERROR', 'lark cardkit.card.create returned no card_id');
    }
    return { cardId: parsed.data.card_id };
  }

  async sendCardEntity(conversationId: string, cardId: string): Promise<{ messageId: string }> {
    const response = await this.options.client.im.v1.message.create({
      params: { receive_id_type: receiveIdType(conversationId) },
      data: {
        receive_id: conversationId,
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
      },
    });
    const envelope = parseEnvelope(response);
    const parsed = messageIdResultSchema.safeParse(envelope.data);
    if (!parsed.success) {
      throw new ChannelError('CHANNEL_ERROR', 'lark card reference send returned no message_id');
    }
    return { messageId: parsed.data.message_id };
  }

  async updateCardElementContent(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
    uuid: string,
  ): Promise<unknown> {
    return this.options.client.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: elementId },
      data: { uuid, content, sequence },
    });
  }

  async finishStreamingCard(cardId: string, sequence: number, summary: string): Promise<unknown> {
    return this.options.client.cardkit.v1.card.settings({
      path: { card_id: cardId },
      data: {
        settings: JSON.stringify({ config: { streaming_mode: false, summary: { content: summary } } }),
        sequence,
        uuid: `s_${cardId}_${sequence}`,
      },
    });
  }

  updateInteractive(cardId: string, text: string, actions: OutboundActionRow[]): Promise<unknown> {
    return this.options.client.im.v1.message.patch({
      path: { message_id: cardId },
      data: { content: interactiveCardContent(text, actions) },
    });
  }

  async getChatType(conversationId: string): Promise<'p2p' | 'group' | undefined> {
    const chat = this.options.client.im.v1.chat;
    if (!chat) return undefined;
    const parsed = chatModeResponseSchema.safeParse(await chat.get({ path: { chat_id: conversationId } }));
    if (!parsed.success || parsed.data.code !== undefined && parsed.data.code !== 0) return undefined;
    const mode = parsed.data.data?.chat_mode;
    return mode === 'p2p' ? 'p2p' : mode === 'group' || mode === 'topic' ? 'group' : undefined;
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

/** Validate an SDK envelope and return the raw parsed object. */
function parseEnvelope(response: unknown): { code?: number; msg?: string; data?: unknown } {
  const parsed = envelopeSchema.safeParse(response);
  if (!parsed.success) {
    throw new ChannelError('CHANNEL_ERROR', 'lark openapi returned an invalid envelope');
  }
  return parsed.data;
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

/**
 * Card JSON 2.0 content for a single markdown element (used by the interactive
 * card rewrite path that patches an already-sent message). The 2.0 `markdown`
 * element renders the full Lark-flavoured Markdown (headings, lists, code
 * blocks, tables, links).
 */
export function cardContent(text: string): string {
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: {
      elements: [{ tag: 'markdown', content: text }],
    },
  });
}

/**
 * Official Card JSON 2.0 button layout. V2 removed the legacy `action`
 * container: buttons are direct body elements and callback values belong to
 * `behaviors[].value`. No `tag: "action"` container and no `lark_md` are ever
 * emitted.
 */
export function interactiveCardContent(text: string, rows: OutboundActionRow[]): string {
  const elements: object[] = [{ tag: 'markdown', content: text }];
  for (const row of rows) {
    for (const action of row.actions) {
      elements.push({
        tag: 'button',
        text: { tag: 'plain_text', content: action.label },
        ...(buttonType(action.style) ? { type: buttonType(action.style) } : {}),
        behaviors: [{ type: 'callback', value: { actionId: action.id } }],
      });
    }
  }
  return JSON.stringify({
    schema: '2.0',
    config: { wide_screen_mode: true },
    body: { elements },
  });
}

function buttonType(style: 'default' | 'primary' | 'success' | 'danger' | undefined): 'primary' | 'danger' | undefined {
  if (style === 'primary' || style === 'success') return 'primary';
  return style === 'danger' ? 'danger' : undefined;
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
