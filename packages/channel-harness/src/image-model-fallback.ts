import type { Context } from '@deepseek-ai/cordis';
import type {
  ContentBlock,
  GenerateOptions,
  Message,
  StreamChunk,
} from '@deepseek-ai/dsh-llm';
import { freezeMessage } from '@deepseek-ai/dsh-llm';
import type { ChannelLogger } from '@wsz987/channel-core';
import type { AgentManager } from './agent-manager.js';
import { toLoggableError } from './loggable-error.js';

export const UNSUPPORTED_IMAGE_PLACEHOLDER = '[图片：当前模型不支持查看]';

interface LlmModelCapabilityService {
  resolveModelInfo(provider: string, model: string): Promise<{
    inputModalities?: readonly string[];
  }>;
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}

/**
 * Keep immutable Session history intact while degrading images only at the
 * provider boundary for text-only models used by channel-bound sessions.
 */
export function installImageModelFallback(
  ctx: Context,
  agentManager: AgentManager,
  logger: ChannelLogger,
): () => void {
  const active = new WeakSet<GenerateOptions>();
  return ctx.on('llm/stream', function imageModelFallback(options, next) {
    if (!options.sessionId || !agentManager.bindingFor(String(options.sessionId))) return next();
    if (!containsImage(options.messages) || active.has(options)) return next();

    return streamWithFallback(ctx, options, next, active, logger);
  });
}

async function* streamWithFallback(
  ctx: Context,
  options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>,
  active: WeakSet<GenerateOptions>,
  logger: ChannelLogger,
): AsyncIterable<StreamChunk> {
  const llm = ctx.llm as unknown as LlmModelCapabilityService;
  try {
    const info = await llm.resolveModelInfo(options.provider, options.model);
    if (info.inputModalities === undefined || info.inputModalities.includes('image')) {
      yield* next();
      return;
    }
  } catch (error) {
    logger.warn('[channel-harness] image model capability lookup failed; continuing', {
      provider: options.provider,
      model: options.model,
      sessionId: String(options.sessionId),
      error: toLoggableError(error),
    });
    yield* next();
    return;
  }

  const degraded: GenerateOptions = {
    ...options,
    messages: options.messages.map(degradeMessageImages),
  };
  active.add(degraded);
  try {
    logger.info('[channel-harness] degraded channel images for text-only model', {
      provider: options.provider,
      model: options.model,
      sessionId: String(options.sessionId),
    });
    yield* llm.stream(degraded);
  } finally {
    active.delete(degraded);
  }
}

function containsImage(messages: readonly Message[]): boolean {
  return messages.some((message) => message.content.some((block) => block.type === 'image'));
}

export function degradeMessageImages(message: Message): Message {
  if (!message.content.some((block) => block.type === 'image')) return message;
  const content: ContentBlock[] = message.content.map((block) =>
    block.type === 'image'
      ? { type: 'text', text: UNSUPPORTED_IMAGE_PLACEHOLDER }
      : block,
  );
  return freezeMessage({ ...message, content });
}
