import { describe, expect, it } from 'vitest';
import type { ChannelTarget } from '@wsz987/channel-core';
import { ChannelError } from '@wsz987/channel-core';
import { DingTalkOfficialUpstream, type HttpRequestInit, type HttpTransport } from '../src/index.ts';

const API = 'https://api.dingtalk.com';
const tokenPath = `${API}/v1.0/oauth2/accessToken`;

class FakeTransport implements HttpTransport {
  readonly calls: { path: string; init?: HttpRequestInit }[] = [];
  readonly routes = new Map<string, () => unknown>();

  route(path: string, response: unknown): this {
    this.routes.set(path, () => response);
    return this;
  }

  request(path: string, init?: HttpRequestInit): Promise<unknown> {
    this.calls.push({ path, init });
    const handler = this.routes.get(path);
    if (!handler) return Promise.reject(new ChannelError('CHANNEL_ERROR', `no route for ${path}`));
    return Promise.resolve(handler());
  }
}

function target(raw: Record<string, unknown> = {}): ChannelTarget {
  return {
    channelId: 'dingtalk' as never,
    accountId: 'main' as never,
    conversationId: 'cid_123' as never,
    conversationType: 'dm',
    raw,
  };
}

describe('DingTalkOfficialUpstream', () => {
  it('replies through the inbound sessionWebhook instead of the legacy local gateway', async () => {
    const transport = new FakeTransport()
      .route(tokenPath, { accessToken: 'token-1', expireIn: 7200 })
      .route('https://example.dingtalk.com/session/reply', { processQueryKey: 'sent-1' });
    const upstream = new DingTalkOfficialUpstream({
      transport,
      clientId: 'ding-app',
      clientSecret: 'secret-value',
      now: () => 1_000,
    });

    await expect(upstream.sendText(target({ sessionWebhook: 'https://example.dingtalk.com/session/reply' }), 'hello'))
      .resolves.toEqual({ processQueryKey: 'sent-1' });

    expect(transport.calls).toEqual([
      {
        path: tokenPath,
        init: { method: 'POST', body: { appKey: 'ding-app', appSecret: 'secret-value' } },
      },
      {
        path: 'https://example.dingtalk.com/session/reply',
        init: {
          method: 'POST',
          headers: { 'x-acs-dingtalk-access-token': 'token-1' },
          body: { msgtype: 'text', text: { content: 'hello' } },
        },
      },
    ]);
  });

  it('creates, delivers, streams, and finalizes an AI Card through the official OpenAPI', async () => {
    const transport = new FakeTransport()
      .route(tokenPath, { accessToken: 'token-1', expireIn: 7200 })
      .route(`${API}/v1.0/card/instances`, {})
      .route(`${API}/v1.0/card/instances/deliver`, {})
      .route(`${API}/v1.0/card/streaming`, {});
    const upstream = new DingTalkOfficialUpstream({
      transport,
      clientId: 'ding-app',
      clientSecret: 'secret-value',
      now: () => 1_000,
    });
    const card = await upstream.createCard(target({ senderId: 'staff-1', robotCode: 'ding-app' }), '');
    await upstream.updateCard(card.cardId, 'partial');
    await upstream.finishCard(card.cardId, 'complete');

    expect(transport.calls.map((call) => call.path)).toEqual([
      tokenPath,
      `${API}/v1.0/card/instances`,
      `${API}/v1.0/card/instances/deliver`,
      `${API}/v1.0/card/instances`,
      `${API}/v1.0/card/streaming`,
      `${API}/v1.0/card/streaming`,
    ]);
    expect(transport.calls[2]?.init?.body).toMatchObject({
      outTrackId: card.cardId,
      openSpaceId: 'dtv1.card//IM_ROBOT.staff-1',
      imRobotOpenDeliverModel: { robotCode: 'ding-app' },
    });
    expect(transport.calls[5]?.init?.body).toMatchObject({
      outTrackId: card.cardId,
      content: 'complete',
      isFinalize: true,
    });
  });

  it('rejects an outbound reply without the message-scoped webhook', async () => {
    const upstream = new DingTalkOfficialUpstream({
      transport: new FakeTransport(),
      clientId: 'ding-app',
      clientSecret: 'secret-value',
    });
    await expect(upstream.sendText(target(), 'hello')).rejects.toThrow('missing the inbound sessionWebhook');
  });

  it('rejects an invalid token response before attempting a reply', async () => {
    const transport = new FakeTransport().route(tokenPath, { token: 'wrong-shape' });
    const upstream = new DingTalkOfficialUpstream({
      transport,
      clientId: 'ding-app',
      clientSecret: 'secret-value',
    });
    await expect(upstream.sendText(target({ sessionWebhook: 'https://example.dingtalk.com/session/reply' }), 'hello'))
      .rejects.toThrow('access token response is invalid');
    expect(transport.calls).toHaveLength(1);
  });
});
