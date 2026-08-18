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
import type { ImageCompatibilityMode } from './config.js';
import { toLoggableError } from './loggable-error.js';

export const UNSUPPORTED_IMAGE_PLACEHOLDER = '[图片：当前模型不支持查看]';

/**
 * Thrown by the `reject` policy (ADR 0002) when a channel-bound Session whose
 * history contains images is about to be sent to a model that explicitly
 * declares no image input. The request is NOT sent — the turn fails and the
 * user must start a new Session (`/new`) or switch to an image-capable model.
 * This mirrors the official Web behavior of refusing a model switch that would
 * orphan existing images (`session.selectModel` -> model-unavailable).
 */
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
 * Keep immutable Session history intact while applying the configured
 * Channel image-compatibility policy at the provider boundary for channel-bound
 * sessions (ADR 0002 — an explicit Channel policy, not host parity):
 *
 * - `degrade` (default): text-only models keep serving the session; each image
 *   block is replaced by `[图片：当前模型不支持查看]` only in the provider-visible
 *   request.
 * - `reject`: the request is refused with a {@link ChannelImageUnsupportedError}.
 *
 * NOTE (ADR 0003): this `llm/stream` rewrite is the LEGACY seam. It rewrites
 * model-visible content that the durable Session log cannot reconstruct
 * (placeholder text never enters the log, and the copied request escapes the
 * official agent-loop reconstruction invariant by object identity). The
 * target implementation is an agent-scoped `agent/pre-step` surface replace
 * (ADR 0003) where the rewritten messages ARE the logged `user/message`
 * events. Keep this listener operational until the migration lands; do not
 * extend it.
 */
export function installImageModelFallback(
  ctx: Context,
  agentManager: AgentManager,
  logger: ChannelLogger,
  mode: ImageCompatibilityMode = 'degrade',
): () => void {
  const active = new WeakSet<GenerateOptions>();
  return ctx.on('llm/stream', function imageModelFallback(options, next) {
    if (!options.sessionId || !agentManager.bindingFor(String(options.sessionId))) return next();
    if (!containsImage(options.messages) || active.has(options)) return next();

    return streamWithFallback(ctx, options, next, active, logger, mode);
  });
}

async function* streamWithFallback(
  ctx: Context,
  options: GenerateOptions,
  next: () => AsyncIterable<StreamChunk>,
  active: WeakSet<GenerateOptions>,
  logger: ChannelLogger,
  mode: ImageCompatibilityMode,
): AsyncIterable<StreamChunk> {
  try {
    const info = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal);
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

  const sessionId = String(options.sessionId);
  if (mode === 'reject') {
    logger.warn('[channel-harness] rejected image request for text-only model', {
      provider: options.provider,
      model: options.model,
      sessionId,
    });
    throw new ChannelImageUnsupportedError({
      provider: options.provider,
      model: options.model,
      sessionId,
    });
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
      sessionId,
    });
    yield* ctx.llm.stream(degraded);
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