import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { ChannelService } from '@dsh/channel-core';
import type { ChannelEvent, MessageReceived } from '@dsh/channel-core';
import {
  FakeChannelAdapter,
  FakeReplyHandle,
  FakeUpstream,
  FakeHarness,
  runChannelAdapterContract,
  runHarnessCompatChecks,
  runFakeChannelE2E,
  createTestContext,
  loadFixture,
  loadFixtureSync,
  validateFixture,
  makeMessageReceived,
  makeChannelTarget,
  makeOutboundMessage,
  assertChannelError,
  expectChannelError,
  type FixtureCase,
} from '../src/index.ts';

function newChannelService(): ChannelService {
  const ctx = new Context();
  new ChannelService(ctx);
  return ctx.channels;
}

// Invoke the contract suite at top level (vitest only collects describe/it
// registered during collection, not inside `it` callbacks). Running it twice
// covers both the adapter-boundary emit path and the default direct-ctx wiring.
const contractAdapter = new FakeChannelAdapter({ id: 'fake-contract', capabilities: { markdown: true } });
const contractAdapterDefault = new FakeChannelAdapter({ id: 'fake-contract-default' });

describe('contract tests vs FakeChannelAdapter', () => {
  runChannelAdapterContract(contractAdapter, {
    // Exercise the adapter's own platform-boundary emit path.
    emitEvent: (ctx, event) => contractAdapter.receive(event),
    // Make the adapter throw a platform-style error once so the mapping test asserts.
    triggerSendFailure: () => contractAdapter.failNextSend(new Error('platform timeout')),
  });

  runChannelAdapterContract(contractAdapterDefault);
});

describe('contract tests with dedup enabled', () => {
  const dedupAdapter = new FakeChannelAdapter({ id: 'fake-dedup', dedup: true });
  runChannelAdapterContract(dedupAdapter, {
    expectedDedup: true,
    emitEvent: (ctx, event) => dedupAdapter.receive(event),
  });
});

describe('createTestContext', () => {
  it('provides a complete ChannelAdapterContext backed by the service', async () => {
    const service = newChannelService();
    const ctx = createTestContext(service);

    expect(ctx.service).toBe(service);
    expect(ctx.logger.info).toBeTypeOf('function');
    expect(ctx.signal).toBeInstanceOf(AbortSignal);
    expect(ctx.signal.aborted).toBe(false);

    const listener = vi.fn();
    const dispose = service.on(listener);
    await ctx.emit(makeMessageReceived());
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();

    await ctx.secrets.set('token', 'abc');
    expect(await ctx.secrets.get('token')).toBe('abc');
    await ctx.storage.set('cursor', '42');
    expect(await ctx.storage.get('cursor')).toBe('42');

    await ctx.dispose();
    expect(ctx.signal.aborted).toBe(true);
  });
});

describe('FakeChannelAdapter', () => {
  it('records and forwards received events through the service', async () => {
    const service = newChannelService();
    const fake = new FakeChannelAdapter({ id: 'fake', service });
    await fake.start(createTestContext(service));

    const listener = vi.fn();
    const dispose = service.on(listener);
    const event = makeMessageReceived();

    await fake.receive(event);

    expect(fake.received).toEqual([event]);
    expect(listener).toHaveBeenCalledWith(event);
    expect(fake.connectionState).toBe('connected');
    expect(fake.authState).toBe('authenticated');

    dispose();
    await fake.stop();
    expect(fake.stopCount).toBe(1);
  });

  it('ignores inbound events while stopped (cleanup semantics)', async () => {
    const service = newChannelService();
    const fake = new FakeChannelAdapter({ id: 'fake', service });
    await fake.start(createTestContext(service));

    const listener = vi.fn();
    const dispose = service.on(listener);
    await fake.receive(makeMessageReceived());
    expect(listener).toHaveBeenCalledTimes(1);

    await fake.stop();
    await fake.receive(makeMessageReceived());
    expect(listener).toHaveBeenCalledTimes(1);
    dispose();
  });

  it('records sent messages and returns SendResult', async () => {
    const fake = new FakeChannelAdapter({ id: 'fake' });
    await fake.start(createTestContext(newChannelService()));

    const result = await fake.send(makeChannelTarget(), makeOutboundMessage());

    expect(result).toEqual({ delivered: true, messageId: 'sent-1' });
    expect(fake.sentMessages).toHaveLength(1);
    expect(fake.sentMessages[0]?.message.text).toBe('hi there');
    expect(fake.sentMessages[0]?.target.conversationId).toBe('conv-1');

    await fake.stop();
  });

  it('maps a failed send to a ChannelError with a stable code', async () => {
    const fake = new FakeChannelAdapter({ id: 'fake' });
    await fake.start(createTestContext(newChannelService()));
    fake.failNextSend(new Error('platform timeout'));

    const error = await expectChannelError(
      () => fake.send(makeChannelTarget(), makeOutboundMessage()),
      'CHANNEL_SEND_FAILED',
    );
    assertChannelError(error, 'CHANNEL_SEND_FAILED');
    expect(error.message).toBe('platform timeout');

    await fake.stop();
  });

  it('reports health derived from live connection and auth state', async () => {
    const fake = new FakeChannelAdapter({ id: 'fake' });
    await fake.start(createTestContext(newChannelService()));

    const healthy = await fake.getHealth();
    expect(healthy.status).toBe('ok');
    expect(healthy.connection).toBe('connected');
    expect(healthy.authenticated).toBe(true);

    await fake.stop();
    const stopped = await fake.getHealth();
    expect(stopped.connection).toBe('disconnected');
  });

  it('creates a BufferedReply that delivers through send on finish', async () => {
    const fake = new FakeChannelAdapter({ id: 'fake' });
    await fake.start(createTestContext(newChannelService()));

    const reply = await fake.createReply(makeChannelTarget());
    await reply.append('hello ');
    await reply.append('world');
    await reply.finish();

    expect(fake.sentMessages).toHaveLength(1);
    expect(fake.sentMessages[0]?.message.text).toBe('hello world');

    await fake.stop();
  });
});

describe('FakeChannelAdapter streaming replies', () => {
  it('returns a recording FakeReplyHandle for edit streaming', async () => {
    const fake = new FakeChannelAdapter({ id: 'edit-fake', streaming: 'edit' });
    await fake.start(createTestContext(newChannelService()));

    const reply = (await fake.createReply(makeChannelTarget(), { markdown: true })) as FakeReplyHandle;

    expect(fake.capabilities.streaming).toBe('edit');
    expect(reply).toBeInstanceOf(FakeReplyHandle);
    expect(fake.replies).toEqual([reply]);

    await reply.replace({ text: 'hi' });
    await reply.replace({ text: 'hi world' });
    expect(reply.text).toBe('hi world');
    expect(reply.replaceCount).toBe(2);
    expect(reply.calls).toEqual([
      { type: 'replace', text: 'hi' },
      { type: 'replace', text: 'hi world' },
    ]);

    await reply.finish();
    expect(reply.finished).toBe(true);
    expect(reply.finishCount).toBe(1);

    await reply.fail(new Error('boom'));
    expect(reply.failed).toBe(true);
    expect(reply.failCount).toBe(1);
    expect(reply.calls[2]).toEqual({ type: 'finish', text: 'hi world' });
    expect(reply.calls[3]).toEqual({ type: 'fail', error: expect.any(Error) });

    await fake.stop();
  });

  it('accumulates appended deltas for native streaming', async () => {
    const fake = new FakeChannelAdapter({ id: 'native-fake', streaming: 'native' });
    await fake.start(createTestContext(newChannelService()));

    const reply = (await fake.createReply(makeChannelTarget())) as FakeReplyHandle;
    await reply.append('hello ');
    await reply.append('world');

    expect(reply.text).toBe('hello world');
    expect(reply.appendCount).toBe(2);

    await fake.stop();
  });

  it('failNextCall makes the next append/replace/finish throw', async () => {
    const fake = new FakeChannelAdapter({ id: 'failing-fake', streaming: 'edit' });
    await fake.start(createTestContext(newChannelService()));

    const reply = (await fake.createReply(makeChannelTarget())) as FakeReplyHandle;
    reply.failNextCall(new Error('platform update failed'));
    await expect(reply.replace({ text: 'hi' })).rejects.toThrow('platform update failed');
    expect(reply.replaceCount).toBe(0); // the throwing call was not recorded

    reply.failNextCall();
    await expect(reply.append('x')).rejects.toThrow('fake reply failure');
    await expect(reply.finish()).resolves.toBeUndefined();
    expect(reply.finished).toBe(true);

    await fake.stop();
  });

  it('keeps the default buffered createReply path unchanged', async () => {
    const fake = new FakeChannelAdapter({ id: 'buffered-fake' });
    await fake.start(createTestContext(newChannelService()));

    const reply = await fake.createReply(makeChannelTarget());
    await reply.append('a');
    await reply.append('b');
    await reply.finish();

    expect(fake.capabilities.streaming).toBe('buffered');
    expect(fake.replies).toEqual([]); // buffered replies are not recorded handles
    expect(fake.sentMessages).toHaveLength(1);
    expect(fake.sentMessages[0]?.message.text).toBe('ab');

    await fake.stop();
  });
});

describe('FakeUpstream', () => {
  it('registers handlers, counts connections and dispatches inbound payloads', async () => {
    const upstream = new FakeUpstream({ id: 'wx-upstream' });
    const seen: unknown[] = [];
    upstream.onMessage((payload) => seen.push(payload));

    await upstream.connect();
    expect(upstream.connections).toBe(1);

    const payload = { type: 'text', content: 'hello' };
    await upstream.emitMessage(payload);

    expect(upstream.received).toEqual([payload]);
    expect(seen).toEqual([payload]);

    await upstream.sendText('ok', { target: 'user_1' });
    expect(upstream.sent).toEqual([{ text: 'ok', target: 'user_1' }]);
  });

  it('fails the next call when configured', async () => {
    const upstream = new FakeUpstream();
    upstream.failNextCall = new Error('network down');
    await expect(upstream.sendText('boom')).rejects.toThrow('network down');
  });
});

describe('fixture loader', () => {
  it('loads and validates the repo weixin inbound-text fixture', async () => {
    const fixture = await loadFixture('weixin', 'inbound-text');

    expect(fixture.name).toBe('inbound text');
    expect(fixture.channel).toBe('weixin');
    expect(fixture.upstreamVersion).toBe('0.0.0-m0');
    expect((fixture.payload as { content?: unknown }).content).toBe('hello harness');
    expect((fixture.expected as { type?: unknown }).type).toBe('message.received');

    validateFixture(fixture);
  });

  it('loads synchronously and tolerates the .json suffix', () => {
    const fixture: FixtureCase = loadFixtureSync('weixin', 'inbound-text.json');
    expect(fixture.upstreamVersion).toBe('0.0.0-m0');
    expect(fixture.expected).toBeDefined();
  });

  it('rejects fixtures missing required fields', () => {
    expect(() => validateFixture({ name: 'x', payload: {} })).toThrow(/upstreamVersion/);
    expect(() => validateFixture({})).toThrow(/missing required field/);
    expect(() => validateFixture('nope')).toThrow(/expected a JSON object/);
  });
});

describe('FakeHarness port', () => {
  it('resolves agents, routes followups, streams and disposes', async () => {
    const harness = new FakeHarness();

    const { id } = await harness.resolveAgent('session-1');
    await harness.followup(id, { text: 'hello' });

    const ref = harness.agent('session-1');
    expect(ref?.id).toBe(id);
    expect(ref?.followupCount).toBe(1);
    expect(ref?.lastInput).toEqual({ text: 'hello' });

    const seen: unknown[] = [];
    const unsubscribe = harness.streamEvents('session-1', (event) => seen.push(event));
    harness.emitSessionEvent('session-1', { type: 'agent.reply', text: 'ok' });
    expect(seen).toHaveLength(1);
    unsubscribe();
    harness.emitSessionEvent('session-1', { type: 'agent.reply', text: 'late' });
    expect(seen).toHaveLength(1);

    const { dispose } = await harness.resolveAgent('session-1');
    await dispose();
    expect(ref?.disposed).toBe(true);
  });

  it('passes the minimal port compat checks', () => {
    const harness = new FakeHarness();
    runHarnessCompatChecks(harness, {
      emitEvent: (sessionId, event) => harness.emitSessionEvent(sessionId, event),
    });
  });
});

describe('fake channel e2e', () => {
  it('assembles adapter + service + harness and reaches events end to end', async () => {
    const e2e = await runFakeChannelE2E({ channel: 'weixin', accountId: 'main' });

    const received = await e2e.sendInbound('hello harness');

    expect(received.type).toBe('message.received');
    expect((received.message.content[0] as { text?: string } | undefined)?.text).toBe('hello harness');
    expect(e2e.adapter.received[0]).toBe(received);
    expect(e2e.sessionIds).toEqual(['weixin:main:user-1']);
    expect(e2e.receivedByAgent).toHaveLength(1);
    expect(e2e.harness.agents).toHaveLength(1);
    expect(e2e.harness.agents[0]?.followupCount).toBe(1);
    expect(e2e.replayedEvents).toHaveLength(1);
    expect(e2e.sentReplies).toHaveLength(1);
    expect(e2e.sentReplies[0]?.message.text).toContain('agent.reply');
    expect(e2e.adapter.sentMessages).toHaveLength(1);

    await e2e.dispose();
    expect(e2e.adapter.stopCount).toBe(1);
  });

  it('keeps the pipeline usable across multiple inbound messages', async () => {
    const e2e = await runFakeChannelE2E({ channel: 'qq', accountId: 'bot01' });

    await e2e.sendInbound('first');
    await e2e.sendInbound('second');

    expect(e2e.receivedByAgent).toHaveLength(2);
    expect(e2e.sessionIds).toEqual(['qq:bot01:user-1', 'qq:bot01:user-1']);
    expect(e2e.replayedEvents).toHaveLength(2);
    expect(e2e.adapter.sentMessages).toHaveLength(2);

    await e2e.dispose();
  });

  it('works end to end with a streaming edit adapter', async () => {
    const adapter = new FakeChannelAdapter({ id: 'edit-fake', streaming: 'edit' });
    const e2e = await runFakeChannelE2E({ channel: 'edit-fake', adapter });

    await e2e.sendInbound('hello harness');

    expect(e2e.receivedByAgent).toHaveLength(1);
    expect(e2e.replayedEvents).toHaveLength(1);
    // The E2E stream port delivers replayed events through adapter.send
    // directly (createReply is not exercised by the fake-harness port), which
    // must keep recording outbound messages unchanged.
    expect(e2e.adapter.sentMessages).toHaveLength(1);

    await e2e.dispose();
    expect(e2e.adapter.stopCount).toBe(1);
  });
});

describe('error mapping helpers', () => {
  it('assertChannelError narrows matching channel errors', () => {
    expect(() => assertChannelError(new Error('boom'), 'CHANNEL_SEND_FAILED')).toThrow();
  });
});
