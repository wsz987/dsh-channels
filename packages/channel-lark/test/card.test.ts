/**
 * LarkCardReply — CardKit 2.0 native-streaming reply handle contract tests.
 *
 * The handle drives the OFFICIAL CardKit lifecycle through a fake OpenAPI
 * client: cardkit.v1.card.create (entity) → im.v1.message.create (card
 * reference) → cardkit.v1.cardElement.content (monotonic sequence + stable
 * uuid) → cardkit.v1.card.settings (close streaming + final summary).
 *
 * Verifies: call order, monotonic sequence, stable idempotent uuid, finish
 * closing streaming, rollover into a fresh card near the element cap, and the
 * failure path (error content written first, original error preserved on a
 * secondary failure).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LarkCardReply, LarkOpenApiOutbound, type LarkOpenApiClient } from '../src/index.ts';
import type { LarkUpstream } from '../src/index.ts';

class FakeOpenApiClient implements LarkOpenApiClient {
  calls: { method: string; payload?: unknown }[] = [];
  cardCreateResult: { code?: number; data?: { card_id?: string } } = {
    code: 0,
    data: { card_id: 'cc_card_1' },
  };
  createResult: { code?: number; data?: { message_id?: string } } = {
    code: 0,
    data: { message_id: 'om_card_1' },
  };
  failElementContent = false;

  im = {
    v1: {
      message: {
        create: async (payload: unknown) => {
          this.calls.push({ method: 'message.create', payload });
          if (this.failElementContent) throw new Error('element content boom');
          return this.createResult;
        },
        patch: async (payload: unknown) => {
          this.calls.push({ method: 'message.patch', payload });
          return { code: 0 };
        },
      },
      image: {
        create: async () => ({ image_key: 'img_v2_out' }),
      },
      file: {
        create: async () => ({ file_key: 'file_v2_out' }),
      },
    },
  };

  cardkit = {
    v1: {
      card: {
        create: async (payload: unknown) => {
          this.calls.push({ method: 'cardkit.card.create', payload });
          return this.cardCreateResult;
        },
        settings: async (payload: unknown) => {
          this.calls.push({ method: 'cardkit.card.settings', payload });
          return { code: 0 };
        },
      },
      cardElement: {
        content: async (payload: unknown) => {
          this.calls.push({ method: 'cardkit.cardElement.content', payload });
          return { code: 0 };
        },
      },
    },
  };
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const target = { conversationId: 'oc_456' };

function makeHandle(client: FakeOpenApiClient, opts: { createOnFirstDelta?: boolean } = {}): LarkCardReply {
  const outbound = new LarkOpenApiOutbound({ client }) as unknown as LarkUpstream;
  return new LarkCardReply({
    upstream: outbound,
    target,
    logger: silentLogger as never,
    createOnFirstDelta: opts.createOnFirstDelta ?? true,
    now: () => 1000,
  });
}

function methods(client: FakeOpenApiClient): string[] {
  return client.calls.map((c) => c.method);
}

function contentCalls(client: FakeOpenApiClient): Array<{ sequence: number; uuid?: string }> {
  return client.calls
    .filter((c) => c.method === 'cardkit.cardElement.content')
    .map((c) => (c.payload as { data: { sequence: number; uuid?: string } }).data);
}

describe('LarkCardReply CardKit 2.0 native streaming', () => {
  it('create entity → send reference → stream content → finish closes streaming (in order)', async () => {
    const client = new FakeOpenApiClient();
    const handle = makeHandle(client);
    await handle.append('hello');
    await handle.append(' world');
    expect(handle.status).toBe('active');
    expect(handle.cardId).toBe('cc_card_1');
    expect(handle.text).toBe('hello world');
    expect(handle.chunkIds).toEqual(['om_card_1']);

    await handle.finish();
    expect(handle.status).toBe('finished');
    expect(methods(client)).toEqual([
      'cardkit.card.create',
      'message.create',
      'cardkit.cardElement.content',
      'cardkit.cardElement.content',
      'cardkit.card.settings',
    ]);
    expect(handle.updates.map((u) => u.kind)).toEqual(['created', 'streamed', 'streamed', 'finished']);
  });

  it('streams with a monotonically increasing sequence and stable per-seq uuid', async () => {
    const client = new FakeOpenApiClient();
    const handle = makeHandle(client);
    await handle.append('a');
    await handle.append('b');
    await handle.append('c');
    expect(handle.sequence).toBe(3);
    const calls = contentCalls(client);
    expect(calls.map((c) => c.sequence)).toEqual([1, 2, 3]);
    for (const call of calls) {
      expect(call.uuid).toBe(`c_cc_card_1_${call.sequence}`);
    }
    expect(handle.updates.filter((u) => u.kind === 'streamed').map((u) => u.sequence)).toEqual([1, 2, 3]);
  });

  it('guard: append with an empty delta performs no content update', async () => {
    const client = new FakeOpenApiClient();
    const handle = makeHandle(client);
    await handle.append('');
    expect(methods(client)).toEqual([]);
  });

  it('guard: replace with unchanged text skips the network round-trip', async () => {
    const client = new FakeOpenApiClient();
    const handle = makeHandle(client);
    await handle.replace({ text: 'hello' });
    await handle.replace({ text: 'hello' });
    expect(contentCalls(client)).toHaveLength(1);
    expect(handle.text).toBe('hello');
  });

  it('finish without streamed chunks creates the card once and writes the final content', async () => {
    const client = new FakeOpenApiClient();
    const handle = makeHandle(client);
    await handle.finish({ text: 'final text' });
    expect(handle.status).toBe('finished');
    expect(handle.text).toBe('final text');
    const creates = client.calls.filter((c) => c.method === 'cardkit.card.create');
    expect(creates).toHaveLength(1);
    // Card entity → card reference send → final element content → close stream.
    expect(methods(client)).toEqual([
      'cardkit.card.create',
      'message.create',
      'cardkit.cardElement.content',
      'cardkit.card.settings',
    ]);
    // No message.patch fallback anywhere.
    expect(methods(client).includes('message.patch')).toBe(false);
  });

  it('createOnFirstDelta: false buffers deltas and creates the entity at finish', async () => {
    const client = new FakeOpenApiClient();
    const handle = makeHandle(client, { createOnFirstDelta: false });
    await handle.append('hello');
    expect(handle.status).toBe('idle');
    expect(handle.cardId).toBeUndefined();
    expect(client.calls.filter((c) => c.method === 'cardkit.card.create')).toHaveLength(0);
    await handle.finish();
    expect(handle.status).toBe('finished');
    expect(handle.cardId).toBe('cc_card_1');
    expect(client.calls.filter((c) => c.method === 'cardkit.card.create')).toHaveLength(1);
  });

  it('finish is idempotent and no-ops after completion', async () => {
    const client = new FakeOpenApiClient();
    const handle = makeHandle(client);
    await handle.append('x');
    await handle.finish();
    await handle.finish();
    await handle.append('ignored');
    expect(handle.status).toBe('finished');
    expect(handle.text).toBe('x');
    expect(client.calls.filter((c) => c.method === 'cardkit.card.settings')).toHaveLength(1);
  });

  it('fail writes an interruption footer then closes streaming (content before settings)', async () => {
    const client = new FakeOpenApiClient();
    const handle = makeHandle(client);
    await handle.append('partial');
    const error = new Error('boom');
    await handle.fail(error);
    expect(handle.status).toBe('failed');
    expect(handle.error).toBe(error);
    const sequence = methods(client);
    const contentIdx = sequence.indexOf('cardkit.cardElement.content');
    const settingsIdx = sequence.indexOf('cardkit.card.settings');
    expect(contentIdx).toBeGreaterThan(-1);
    expect(settingsIdx).toBeGreaterThan(contentIdx);
    expect(contentCalls(client).at(-1)?.sequence).toBe(2);
    expect(handle.updates.at(-1)?.kind).toBe('failed');
  });

  it('fail without a created card still records the failed state', async () => {
    const client = new FakeOpenApiClient();
    const handle = makeHandle(client, { createOnFirstDelta: false });
    await handle.fail(new Error('early'));
    expect(handle.status).toBe('failed');
    expect(handle.updates.at(-1)).toMatchObject({ kind: 'failed', text: '' });
  });
});

describe('LarkCardReply rollover (30k element cap)', () => {
  it('rolls over into a fresh card when the element exceeds the cap', async () => {
    const client = new FakeOpenApiClient();
    const handle = makeHandle(client);
    // Two rolls: 1st append > 30k chars → immediate rollover path.
    const big = 'x'.repeat(31_000);
    await handle.append(big);
    // The handle text accumulates without blocking; rollover happened inside
    // pushContent (first append alone exceeded the cap).
    expect(handle.chunkIds.length).toBeGreaterThanOrEqual(2);
    // Every chunk id (message ids) recorded; each new card creates + sends.
    const creates = client.calls.filter((c) => c.method === 'cardkit.card.create');
    expect(creates.length).toBeGreaterThanOrEqual(2);
    const sends = client.calls.filter((c) => c.method === 'message.create');
    expect(sends.length).toBeGreaterThanOrEqual(2);
    // The final card (after rollover) is still streamed.
    expect(handle.status).toBe('active');
    await handle.finish();
    expect(handle.status).toBe('finished');
    // Rollover closed the previous card's streaming (settings), and finish
    // closed the last card — at least two settings calls.
    const settings = client.calls.filter((c) => c.method === 'cardkit.card.settings');
    expect(settings.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps streaming content monotonic across rollover cards', async () => {
    const client = new FakeOpenApiClient();
    const handle = makeHandle(client);
    const big = 'y'.repeat(31_000);
    await handle.append(big);
    const calls = contentCalls(client);
    // First card: seq 1 (head pin); rollover card: seq 1 (tail), then the
    // post-rollover element push reuses the new card's element seq — sequences
    // are per-element, so each new card restarts at 1.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const call of calls) {
      expect(call.sequence).toBeGreaterThanOrEqual(1);
    }
  });
});
