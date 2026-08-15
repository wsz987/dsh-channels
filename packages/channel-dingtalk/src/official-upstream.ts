/**
 * Official DingTalk outbound driver for Stream-mode bots.
 *
 * Stream messages carry a short-lived sessionWebhook for replies to the
 * triggering message. AI Cards use the documented DingTalk OpenAPI and an
 * application access token. Neither path requires the legacy local gateway.
 */
import type { ChannelTarget } from '@wsz987/channel-core';
import { ChannelError } from '@wsz987/channel-core';
import { z } from 'zod';
import type { CardCreateResult, DingTalkUpstream } from './upstream.js';
import type { HttpTransport } from './transport.js';

const DINGTALK_API = 'https://api.dingtalk.com';
const AI_CARD_TEMPLATE_ID = '02fcf2f4-5e02-4a85-b672-46d1f715543e.schema';

const tokenSchema = z.object({
  accessToken: z.string().trim().min(1),
  expireIn: z.coerce.number().positive().optional(),
}).passthrough();

const replyTargetSchema = z.object({
  sessionWebhook: z.string().url().optional(),
  conversationType: z.string().optional(),
  conversationId: z.string().min(1).optional(),
  senderId: z.string().min(1).optional(),
  robotCode: z.string().min(1).optional(),
}).passthrough();

interface DingTalkOfficialUpstreamOptions {
  transport: HttpTransport;
  clientId?: string;
  clientSecret?: string;
  now?: () => number;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

/** Stream-mode outbound implementation using DingTalk's public HTTP APIs. */
export class DingTalkOfficialUpstream implements DingTalkUpstream {
  private readonly now: () => number;
  private cachedToken?: CachedToken;
  private readonly inputingCards = new Set<string>();

  constructor(private readonly options: DingTalkOfficialUpstreamOptions) {
    this.now = options.now ?? Date.now;
  }

  async receive(): Promise<void> {
    throw new ChannelError('CHANNEL_ERROR', 'official DingTalk outbound driver does not receive messages');
  }

  async sendText(target: ChannelTarget, text: string): Promise<unknown> {
    const targetData = this.targetData(target);
    const sessionWebhook = targetData.sessionWebhook;
    if (!sessionWebhook) {
      throw new ChannelError('CHANNEL_ERROR', 'dingtalk reply is missing the inbound sessionWebhook');
    }
    return this.options.transport.request(sessionWebhook, {
      method: 'POST',
      headers: { 'x-acs-dingtalk-access-token': await this.accessToken() },
      body: { msgtype: 'text', text: { content: text } },
    });
  }

  async createCard(target: ChannelTarget, _text: string): Promise<CardCreateResult> {
    const targetData = this.targetData(target);
    const token = await this.accessToken();
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
      headers: { 'x-acs-dingtalk-access-token': await this.accessToken() },
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
      headers: { 'x-acs-dingtalk-access-token': await this.accessToken() },
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
      headers: { 'x-acs-dingtalk-access-token': await this.accessToken() },
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

  private async ensureCardInputing(cardId: string, text: string): Promise<void> {
    if (this.inputingCards.has(cardId)) return;
    await this.options.transport.request(`${DINGTALK_API}/v1.0/card/instances`, {
      method: 'PUT',
      headers: { 'x-acs-dingtalk-access-token': await this.accessToken() },
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

  private async accessToken(): Promise<string> {
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
