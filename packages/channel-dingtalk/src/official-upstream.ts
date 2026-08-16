/***
 * Official DingTalk OpenAPI port implementation (plan §33 / §34).
 *
 * Positioned as `DingTalkOpenApiPortImpl` (plan §34): it is the thin
 * implementation of `DingTalkOpenApiPort`, and it also implements the
 * `DingTalkUpstream` outbound surface so `DingTalkStreamUpstream` can keep
 * delegating to it unchanged. Stream-mode reply messages carry a short-lived
 * sessionWebhook used ONLY for the current inbound reply (plan §35); AI Cards
 * and proactive sends use the documented DingTalk OpenAPI with an application
 * access token. Neither path requires the legacy local gateway.
 *
 * Behavior oracle / payload contract (plan §32 / §33):
 *   `@dingtalk-real-ai/dingtalk-connector@0.8.24`.
 * Every port method records its official-behavior basis in
 * `DingTalkOpenApiPortImpl.OFFICIAL_BASIS` (and its own docblock). Methods with
 * no official-behavior basis are marked `@upstream-gap` / `@deprecated` with a
 * reason, per plan §34 (delete any protocol with no official basis).
 */
import type { ChannelTarget } from '@wsz987/channel-core';
import { ChannelError, SecureRemoteMediaFetcher } from '@wsz987/channel-core';
import { z } from 'zod';
import type { CardCreateResult, DingTalkUpstream } from './upstream.js';
import type { HttpTransport } from './transport.js';
import { sniffImageMime } from './media-mime.js';
import type { RemoteMediaFetchLike } from './image-hydrator.js';
import type {
  DingTalkOpenApiPort,
  DingTalkOpenApiCredentials,
  MediaSendInput,
  MediaUploadInput,
  MediaUploadResult,
  ProactiveTextInput,
  ResolvedMedia,
  RobotMessageSendResult,
} from './openapi-port.js';

const DINGTALK_API = 'https://api.dingtalk.com';
const DINGTALK_OAPI = 'https://oapi.dingtalk.com';
const AI_CARD_TEMPLATE_ID = '02fcf2f4-5e02-4a85-b672-46d1f715543e.schema';

const tokenSchema = z.object({
  accessToken: z.string().trim().min(1),
  expireIn: z.coerce.number().positive().optional(),
}).passthrough();

const mediaUploadSchema = z.object({
  mediaId: z.string().min(1).optional(),
  media_id: z.string().min(1).optional(),
  mediaIdV2: z.string().min(1).optional(),
}).passthrough();

const replyTargetSchema = z.object({
  sessionWebhook: z.string().url().optional(),
  conversationType: z.string().optional(),
  conversationId: z.string().min(1).optional(),
  senderId: z.string().min(1).optional(),
  robotCode: z.string().min(1).optional(),
}).passthrough();

export interface DingTalkOfficialUpstreamOptions extends DingTalkOpenApiCredentials {
  transport: HttpTransport;
  /** Shared host safety boundary for short-lived DingTalk download URLs. */
  secureFetch?: RemoteMediaFetchLike;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

/**
 * Official DingTalk OpenAPI port implementation (plan §34 rename of the former
 * `DingTalkOfficialUpstream`). Implements the small `DingTalkOpenApiPort`
 * (plan §33) plus the `DingTalkUpstream` outbound surface it always had.
 *
 * The legacy name `DingTalkOfficialUpstream` is preserved as an alias below so
 * existing import/call sites and tests keep compiling unchanged.
 */
export class DingTalkOpenApiPortImpl implements DingTalkOpenApiPort, DingTalkUpstream {
  private readonly now: () => number;
  private cachedToken?: CachedToken;
  private readonly inputingCards = new Set<string>();
  private readonly secureFetch: RemoteMediaFetchLike;

  constructor(private readonly options: DingTalkOfficialUpstreamOptions) {
    this.now = options.now ?? Date.now;
    this.secureFetch = options.secureFetch ?? new SecureRemoteMediaFetcher();
  }

  async receive(): Promise<void> {
    throw new ChannelError('CHANNEL_ERROR', 'official DingTalk outbound driver does not receive messages');
  }

  /** Reply path (plan §35): sessionWebhook is ONLY for the current inbound reply. */
  async sendText(target: ChannelTarget, text: string): Promise<unknown> {
    const targetData = this.targetData(target);
    const sessionWebhook = targetData.sessionWebhook;
    if (!sessionWebhook) {
      throw new ChannelError('CHANNEL_ERROR', 'dingtalk reply is missing the inbound sessionWebhook');
    }
    return this.options.transport.request(sessionWebhook, {
      method: 'POST',
      headers: { 'x-acs-dingtalk-access-token': await this.getAccessToken() },
      body: { msgtype: 'text', text: { content: text } },
    });
  }

  /**
   * Get (and cache) the application access token. Official behavior basis:
   * DingTalk OpenAPI `POST /v1.0/oauth2/accessToken` (the official connector's
   * token acquisition, mirrored here).
   */
  async getAccessToken(): Promise<string> {
    const now = this.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60_000) return this.cachedToken.value;
    const clientId = this.options.clientId?.trim();
    const clientSecret = this.options.clientSecret?.trim();
    if (!clientId || !clientSecret) {
      throw new ChannelError('CHANNEL_ERROR', 'dingtalk official outbound requires clientId and clientSecret');
    }
    const raw = await this.options.transport.request(`${DINGTALK_API}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      body: { appKey: clientId, appSecret: clientSecret },
    });
    const parsed = tokenSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ChannelError('CHANNEL_ERROR', 'dingtalk access token response is invalid');
    }
    const expireInMs = (parsed.data.expireIn ?? 7200) * 1000;
    this.cachedToken = { value: parsed.data.accessToken, expiresAt: now + expireInMs };
    return this.cachedToken.value;
  }

  /**
   * Proactive plain-text robot send (plan §35 / §69): official proactive API,
   * never sessionWebhook. Official behavior basis: DingTalk robot message send
   * (`POST /v1.0/robot/groupMessages/send` for groups;
   * `POST /v1.0/robot/oToMessages/batchSend` for single chat), msgKey `sampleText`,
   * msgParam `{ "content": ... }` — mirrors the official connector's proactive
   * robot message path. Payload contract from the official connector.
   */
  async sendProactiveText(input: ProactiveTextInput): Promise<RobotMessageSendResult> {
    const key = input.conversationType === 'dm' ? 'oToMessages/batchSend' : 'groupMessages/send';
    const token = await this.getAccessToken();
    const body: Record<string, unknown> = input.conversationType === 'dm'
      ? { robotCode: input.robotCode, userIds: [input.conversationId], msgKey: 'sampleText', msgParam: JSON.stringify({ content: input.text }) }
      : { openConversationId: input.conversationId, robotCode: input.robotCode, msgKey: 'sampleText', msgParam: JSON.stringify({ content: input.text }) };
    const raw = await this.options.transport.request(`${DINGTALK_API}/v1.0/robot/${key}`, {
      method: 'POST',
      headers: { 'x-acs-dingtalk-access-token': token },
      body,
    });
    const messageId = (raw as { messageId?: string })?.messageId;
    return { messageId, raw };
  }

  /**
   * Upload a media file (plan §86 media upload). Official behavior basis:
   * DingTalk media upload `POST /media/upload?access_token=...&type=image|file`
   * as used by the connector. Standard `FormData` delegates multipart framing
   * to fetch instead of reproducing a platform protocol in this package.
   */
  async uploadMedia(input: MediaUploadInput): Promise<MediaUploadResult> {
    const token = await this.getAccessToken();
    const form = new FormData();
    form.append(
      'media',
      new Blob([input.data], { type: input.mimeType ?? 'application/octet-stream' }),
      input.fileName,
    );
    const raw = await this.options.transport.request(
      `${DINGTALK_OAPI}/media/upload?access_token=${encodeURIComponent(token)}&type=${input.mediaType}`,
      { method: 'POST', body: form },
    );
    const parsed = mediaUploadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ChannelError('CHANNEL_ERROR', 'dingtalk media upload response is missing mediaId');
    }
    const mediaId = parsed.data.mediaId ?? parsed.data.media_id ?? parsed.data.mediaIdV2;
    if (!mediaId) {
      throw new ChannelError('CHANNEL_ERROR', 'dingtalk media upload response is missing mediaId');
    }
    return { mediaId };
  }

  /**
   * Send an uploaded mediaId as a robot image/file message (plan §86 media send).
   * Official behavior basis: DingTalk robot message send with msgKey
   * `sampleImageMsg` with `{ photoURL: mediaId }` for images, and
   * `sampleFile` with `{ mediaId, fileName, fileType }` for files, matching
   * the connector's verified proactive paths.
   */
  async sendMedia(input: MediaSendInput): Promise<RobotMessageSendResult> {
    const key = input.conversationType === 'dm' ? 'oToMessages/batchSend' : 'groupMessages/send';
    const token = await this.getAccessToken();
    const msgParam = input.msgtype === 'image'
      ? JSON.stringify({ photoURL: input.mediaId })
      : JSON.stringify({
        mediaId: input.mediaId,
        fileName: input.name ?? 'file',
        fileType: extensionOf(input.name),
      });
    const msgKey = input.msgtype === 'image' ? 'sampleImageMsg' : 'sampleFile';
    const body: Record<string, unknown> = input.conversationType === 'dm'
      ? { robotCode: input.robotCode, userIds: [input.conversationId], msgKey, msgParam }
      : { openConversationId: input.conversationId, robotCode: input.robotCode, msgKey, msgParam };
    const raw = await this.options.transport.request(`${DINGTALK_API}/v1.0/robot/${key}`, {
      method: 'POST',
      headers: { 'x-acs-dingtalk-access-token': token },
      body,
    });
    const messageId = (raw as { messageId?: string })?.messageId;
    return { messageId, raw };
  }

  async createCard(target: ChannelTarget, _text: string): Promise<CardCreateResult> {
    const targetData = this.targetData(target);
    const token = await this.getAccessToken();
    const cardId = `card_${this.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await this.options.transport.request(`${DINGTALK_API}/v1.0/card/instances`, {
      method: 'POST',
      headers: { 'x-acs-dingtalk-access-token': token },
      body: {
        cardTemplateId: AI_CARD_TEMPLATE_ID,
        outTrackId: cardId,
        cardData: { cardParamMap: { config: JSON.stringify({ autoLayout: true }) } },
        callbackType: 'STREAM',
        imGroupOpenSpaceModel: { supportForward: true },
        imRobotOpenSpaceModel: { supportForward: true },
      },
    });
    await this.options.transport.request(`${DINGTALK_API}/v1.0/card/instances/deliver`, {
      method: 'POST',
      headers: { 'x-acs-dingtalk-access-token': token },
      body: this.cardDelivery(cardId, target, targetData),
    });
    return { cardId };
  }

  async updateCard(cardId: string, text: string): Promise<unknown> {
    await this.ensureCardInputing(cardId, text);
    return this.options.transport.request(`${DINGTALK_API}/v1.0/card/streaming`, {
      method: 'PUT',
      headers: { 'x-acs-dingtalk-access-token': await this.getAccessToken() },
      body: {
        outTrackId: cardId,
        guid: `${this.now()}_${Math.random().toString(36).slice(2, 8)}`,
        key: 'msgContent',
        content: text,
        isFull: true,
        isFinalize: false,
        isError: false,
      },
    });
  }

  async finishCard(cardId: string, text = ''): Promise<unknown> {
    await this.ensureCardInputing(cardId, text);
    const result = await this.options.transport.request(`${DINGTALK_API}/v1.0/card/streaming`, {
      method: 'PUT',
      headers: { 'x-acs-dingtalk-access-token': await this.getAccessToken() },
      body: {
        outTrackId: cardId,
        guid: `${this.now()}_${Math.random().toString(36).slice(2, 8)}`,
        key: 'msgContent',
        content: text,
        isFull: true,
        isFinalize: true,
        isError: false,
      },
    });
    this.inputingCards.delete(cardId);
    return result;
  }

  async failCard(cardId: string, reason?: string): Promise<unknown> {
    await this.ensureCardInputing(cardId, reason ?? '');
    const result = await this.options.transport.request(`${DINGTALK_API}/v1.0/card/streaming`, {
      method: 'PUT',
      headers: { 'x-acs-dingtalk-access-token': await this.getAccessToken() },
      body: {
        outTrackId: cardId,
        guid: `${this.now()}_${Math.random().toString(36).slice(2, 8)}`,
        key: 'msgContent',
        content: reason ?? '',
        isFull: true,
        isFinalize: true,
        isError: true,
      },
    });
    this.inputingCards.delete(cardId);
    return result;
  }

  /**
   * Resolve an opaque DingTalk media handle (mediaId / downloadCode) into
   * trusted bytes (plan §32A). Official behavior basis: the connector's
   * `downloadMediaByCode` / `getFileDownloadUrl` — POST
   * `/v1.0/robot/messageFiles/download` with `{ downloadCode, robotCode }`
   * and the application access token returns `{ downloadUrl }`; the URL is
   * then fetched as raw bytes (responseType arraybuffer). A genuine http(s)
   * `ref` is fetched directly. Fails closed with a typed error when an opaque
   * ref lacks the per-message `downloadCode` context.
   */
  async resolveMedia(
    ref: string,
    options?: { signal?: AbortSignal; name?: string; downloadCode?: string; robotCode?: string },
  ): Promise<ResolvedMedia> {
    const isOpaqueRef = !/^https?:\/\//i.test(ref);
    const downloadUrl = await this.getMediaDownloadUrl(ref, options);
    if (!downloadUrl) {
      throw new ChannelError(
        'CHANNEL_ERROR',
        'dingtalk resolveMedia: opaque ref requires per-message downloadCode context (official messageFiles/download API)',
      );
    }
    const result = await this.secureFetch.fetchBounded(downloadUrl, {
      maxBytes: 100 * 1024 * 1024,
      idleTimeoutMs: 15_000,
      timeoutMs: 60_000,
      // DingTalk's authenticated messageFiles/download endpoint can return a
      // short-lived http:// CDN URL. Permit that scheme only for an opaque
      // handle resolved by this trusted API; direct HTTP refs remain blocked.
      allowHttp: isOpaqueRef,
      signal: options?.signal,
    });
    return {
      data: result.data,
      mimeType: result.mimeType ?? sniffImageMime(result.data),
      size: result.data.byteLength,
    };
  }

  /**
   * Resolve an opaque DingTalk media handle into a download URL. Official
   * behavior basis: the connector's `getFileDownloadUrl` — POST
   * `/v1.0/robot/messageFiles/download` with `{ downloadCode, robotCode }`
   * and `x-acs-dingtalk-access-token`. A genuine http(s) ref is returned
   * as-is. Returns `undefined` (fail closed) when an opaque ref lacks the
   * downloadCode context.
   */
  async getMediaDownloadUrl(
    ref: string,
    options?: { signal?: AbortSignal; downloadCode?: string; robotCode?: string },
  ): Promise<string | undefined> {
    // Genuine http(s) locator: hand it straight back (nothing to resolve).
    if (/^https?:\/\//i.test(ref)) return ref;
    const embeddedDownloadCode = ref.startsWith('downloadCode:') ? ref.slice('downloadCode:'.length) : undefined;
    const downloadCode = options?.downloadCode ?? embeddedDownloadCode;
    if (!downloadCode) return undefined;
    const token = await this.getAccessToken();
    const raw = await this.options.transport.request(`${DINGTALK_API}/v1.0/robot/messageFiles/download`, {
      method: 'POST',
      headers: { 'x-acs-dingtalk-access-token': token },
      // Match the official connector exactly: robotCode is the configured
      // application AppKey/clientId, not the callback's robotCode field.
      body: { downloadCode, robotCode: String(this.options.clientId) },
      timeoutMs: 30_000,
    }, options?.signal) as { downloadUrl?: string };
    const downloadUrl = raw?.downloadUrl;
    return typeof downloadUrl === 'string' && downloadUrl.length > 0 ? downloadUrl : undefined;
  }

  private async ensureCardInputing(cardId: string, text: string): Promise<void> {
    if (this.inputingCards.has(cardId)) return;
    await this.options.transport.request(`${DINGTALK_API}/v1.0/card/instances`, {
      method: 'PUT',
      headers: { 'x-acs-dingtalk-access-token': await this.getAccessToken() },
      body: {
        outTrackId: cardId,
        cardData: {
          cardParamMap: {
            flowStatus: 'INPUTING',
            msgContent: text,
            staticMsgContent: '',
            sys_full_json_obj: JSON.stringify({ order: ['msgContent'] }),
            config: JSON.stringify({ autoLayout: true }),
          },
        },
      },
    });
    this.inputingCards.add(cardId);
  }

  private targetData(target: ChannelTarget): z.infer<typeof replyTargetSchema> {
    const parsed = replyTargetSchema.safeParse(target.raw);
    if (!parsed.success) return {};
    return parsed.data;
  }

  private cardDelivery(
    cardId: string,
    target: ChannelTarget,
    targetData: z.infer<typeof replyTargetSchema>,
  ): Record<string, unknown> {
    const robotCode = targetData.robotCode ?? this.options.clientId;
    if (!robotCode) throw new ChannelError('CHANNEL_ERROR', 'dingtalk card delivery is missing robotCode');
    if (target.conversationType === 'group' || targetData.conversationType === '2') {
      const conversationId = targetData.conversationId ?? String(target.conversationId);
      return {
        outTrackId: cardId,
        userIdType: 1,
        openSpaceId: `dtv1.card//IM_GROUP.${conversationId}`,
        imGroupOpenDeliverModel: { robotCode },
      };
    }
    const userId = targetData.senderId;
    if (!userId) throw new ChannelError('CHANNEL_ERROR', 'dingtalk card delivery is missing senderId');
    return {
      outTrackId: cardId,
      userIdType: 1,
      openSpaceId: `dtv1.card//IM_ROBOT.${userId}`,
      imRobotOpenDeliverModel: {
        spaceType: 'IM_ROBOT',
        robotCode,
        extension: { dynamicSummary: 'true' },
      },
    };
  }
}

/**
 * Official-behavior basis for every port method (plan §33): maps a port method
 * name to the corresponding official connector implementation location / behavior
 * oracle, or an explicit `@upstream-gap` / `@deprecated` marker with a reason.
 * The port-inventory test asserts every interface method has a non-empty entry
 * here (shape + marker presence).
 */
export const OFFICIAL_BASIS: Record<string, string> = {
  getAccessToken: "oracle=@dingtalk-real-ai/dingtalk-connector@0.8.24 :: DingTalk OpenAPI POST /v1.0/oauth2/accessToken token acquisition (mirrors official connector token flow)",
  sendProactiveText: "oracle=@dingtalk-real-ai/dingtalk-connector@0.8.24 :: robot message proactive send (groupMessages/send | oToMessages/batchSend, msgKey=sampleText) — payload contract from official connector",
  uploadMedia: "oracle=@dingtalk-real-ai/dingtalk-connector@0.8.24 :: OAPI POST /media/upload?access_token=...&type=image|file multipart(media) — official connector media path",
  sendMedia: "oracle=@dingtalk-real-ai/dingtalk-connector@0.8.24 :: image msgKey=sampleImageMsg msgParam={photoURL:mediaId}; file msgKey=sampleFile msgParam={mediaId,fileName,fileType}",
  createCard: "oracle=@dingtalk-real-ai/dingtalk-connector@0.8.24 :: AI Card POST /v1.0/card/instances + deliver (template 02fcf2f4-5e02-4a85-b672-46d1f715543e.schema)",
  updateCard: "oracle=@dingtalk-real-ai/dingtalk-connector@0.8.24 :: AI Card PUT /v1.0/card/streaming update (isFinalize=false)",
  finishCard: "oracle=@dingtalk-real-ai/dingtalk-connector@0.8.24 :: AI Card PUT /v1.0/card/streaming finalize (isFinalize=true)",
  failCard: "oracle=@dingtalk-real-ai/dingtalk-connector@0.8.24 :: AI Card PUT /v1.0/card/streaming error (isError=true)",
  resolveMedia: "oracle=@dingtalk-real-ai/dingtalk-connector@0.8.24 :: connector downloadMediaByCode/getFileDownloadUrl — POST /v1.0/robot/messageFiles/download {downloadCode,robotCode} -> downloadUrl -> GET raw bytes (message-handler); http(s) refs fetched directly",
  getMediaDownloadUrl: "oracle=@dingtalk-real-ai/dingtalk-connector@0.8.24 :: connector getFileDownloadUrl — POST /v1.0/robot/messageFiles/download {downloadCode,robotCode} -> {downloadUrl} (message-handler)",
};

/** Legacy alias (plan §34 rename): `DingTalkOfficialUpstream` -> `DingTalkOpenApiPortImpl`. */
export const DingTalkOfficialUpstream = DingTalkOpenApiPortImpl;

function extensionOf(fileName: string | undefined): string {
  const name = fileName?.trim() ?? '';
  const index = name.lastIndexOf('.');
  return index > -1 && index < name.length - 1 ? name.slice(index + 1).toLowerCase() : 'file';
}
