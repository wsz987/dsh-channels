import { describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import {
  freezeMessage,
  type GenerateOptions,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm';
import type { AgentManager } from '../src/agent-manager.ts';
import type { ImageCompatibilityMode } from '../src/config.ts';
import {
  ChannelImageUnsupportedError,
  degradeMessageImages,
  installImageModelFallback,
  UNSUPPORTED_IMAGE_PLACEHOLDER,
} from '../src/image-model-fallback.ts';

type StreamListener = (
  options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>,
) => AsyncIterable<StreamChunk>;

function imageRequest(sessionId = 'channel-session'): GenerateOptions {
  return {
    provider: 'test-provider',
    model: 'test-model',
    sessionId: sessionId as never,
    messages: [freezeMessage({
      id: 'message-request' as never,
      role: 'user' as const,
      source: { kind: 'user' as const },
      content: [
        { type: 'text' as const, text: 'before' },
        { type: 'image' as const, attachment: { attachmentId: 'att-request' } as never },
        { type: 'text' as const, text: 'after' },
      ],
    })],
  };
}

async function consume(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) {
    // The assertions inspect the request that reached the provider boundary.
  }
}

function fallbackHarness(
  inputModalities: readonly string[] | undefined,
  lookupError?: Error,
  mode: ImageCompatibilityMode = 'degrade',
) {
  let listener: StreamListener | undefined;
  const providerRequests: GenerateOptions[] = [];
  const resolveModelInfo = vi.fn(async () => {
    if (lookupError) throw lookupError;
    return { inputModalities };
  });
  const terminal = (options: GenerateOptions): AsyncIterable<StreamChunk> => {
    providerRequests.push(options);
    return (async function* () {})();
  };
  const llm = {
    resolveModelInfo,
    stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (!listener) throw new Error('llm/stream listener was not installed');
      return listener(options, () => terminal(options));
    },
  };
  const ctx = {
    llm,
    on(event: string, callback: StreamListener) {
      expect(event).toBe('llm/stream');
      listener = callback;
      return () => { listener = undefined; };
    },
  } as unknown as Context;
  const agentManager = {
    bindingFor: (sessionId: string) => sessionId === 'channel-session' ? {} : undefined,
  } as AgentManager;
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const dispose = installImageModelFallback(ctx, agentManager, logger, mode);
  return { llm, providerRequests, resolveModelInfo, logger, dispose };
}

describe('image model fallback', () => {
  it('replaces images in place while preserving message identity and text order', () => {
    const original = freezeMessage({
      id: 'message-1' as never,
      role: 'user' as const,
      source: { kind: 'user' as const },
      content: [
        { type: 'text' as const, text: 'before' },
        { type: 'image' as const, attachment: { attachmentId: 'att-1' } as never },
        { type: 'text' as const, text: 'after' },
      ],
    }) as Message;

    const degraded = degradeMessageImages(original);

    expect(degraded.id).toBe(original.id);
    expect(degraded.content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: UNSUPPORTED_IMAGE_PLACEHOLDER },
      { type: 'text', text: 'after' },
    ]);
    expect(original.content[1]?.type).toBe('image');
  });

  it('returns messages without images unchanged', () => {
    const original = freezeMessage({
      id: 'message-2' as never,
      role: 'user' as const,
      source: { kind: 'user' as const },
      content: [{ type: 'text' as const, text: 'text only' }],
    }) as Message;

    expect(degradeMessageImages(original)).toBe(original);
  });

  it('degrades a channel request once at the provider boundary', async () => {
    const harness = fallbackHarness(['text']);
    const original = imageRequest();

    await consume(harness.llm.stream(original));

    expect(harness.resolveModelInfo).toHaveBeenCalledTimes(1);
    expect(harness.providerRequests).toHaveLength(1);
    expect(harness.providerRequests[0]).not.toBe(original);
    expect(harness.providerRequests[0]!.messages[0]!.content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: UNSUPPORTED_IMAGE_PLACEHOLDER },
      { type: 'text', text: 'after' },
    ]);
    expect(original.messages[0]!.content[1]!.type).toBe('image');
  });

  it.each([
    ['image-capable model', ['text', 'image'] as const, undefined],
    ['unknown capabilities', undefined, undefined],
    ['failed lookup', undefined, new Error('metadata unavailable')],
  ] as const)('passes the original request for %s', async (_case, modalities, error) => {
    const harness = fallbackHarness(modalities, error);
    const original = imageRequest();

    await consume(harness.llm.stream(original));

    expect(harness.providerRequests).toEqual([original]);
    if (error) expect(harness.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does not affect image requests outside channel-bound sessions', async () => {
    const harness = fallbackHarness(['text']);
    const original = imageRequest('web-session');

    await consume(harness.llm.stream(original));

    expect(harness.resolveModelInfo).not.toHaveBeenCalled();
    expect(harness.providerRequests).toEqual([original]);
  });
});

describe('image compatibility policy (degrade | reject)', () => {
  it('defaults to degrade: a text-only model gets the placeholder, never an error', async () => {
    const harness = fallbackHarness(['text']);
    const original = imageRequest();

    await consume(harness.llm.stream(original));

    expect(harness.providerRequests).toHaveLength(1);
    expect(harness.providerRequests[0]!.messages[0]!.content[1]).toEqual({
      type: 'text',
      text: UNSUPPORTED_IMAGE_PLACEHOLDER,
    });
  });

  it('reject: a text-only model gets a ChannelImageUnsupportedError and the request is never sent', async () => {
    const harness = fallbackHarness(['text'], undefined, 'reject');
    const original = imageRequest();

    await expect(consume(harness.llm.stream(original))).rejects.toThrow(
      ChannelImageUnsupportedError,
    );

    expect(harness.providerRequests).toHaveLength(0);
    expect(original.messages[0]!.content[1]!.type).toBe('image');
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('rejected image request'),
      expect.objectContaining({ provider: 'test-provider', model: 'test-model' }),
    );
  });

  it('reject: image-capable models and non-channel sessions still pass through untouched', async () => {
    const harness = fallbackHarness(['text', 'image'], undefined, 'reject');
    const original = imageRequest();
    await consume(harness.llm.stream(original));
    expect(harness.providerRequests).toEqual([original]);

    const harnessOutside = fallbackHarness(['text'], undefined, 'reject');
    const web = imageRequest('web-session');
    await consume(harnessOutside.llm.stream(web));
    expect(harnessOutside.resolveModelInfo).not.toHaveBeenCalled();
    expect(harnessOutside.providerRequests).toEqual([web]);
  });

  it('reject: unknown capabilities and failed lookups still fail open', async () => {
    const unknown = fallbackHarness(undefined, undefined, 'reject');
    const req = imageRequest();
    await consume(unknown.llm.stream(req));
    expect(unknown.providerRequests).toEqual([req]);

    const failed = fallbackHarness(undefined, new Error('metadata unavailable'), 'reject');
    const req2 = imageRequest();
    await consume(failed.llm.stream(req2));
    expect(failed.providerRequests).toEqual([req2]);
    expect(failed.logger.warn).toHaveBeenCalledTimes(1);
  });
});
