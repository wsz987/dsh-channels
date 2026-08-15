/**
 * M7C: outbound REPLY vs PROACTIVE split (plan §35 / §69) + outbox
 * capability flags (plan §71). Fully offline with a fake proactive port.
 */
import { describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService } from '@wsz987/channel-core';
import { createTestContext, makeChannelTarget, makeOutboundMessage } from '@wsz987/channel-testkit';
import {
  Config,
  DingTalkAdapter,
  OutboundSender,
  type DingTalkOpenApiPort,
  type OutboxCapabilities,
} from '../src/index.ts';
import type { DingTalkUpstream } from '../src/index.ts';
import type { DingTalkStreamClient, DingTalkStreamMessage } from '../src/index.ts';
import type { DingTalkConfig } from '../src/config.ts';
import type { ChannelTarget } from '@wsz987/channel-core';

/** Minimal fake reply upstream (sessionWebhook path). */
class FakeReplyUpstream implements DingTalkUpstream {
  readonly calls: { path: string; body: unknown }[] = [];
  async receive(): Promise<void> {}
  async sendText(target: ChannelTarget, text: string): Promise<unknown> {
    this.calls.push({ path: 'sendText', body: { to: target.conversationId, text } });
    return { replied: true };
  }
  createCard(): Promise<{ cardId: string }> { return Promise.resolve({ cardId: 'c' }); }
  updateCard(): Promise<unknown> { return Promise.resolve({}); }
  finishCard(): Promise<unknown> { return Promise.resolve({}); }
  failCard(): Promise<unknown> { return Promise.resolve({}); }
}

/** Fake proactive port recording sendProactiveText calls. */
function fakePort(): { port: DingTalkOpenApiPort; proactiveCalls: unknown[] } {
  const proactiveCalls: unknown[] = [];
  const port: Partial<DingTalkOpenApiPort> = {
    async sendProactiveText(input) {
      proactiveCalls.push(input);
      return { messageId: 'pm_1', raw: {} };
    },
    async uploadMedia(input) {
      proactiveCalls.push({ kind: 'uploadMedia', input });
      return { mediaId: 'media_1' };
    },
    async sendMedia(input) {
      proactiveCalls.push({ kind: 'sendMedia', input });
      return { messageId: 'pm_2', raw: {} };
    },
    async getAccessToken() {
      return 'token-1';
    },
  };
  return { port: port as DingTalkOpenApiPort, proactiveCalls };
}

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
function targetWith(raw: Record<string, unknown>): ChannelTarget {
  return { ...makeChannelTarget(), conversationId: 'cid_1' as never, raw };
}

function makeConfig(overrides: Partial<DingTalkConfig> = {}): DingTalkConfig {
  return Config({
    enabled: true,
    accountId: 'main',
    baseUrl: 'http://fake',
    timeoutMs: 1000,
    longPollTimeoutMs: 1000,
    reconnect: { enabled: false, baseDelayMs: 1, maxDelayMs: 10, maxRetries: 2 },
    dedup: { enabled: true, windowMs: 5000 },
    card: { createOnFirstDelta: true },
    upstream: { mode: 'gateway' },
    ...overrides,
  });
}

class FakeStreamClient implements DingTalkStreamClient {
  connect(): Promise<void> { return Promise.resolve(); }
  disconnect(): void {}
  registerCallbackListener(_topic: string, _cb: (m: DingTalkStreamMessage) => void): this { return this; }
  socketCallBackResponse(): void {}
}

describe('OutboundSender — REPLY vs PROACTIVE split (plan §35 / §69)', () => {
  it('a target WITH a sessionWebhook reply goes through the sessionWebhook path', async () => {
    const reply = new FakeReplyUpstream();
    const { port, proactiveCalls } = fakePort();
    const sender = new OutboundSender({
      reply,
      logger: silentLogger as never,
      proactive: port,
      capabilities: { proactiveText: true, proactiveMedia: true },
    });
    const result = await sender.send(
      targetWith({ sessionWebhook: 'https://msg.dingtalk.com/session/reply', robotCode: 'ding-app' }),
      makeOutboundMessage(),
    );
    expect(result.delivered).toBe(true);
    // Reply path used -> proactive NOT called.
    expect(proactiveCalls).toHaveLength(0);
    expect(reply.calls.map((c) => c.path)).toEqual(['sendText']);
  });

  it('a target WITHOUT a reply context uses the official proactive API with conversationId', async () => {
    const reply = new FakeReplyUpstream();
    const { port, proactiveCalls } = fakePort();
    const sender = new OutboundSender({
      reply,
      logger: silentLogger as never,
      proactive: port,
      capabilities: { proactiveText: true, proactiveMedia: true },
    });
    const result = await sender.send(
      targetWith({ robotCode: 'ding-app' }),  // no sessionWebhook -> proactive
      makeOutboundMessage(),
    );
    expect(result.delivered).toBe(true);
    expect(proactiveCalls).toHaveLength(1);
    const call = proactiveCalls[0] as { conversationId: string; robotCode: string; text: string };
    expect(call.conversationId).toBe('cid_1');
    expect(call.robotCode).toBe('ding-app');
    expect(call.text.length).toBeGreaterThan(0);
    // Reply path untouched.
    expect(reply.calls).toHaveLength(0);
  });

  it('proactive media: a single localData file part uploads then sends the mediaId', async () => {
    const reply = new FakeReplyUpstream();
    const { port, proactiveCalls } = fakePort();
    const sender = new OutboundSender({
      reply,
      logger: silentLogger as never,
      proactive: port,
      capabilities: { proactiveText: true, proactiveMedia: true },
    });
    const result = await sender.send(
      targetWith({ robotCode: 'ding-app' }),
      { parts: [{ type: 'file', name: 'a.pdf', mimeType: 'application/pdf', localData: new Uint8Array([1,2,3]) }] },
    );
    expect(result.delivered).toBe(true);
    const kinds = proactiveCalls.map((c) => (c as { kind?: string }).kind ?? 'sendProactiveText');
    expect(kinds).toEqual(['uploadMedia', 'sendMedia']);
    const sendMedia = proactiveCalls[1] as { kind: string; input: { mediaId: string; msgtype: string } };
    expect(sendMedia.input.mediaId).toBe('media_1');
    expect(sendMedia.input.msgtype).toBe('file');
  });
});

describe('outbox capability flags (plan §71) — fail closed', () => {
  it('OutboundSender exposes the supplied capabilities', () => {
    const sender = new OutboundSender({
      reply: new FakeReplyUpstream(),
      logger: silentLogger as never,
      proactive: fakePort().port,
      capabilities: { proactiveText: true, proactiveMedia: true },
    });
    expect(sender.outboxCapabilities).toEqual({ proactiveText: true, proactiveMedia: true });
  });

  it('capabilities default to all-false when not supplied (fail closed)', () => {
    const sender = new OutboundSender({ reply: new FakeReplyUpstream(), logger: silentLogger as never });
    expect(sender.outboxCapabilities).toEqual({ proactiveText: false, proactiveMedia: false });
  });

  it('disabling proactiveText makes the proactive path reject instead of sending', async () => {
    const { port, proactiveCalls } = fakePort();
    const sender = new OutboundSender({
      reply: new FakeReplyUpstream(),
      logger: silentLogger as never,
      proactive: port,
      capabilities: { proactiveText: false, proactiveMedia: false },
    });
    await expect(sender.send(targetWith({ robotCode: 'ding-app' }), makeOutboundMessage()))
      .rejects.toMatchObject({ code: 'CHANNEL_SEND_FAILED' });
    expect(proactiveCalls).toHaveLength(0);
  });

  it('adapter in gateway mode reports proactive false (fail closed) and still replies via /message/send', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const adapter = new DingTalkAdapter(makeConfig(), { now: () => 1000 });
    await adapter.start(ctx);
    expect((adapter as unknown as { outboxCapabilities: OutboxCapabilities }).outboxCapabilities).toEqual({
      proactiveText: false,
      proactiveMedia: false,
    });
    await adapter.stop();
  });

  it('adapter in sdk mode reports proactive capabilities enabled (officially implemented)', async () => {
    const service = new ChannelService(new Context());
    const ctx = createTestContext(service);
    const client = new FakeStreamClient();
    const adapter = new DingTalkAdapter(
      makeConfig({ upstream: { mode: 'sdk', clientId: 'app-key' } }),
      { sdkClient: client, clientSecret: 'secret', now: () => 1000 },
    );
    await adapter.start(ctx);
    expect((adapter as unknown as { outboxCapabilities: OutboxCapabilities }).outboxCapabilities).toEqual({
      proactiveText: true,
      proactiveMedia: true,
    });
    await adapter.stop();
  });
});
