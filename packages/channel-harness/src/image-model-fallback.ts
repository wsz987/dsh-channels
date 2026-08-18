import type { Context } from '@deepseek-ai/cordis';
import type { PreStepDecision } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm';
import { contentHasImage, freezeMessage } from '@deepseek-ai/dsh-llm';
import type { ChannelLogger } from '@wsz987/channel-core';
import type { ImageCompatibilityMode } from './config.js';
import type { ChannelModelSelectionController } from './model-selection.js';
import { toLoggableError } from './loggable-error.js';

export const UNSUPPORTED_IMAGE_PLACEHOLDER = '[图片：当前模型不支持查看]';

/** Thrown when a channel image reaches a model that explicitly rejects images. */
export class ChannelImageUnsupportedError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly sessionId: string;

  constructor(input: { provider: string; model: string; sessionId: string }) {
    super(
      `model '${input.model}' does not accept image input; start a new channel session (/new) or switch to an image-capable model`,
    );
    this.name = 'ChannelImageUnsupportedError';
    this.provider = input.provider;
    this.model = input.model;
    this.sessionId = input.sessionId;
  }
}

/**
 * Install the Channel image policy on one Agent scope. The listener runs at
 * `agent/pre-step`, so degraded messages are the exact values appended to the
 * Session log and subsequently reconstructed for the model request.
 */
export function installImageCompatibility(
  agentCtx: Context,
  rootCtx: Context,
  modelSelection: ChannelModelSelectionController,
  logger: ChannelLogger,
  mode: ImageCompatibilityMode = 'degrade',
): () => void {
  return agentCtx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (decision.kind !== 'enter' || !containsImage(decision.messages)) return decision;

    const selection = await modelSelection.selectionForStep(payload.agent);
    if (!selection) return decision;

    let info: { inputModalities?: readonly string[] };
    try {
      info = await rootCtx.llm.resolveModelInfo(selection.provider, selection.model, payload.signal);
    } catch (error) {
      logger.warn('[channel-harness] image model capability lookup failed; continuing', {
        provider: selection.provider,
        model: selection.model,
        sessionId: String(payload.agent.id),
        error: toLoggableError(error),
      });
      return decision;
    }

    if (info.inputModalities === undefined || info.inputModalities.includes('image')) {
      return decision;
    }

    const sessionId = String(payload.agent.id);
    if (mode === 'reject') {
      logger.warn('[channel-harness] rejected image request for text-only model', {
        provider: selection.provider,
        model: selection.model,
        sessionId,
      });
      throw new ChannelImageUnsupportedError({
        provider: selection.provider,
        model: selection.model,
        sessionId,
      });
    }

    logger.info('[channel-harness] degraded channel images for text-only model', {
      provider: selection.provider,
      model: selection.model,
      sessionId,
    });
    return {
      ...decision,
      messages: decision.messages.map(degradeMessageImages),
    } satisfies PreStepDecision;
  });
}

/** @deprecated Image compatibility is now installed through agent/pre-step. */
export function installImageModelFallback(): () => void {
  return () => {};
}

function containsImage(messages: readonly UserMessage[]): boolean {
  return messages.some((message) => contentHasImage(message.content));
}

export function degradeMessageImages(message: UserMessage): UserMessage {
  if (!contentHasImage(message.content)) return message;
  return freezeMessage({ ...message, content: degradeContent(message.content) });
}

function degradeContent(content: readonly ContentBlock[]): ContentBlock[] {
  return content.map((block): ContentBlock => {
    if (block.type === 'image') return { type: 'text', text: UNSUPPORTED_IMAGE_PLACEHOLDER };
    if (block.type === 'tool-result' && contentHasImage(block.content)) {
      return { ...block, content: degradeContent(block.content) };
    }
    return block;
  });
}
