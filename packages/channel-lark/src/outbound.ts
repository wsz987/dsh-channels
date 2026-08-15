/**
 * Outbound sending: channel message → lark text/media/file payload → upstream.
 *
 * Streaming replies go through `LarkCardReply`; this sender is the buffered
 * fallback path (`adapter.send`) used when no card was created. Text messages
 * use `sendText`; a pure image message (no text) uses `sendMedia`; a pure file
 * message carrying `localData` uses `sendFile` (official im.file.create →
 * im.message.create, M7A) so media/file capability is real rather than a placeholder.
 */
import type {
  ChannelLogger,
  ChannelTarget,
  FilePart,
  MessagePart,
  OutboundMessage,
  SendResult,
} from '@wsz987/channel-core';
import { ChannelSendError } from '@wsz987/channel-core';
import { toTextPayload } from './mapper.js';
import type { LarkFileRef, LarkUpstream } from './upstream.js';

export class OutboundSender {
  constructor(
    private readonly upstream: LarkUpstream,
    private readonly logger: ChannelLogger,
  ) {}

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    try {
      const file = firstFileWithData(message.parts);
      if (file && !message.text) {
        const response = await this.upstream.sendFile(target.conversationId, toFileRef(file));
        return { delivered: true, raw: response };
      }
      const image = firstImage(message.parts);
      if (image && !message.text) {
        const response = await this.upstream.sendMedia(target.conversationId, image);
        return { delivered: true, raw: response };
      }
      const payload = toTextPayload(target, message);
      const response = await this.upstream.sendText(payload.to, payload.content);
      return { delivered: true, raw: response };
    } catch (error) {
      this.logger.error(
        '[channel-lark] send failed to ' + target.conversationId,
        error instanceof Error ? error.message : error,
      );
      throw new ChannelSendError(
        'lark send failed: ' + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

/**
 * The first file part that already carries trusted bytes (localData). A file
 * part without bytes is not in a state the official outbound can send yet
 * (no re-download here), so it falls through to the text path.
 */
function firstFileWithData(
  parts: MessagePart[] | undefined,
): (FilePart & { localData: Uint8Array }) | undefined {
  if (!parts) return undefined;
  return parts.find(
    (part): part is FilePart & { localData: Uint8Array } =>
      part.type === 'file' && part.localData !== undefined,
  );
}

/** Shape a hydrated FilePart into the outbound LarkFileRef. */
function toFileRef(file: FilePart & { localData: Uint8Array }): LarkFileRef {
  return {
    type: 'file',
    localData: file.localData,
    name: file.name,
    mimeType: file.mimeType,
  };
}

function firstImage(parts: MessagePart[] | undefined): Extract<MessagePart, { type: 'image' }> | undefined {
  if (!parts) return undefined;
  return parts.find((part): part is Extract<MessagePart, { type: 'image' }> => part.type === 'image');
}