/**
 * Streaming reply tests (fully offline): monotonic full-text replace semantics
 * over the Tencent StreamSession.
 */
import { describe, expect, it } from 'vitest';
import { FakeStreamSession } from '../src/sdk-client.ts';
import { QQStreamingReply } from '../src/streaming-reply.ts';

describe('QQStreamingReply', () => {
  it('accumulates delta-by-delta with monotonic full-text updates', async () => {
    const stream = new FakeStreamSession();
    const reply = new QQStreamingReply(stream);

    for (const delta of ['你', '好', '，', '世', '界']) {
      await reply.append(delta);
    }

    expect(stream.updates).toEqual(['你', '你好', '你好，', '你好，世', '你好，世界']);
  });

  it('replace swaps the whole text and forwards the full text', async () => {
    const stream = new FakeStreamSession();
    const reply = new QQStreamingReply(stream);

    await reply.append('draft ');
    await reply.replace({ text: 'rewritten' });
    await reply.append('!');

    expect(stream.updates).toEqual(['draft ', 'rewritten', 'rewritten!']);
  });

  it('finish updates once with a final text when it differs, then completes', async () => {
    const stream = new FakeStreamSession();
    const reply = new QQStreamingReply(stream);

    await reply.append('partial');
    await reply.finish({ text: 'final text' });

    expect(stream.updates).toEqual(['partial', 'final text']);
    expect(stream.completed).toBe(true);
  });

  it('finish completes without a redundant update when text is unchanged', async () => {
    const stream = new FakeStreamSession();
    const reply = new QQStreamingReply(stream);

    await reply.append('done');
    await reply.finish({ text: 'done' });

    expect(stream.updates).toEqual(['done']);
    expect(stream.completed).toBe(true);
  });

  it('finish with no message just completes', async () => {
    const stream = new FakeStreamSession();
    const reply = new QQStreamingReply(stream);

    await reply.append('done');
    await reply.finish();

    expect(stream.updates).toEqual(['done']);
    expect(stream.completed).toBe(true);
  });

  it('fail cancels without error', async () => {
    const stream = new FakeStreamSession();
    const reply = new QQStreamingReply(stream);

    await reply.fail();

    expect(stream.cancelled).toBe(true);
    expect(stream.completed).toBe(false);
  });
});
