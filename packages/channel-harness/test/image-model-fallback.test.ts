import { describe, expect, it, vi } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent';
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope';
import { createUserMessage, freezeMessage, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { ChannelLogger } from '@wsz987/channel-core';
import type { ImageCompatibilityMode } from '../src/config.ts';
import type { ChannelModelSelectionController } from '../src/model-selection.ts';
import {
  ChannelImageUnsupportedError,
  degradeMessageImages,
  installImageCompatibility,
  UNSUPPORTED_IMAGE_PLACEHOLDER,
} from '../src/image-model-fallback.ts';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as ChannelLogger;

function imageMessage(): UserMessage {
  return createUserMessage({
    content: [
      { type: 'text', text: 'before' },
      { type: 'image', attachment: { attachmentId: 'att-1' } as never },
      { type: 'text', text: 'after' },
    ],
    source: { kind: 'user' },
  });
}

function fakeAgent(root: Context): Agent {
  const raw = {
    id: 'channel-session',
    session: { requestHeader: () => undefined },
    options: {},
    ctx: new Context(),
  } as unknown as Agent;
  raw.ctx = createScope(root, raw).ctx;
  return raw;
}

function harness(
  inputModalities: readonly string[] | undefined,
  selection: ModelSelection = { provider: 'test-provider', model: 'test-model' },
  lookupError?: Error,
  mode: ImageCompatibilityMode = 'degrade',
) {
  const root = new Context();
  const resolveModelInfo = vi.fn(async () => {
    if (lookupError) throw lookupError;
    return { inputModalities };
  });
  (root as unknown as { llm: { resolveModelInfo: typeof resolveModelInfo } }).llm = { resolveModelInfo };
  const agent = fakeAgent(root);
  const modelSelection = {
    selectionForStep: vi.fn(async () => selection),
  } as unknown as ChannelModelSelectionController;
  const dispose = installImageCompatibility(agent.ctx, root, modelSelection, logger, mode);
  async function preStep(messages: UserMessage[]): Promise<{ kind: 'enter'; messages: UserMessage[] }> {
    const decision = await agent.ctx.waterfall(
      scopeTarget(agent, agent),
      'agent/pre-step',
      {
        agent,
        messages,
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      () => Promise.resolve({ kind: 'enter' as const, messages }),
    );
    if (decision.kind !== 'enter') throw new Error('unexpected rejected decision');
    return decision;
  }
  return { agent, resolveModelInfo, modelSelection, preStep, dispose };
}

describe('image compatibility at agent/pre-step', () => {
  it('replaces images in place while preserving identity and text order', () => {
    const original = freezeMessage(imageMessage());
    const degraded = degradeMessageImages(original);
    expect(degraded.id).toBe(original.id);
    expect(degraded.content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: UNSUPPORTED_IMAGE_PLACEHOLDER },
      { type: 'text', text: 'after' },
    ]);
    expect(original.content[1]!.type).toBe('image');
  });

  it('degrades the proposed step before it is logged', async () => {
    const h = harness(['text']);
    const original = imageMessage();
    const decision = await h.preStep([original]);
    expect(h.resolveModelInfo).toHaveBeenCalledTimes(1);
    expect(decision.messages[0]).not.toBe(original);
    expect(decision.messages[0]!.content[1]).toEqual({
      type: 'text',
      text: UNSUPPORTED_IMAGE_PLACEHOLDER,
    });
  });

  it.each([
    ['image-capable model', ['text', 'image'] as const, undefined],
    ['unknown capabilities', undefined, undefined],
    ['failed lookup', undefined, new Error('metadata unavailable')],
  ] as const)('passes the proposed step unchanged for %s', async (_name, modalities, error) => {
    const h = harness(modalities, undefined, error);
    const original = imageMessage();
    const decision = await h.preStep([original]);
    expect(decision.messages[0]).toBe(original);
    if (error) expect(logger.warn).toHaveBeenCalled();
  });

  it('does not query model capability for text-only steps', async () => {
    const h = harness(['text']);
    const original = createUserMessage({ content: [{ type: 'text', text: 'text only' }], source: { kind: 'user' } });
    const decision = await h.preStep([original]);
    expect(decision.messages[0]).toBe(original);
    expect(h.resolveModelInfo).not.toHaveBeenCalled();
    expect(h.modelSelection.selectionForStep).not.toHaveBeenCalled();
  });

  it('rejects a text-only model without returning a provider request', async () => {
    const h = harness(['text'], undefined, undefined, 'reject');
    await expect(h.preStep([imageMessage()])).rejects.toBeInstanceOf(ChannelImageUnsupportedError);
  });

  it('preserves nested image order in tool results', () => {
    const original = createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: 'call-1' as never,
        content: [{ type: 'image', attachment: { attachmentId: 'att-1' } as never }],
      }],
      source: { kind: 'user' },
    });
    const degraded = degradeMessageImages(original);
    expect(degraded.content[0]).toMatchObject({
      type: 'tool-result',
      content: [{ type: 'text', text: UNSUPPORTED_IMAGE_PLACEHOLDER }],
    });
  });
});
