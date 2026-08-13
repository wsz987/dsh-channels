/**
 * Inbound conversion: `MessageReceived` -> a Harness `UserMessage`.
 *
 * Content stays structured-text only (red line 6): platform parts are mapped
 * to plain-text blocks — images/files/audio/video become `[type: ...]`
 * placeholders instead of raw platform JSON. Conversation metadata
 * (channel / sender / message id) is folded into a configurable text prefix so
 * the model can still tell where a message came from.
 */
import { createUserMessage, type TextBlock, type UserMessage } from '@deepseek-ai/dsh-llm';
import type { MessagePart, MessageReceived } from '@dsh/channel-core';

/** Type-level alias: the bridge always produces Harness user messages. */
export type UserMessageLike = UserMessage;

export interface MessageConvertOptions {
  /** Whether to prepend the `[channel=.. sender=.. message=..]` prefix. */
  includeMetadataPrefix?: boolean;
}

/** Convert a channel message-received event into a model-facing user message. */
export function toHarnessUserMessage(
  event: MessageReceived,
  options: MessageConvertOptions = {},
): UserMessageLike {
  const blocks: TextBlock[] = [];
  const includePrefix = options.includeMetadataPrefix ?? true;
  if (includePrefix) {
    const prefix = metadataPrefix(event);
    if (prefix) blocks.push({ type: 'text', text: prefix });
  }
  const body = partsToText(event.message.content);
  if (body) blocks.push({ type: 'text', text: body });
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });

  return createUserMessage({
    content: blocks,
    source: { kind: 'plugin', plugin: 'channel-harness' },
  });
}

function metadataPrefix(event: MessageReceived): string {
  return `[channel=${event.channel} sender=${event.sender.id} message=${event.message.id}] `;
}

/** Map structured parts to a single text line. Never embeds raw payloads. */
export function partsToText(parts: readonly MessagePart[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        segments.push(part.text);
        break;
      case 'image':
        segments.push(part.alt ? `[image: ${part.alt}]` : part.url ? `[image: ${part.url}]` : '[image]');
        break;
      case 'file':
        segments.push(part.name ? `[file: ${part.name}]` : part.url ? `[file: ${part.url}]` : '[file]');
        break;
      case 'audio':
        segments.push(
          part.durationMs !== undefined ? `[audio: ${part.durationMs}ms]` : '[audio]',
        );
        break;
      case 'video':
        segments.push(
          part.durationMs !== undefined ? `[video: ${part.durationMs}ms]` : '[video]',
        );
        break;
      case 'location':
        segments.push(`[location: ${part.latitude},${part.longitude}]`);
        break;
      case 'card':
        segments.push(`[card: ${part.kind}]`);
        break;
      case 'unsupported':
        segments.push('[unsupported content]');
        break;
    }
  }
  return segments.join('');
}
