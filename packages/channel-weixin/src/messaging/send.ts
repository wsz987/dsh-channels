/**
 * Classification: C — duplicate send payload + orchestration [@deprecated upstream-gap].
 *
 * Outbound text/image send payload building + CDN upload routing. The official
 * messaging/send.js (sendMessageWeixin / sendImageMessageWeixin) is OpenClaw
 * coupled (imports api/api + util/logger). The text payload builders here
 * mirror the official shapes; kept behind the facade as an upstream-gap. The
 * local type/shape enums mirror the Tencent source reference.
 */
/**
 * OutboundSender — builds the real iLink sendmessage payload and calls the
 * client. The ReplyRouter never generates Weixin protocol fields; they live
 * here.
 *
 * Text is the default path. When the outbound message carries an image part
 * with local bytes (or a data URI), the sender uploads it to the CDN
 * (uploadMedia) and sends an image sendmessage (sendMedia) through the same
 * target + context token + run id, so a media turn correlates identically to a
 * text turn.
 */
import { randomUUID } from 'node:crypto';
import type {
  ChannelTarget,
  OutboundMessage,
  SendResult,
  ImagePart,
  FilePart,
  VideoPart,
} from '@wsz987/channel-core';
import { collectText } from '@wsz987/channel-core';
import { ChannelError } from '@wsz987/channel-core';
import type { ILinkClient } from '../ilink/client.js';
import type { ContextTokenStore } from '../storage/context-token.js';
import {
  MESSAGE_ITEM_TYPE_TEXT,
  MESSAGE_STATE_FINISH,
  MESSAGE_TYPE_BOT,
} from '../ilink/types.js';
import { redactMessage } from '../ilink/errors.js';
import { uploadMedia } from '../media/upload.js';
import { WX5_MEDIA_TYPE_FILE, WX5_MEDIA_TYPE_IMAGE, WX5_MEDIA_TYPE_VIDEO } from '../media/upload.js';
import { sendMedia } from '../media/send-media.js';

export interface OutboundSenderOptions {
  client: ILinkClient;
  contextTokens: ContextTokenStore;
  /** Optional default run id scope; defaults to a fresh UUID per send. */
  runId?: string;
  /** CDN base URL for outbound image upload. */
  cdnBaseUrl?: string;
  /** API base URL for the getuploadurl CGI. */
  apiBaseUrl?: string;
  /** Injectable getuploadurl resolver (tests). */
  getUploadUrl?: (request: Record<string, unknown>) => Promise<{ upload_full_url?: string; upload_param?: string; thumb_upload_param?: string }>;
  /** Injectable raw upload POST (tests). */
  upload?: (url: string, form: FormData) => Promise<Response>;
}

export interface SendTextParams {
  to: string;
  text: string;
  contextToken?: string;
  /** Per-send correlation; defaults to a fresh UUID. */
  runId?: string;
}

/**
 * Build one iLink sendmessage payload for a text message.
 */
export function buildSendTextPayload(params: SendTextParams): Record<string, unknown> {
  return {
    msg: {
      from_user_id: '',
      to_user_id: params.to,
      client_id: randomUUID(),
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      item_list: params.text
        ? [{ type: MESSAGE_ITEM_TYPE_TEXT, text_item: { text: params.text } }]
        : [],
      context_token: params.contextToken ?? undefined,
      run_id: params.runId ?? undefined,
    },
  };
}

export class OutboundSender {
  private readonly client: ILinkClient;
  private readonly contextTokens: ContextTokenStore;
  private readonly defaultRunId: string | undefined;
  private readonly cdnBaseUrl?: string;
  private readonly apiBaseUrl?: string;
  private readonly getUploadUrl?: OutboundSenderOptions['getUploadUrl'];
  private readonly uploadFn?: OutboundSenderOptions['upload'];

  constructor(options: OutboundSenderOptions) {
    this.client = options.client;
    this.contextTokens = options.contextTokens;
    this.defaultRunId = options.runId;
    this.cdnBaseUrl = options.cdnBaseUrl;
    this.apiBaseUrl = options.apiBaseUrl;
    this.getUploadUrl = options.getUploadUrl;
    this.uploadFn = options.upload;
  }

  /**
   * Send an outbound Channel message to a target. Reads the context token for
   * the target peer, then dispatches text (default) or an image upload+send
   * when the message carries image bytes. Failures become ChannelError (token
   * redacted).
   */
  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    const to = target.conversationId;
    const runId = target.runId ?? this.defaultRunId ?? randomUUID();
    const contextToken = await this.contextTokens.get(to);

    const media = outboundMediaParts(message.parts);
    const text = message.text ?? collectText(message.parts ?? []);
    try {
      // Validate the complete request before sending a caption, otherwise a
      // rejected media part would leave a misleading partial delivery.
      if (hasUnsupportedMediaPart(message.parts)) {
        throw new ChannelError('CHANNEL_UNSUPPORTED', 'weixin outbound media requires local bytes; voice is not supported');
      }
      // Tencent 2.4.6 sends an optional caption as its own TEXT request before
      // the media request; each item_list contains exactly one item.
      let messageId: string | undefined;
      if (media.length > 0 && text) {
        const caption = buildSendTextPayload({ to, text, contextToken, runId });
        await this.client.sendMessage(caption);
        messageId = (caption.msg as { client_id: string }).client_id;
      }
      for (const part of media) {
        messageId = part.type === 'image'
          ? await this.sendImage(to, part, contextToken, runId)
          : part.type === 'file'
            ? await this.sendFile(to, part, contextToken, runId)
            : await this.sendVideo(to, part, contextToken, runId);
      }
      if (media.length > 0) {
        return { delivered: true, ...(messageId ? { messageId } : {}) };
      }

      // Voice has no established Tencent 2.4.6 outbound path. File/video need
      // local bytes for the encrypted CDN upload, so reject URL-only parts.
      const payload = buildSendTextPayload({ to, text, contextToken, runId });
      await this.client.sendMessage(payload);
      return { delivered: true, messageId: (payload.msg as { client_id: string }).client_id };
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      throw new ChannelError('CHANNEL_SEND_FAILED', redactMessage(messageText), { cause: error });
    }
  }

  private async sendImage(
    to: string,
    image: UploadableImagePart,
    contextToken: string | undefined,
    runId: string,
  ): Promise<string> {
    return this.uploadAndSend(to, image, contextToken, runId, 'image');
  }

  private async sendFile(
    to: string,
    file: UploadableFilePart,
    contextToken: string | undefined,
    runId: string,
  ): Promise<string> {
    return this.uploadAndSend(to, file, contextToken, runId, 'file');
  }

  private async sendVideo(
    to: string,
    video: UploadableVideoPart,
    contextToken: string | undefined,
    runId: string,
  ): Promise<string> {
    return this.uploadAndSend(to, video, contextToken, runId, 'video');
  }

  private async uploadAndSend(
    to: string,
    part: WeixinOutboundMediaPart,
    contextToken: string | undefined,
    runId: string,
    kind: 'image' | 'file' | 'video',
  ): Promise<string> {
    if (!this.client.cdnUrl && !this.cdnBaseUrl) {
      throw new ChannelError('CHANNEL_UNSUPPORTED', 'outbound media upload requires a CDN base URL');
    }
    const cdnBaseUrl = this.cdnBaseUrl ?? this.client.cdnUrl;
    const apiBaseUrl = this.apiBaseUrl ?? this.client.baseUrl;
    const mediaType = kind === 'image'
      ? WX5_MEDIA_TYPE_IMAGE
      : kind === 'file'
        ? WX5_MEDIA_TYPE_FILE
        : WX5_MEDIA_TYPE_VIDEO;
    const uploaded = await uploadMedia(Buffer.from(part.localData), {
      cdnBaseUrl,
      apiBaseUrl,
      toUserId: to,
      token: this.client.token,
      mediaType,
      getUploadUrl: this.getUploadUrl ?? ((request) => this.client.getUploadUrl(request)),
      upload: this.uploadFn,
    });
    // Tencent 2.4.6 base64-encodes the 32-character ASCII hex key, not the
    // decoded 16 raw key bytes.
    const sent = await sendMedia(this.client, {
      to,
      kind,
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: uploaded.aeskey ? Buffer.from(uploaded.aeskey, 'ascii').toString('base64') : undefined,
      },
      fileSize: uploaded.fileSize,
      fileSizeCiphertext: uploaded.fileSizeCiphertext,
      fileName: kind === 'file' ? part.name : undefined,
      contextToken,
      runId,
    });
    return sent.messageId;
  }
}

type UploadableImagePart = ImagePart & { localData: Uint8Array };
type UploadableFilePart = FilePart & { localData: Uint8Array };
type UploadableVideoPart = VideoPart & { localData: Uint8Array };
type WeixinOutboundMediaPart = UploadableImagePart | UploadableFilePart | UploadableVideoPart;

function outboundMediaParts(parts: OutboundMessage['parts']): WeixinOutboundMediaPart[] {
  if (!parts) return [];
  return parts.filter((part): part is WeixinOutboundMediaPart =>
    (part.type === 'image' || part.type === 'file' || part.type === 'video') &&
    part.localData !== undefined &&
    part.localData.byteLength > 0,
  );
}

/** True when the message carries an unsupported or non-uploadable media part. */
function hasUnsupportedMediaPart(parts: OutboundMessage['parts']): boolean {
  if (!parts) return false;
  return parts.some((p) =>
    p.type === 'audio' ||
    ((p.type === 'image' || p.type === 'file' || p.type === 'video') && (!p.localData || p.localData.byteLength === 0)),
  );
}
