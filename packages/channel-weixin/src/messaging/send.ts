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
} from '@dsh/channel-core';
import { collectText } from '@dsh/channel-core';
import { ChannelError } from '@dsh/channel-core';
import type { ILinkClient } from '../ilink/client.js';
import type { ContextTokenStore } from '../storage/context-token.js';
import {
  MESSAGE_ITEM_TYPE_TEXT,
  MESSAGE_STATE_FINISH,
  MESSAGE_TYPE_BOT,
} from '../ilink/types.js';
import { redactMessage } from '../ilink/errors.js';
import { uploadMedia } from '../media/upload.js';
import type { UploadedMedia } from '../media/upload.js';
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

    const image = firstImage(message.parts);
    try {
      if (image?.localData && image.localData.byteLength > 0) {
        await this.sendImage(to, image, contextToken, runId);
        return { delivered: true };
      }

      // Voice/file/video outbound remain unimplemented (WX5.2-5.4): refuse an
      // explicit non-text media part instead of silently dropping it.
      if (hasUnsupportedMediaPart(message.parts)) {
        throw new ChannelError('CHANNEL_UNSUPPORTED', 'outbound voice/file/video are not yet supported on weixin');
      }

      const text = message.text ?? collectText(message.parts ?? []);
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
    image: ImagePart,
    contextToken: string | undefined,
    runId: string,
  ): Promise<UploadedMedia> {
    if (!this.client.cdnUrl && !this.cdnBaseUrl) {
      throw new ChannelError('CHANNEL_UNSUPPORTED', 'outbound image upload requires a CDN base URL');
    }
    const cdnBaseUrl = this.cdnBaseUrl ?? this.client.cdnUrl;
    const apiBaseUrl = this.apiBaseUrl ?? this.client.baseUrl;

    const uploaded = await uploadMedia(Buffer.from(image.localData!), {
      cdnBaseUrl,
      apiBaseUrl,
      toUserId: to,
      token: this.client.token,
      getUploadUrl: this.getUploadUrl,
      upload: this.uploadFn,
    });
    // The CDN media reference for the sendmessage item: aes_key is base64 (the
    // JSON transport convention), matching ILinkCDNMedia.aes_key.
    await sendMedia(this.client, {
      to,
      media: {
        encrypt_query_param: uploaded.downloadEncryptedQueryParam,
        aes_key: uploaded.aeskey ? Buffer.from(uploaded.aeskey, 'hex').toString('base64') : undefined,
      },
      contextToken,
      runId,
    });
    return uploaded;
  }
}

/** First image part with downloadable local bytes. */
function firstImage(parts: OutboundMessage['parts']): ImagePart | undefined {
  if (!parts) return undefined;
  return parts.find((p): p is ImagePart => p.type === 'image');
}

/** True when the message carries a non-image, non-text media part (voice/file/video). */
function hasUnsupportedMediaPart(parts: OutboundMessage['parts']): boolean {
  if (!parts) return false;
  return parts.some((p) => p.type === 'audio' || p.type === 'file' || p.type === 'video');
}
