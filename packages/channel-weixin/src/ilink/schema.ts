/** Runtime schemas for every iLink JSON trust boundary. */
import { z } from 'zod';
import type { ILinkMessageItem } from './types.js';

const responseEnvelopeFields = {
  ret: z.number().int().optional(),
  errcode: z.number().int().optional(),
  errmsg: z.string().optional(),
};

export const responseEnvelopeSchema = z.object(responseEnvelopeFields).passthrough();

export const baseInfoSchema = z.object({
  channel_version: z.string().optional(),
  bot_agent: z.string().optional(),
});

export const cdnMediaSchema = z.object({
  encrypt_query_param: z.string().optional(),
  aes_key: z.string().optional(),
  encrypt_type: z.number().int().optional(),
  full_url: z.string().optional(),
});

export const messageItemSchema: z.ZodType<ILinkMessageItem> = z.lazy(() => z.object({
  type: z.number().int().optional(),
  create_time_ms: z.number().optional(),
  update_time_ms: z.number().optional(),
  is_completed: z.boolean().optional(),
  msg_id: z.string().optional(),
  ref_msg: z.object({
    message_item: messageItemSchema.optional(),
    title: z.string().optional(),
  }).optional(),
  text_item: z.object({ text: z.string().optional() }).optional(),
  image_item: z.object({
    media: cdnMediaSchema.optional(),
    thumb_media: cdnMediaSchema.optional(),
    aeskey: z.string().optional(),
    url: z.string().optional(),
    mid_size: z.number().optional(),
    thumb_size: z.number().optional(),
  }).optional(),
  voice_item: z.object({
    media: cdnMediaSchema.optional(),
    encode_type: z.number().int().optional(),
    bits_per_sample: z.number().optional(),
    sample_rate: z.number().optional(),
    playtime: z.number().optional(),
    text: z.string().optional(),
  }).optional(),
  file_item: z.object({
    media: cdnMediaSchema.optional(),
    file_name: z.string().optional(),
    md5: z.string().optional(),
    len: z.string().optional(),
  }).optional(),
  video_item: z.object({
    media: cdnMediaSchema.optional(),
    video_size: z.number().optional(),
    play_length: z.number().optional(),
    video_md5: z.string().optional(),
    thumb_media: cdnMediaSchema.optional(),
    thumb_size: z.number().optional(),
  }).optional(),
  tool_call_start_item: z.object({
    tool_name: z.string().optional(),
    tool_call_id: z.string().optional(),
  }).optional(),
  tool_call_result_item: z.object({
    tool_name: z.string().optional(),
    tool_call_id: z.string().optional(),
    status: z.string().optional(),
  }).optional(),
}));

export const messageSchema = z.object({
  seq: z.number().optional(),
  message_id: z.number().optional(),
  from_user_id: z.string().optional(),
  to_user_id: z.string().optional(),
  client_id: z.string().optional(),
  create_time_ms: z.number().optional(),
  update_time_ms: z.number().optional(),
  session_id: z.string().optional(),
  group_id: z.string().optional(),
  message_type: z.number().int().optional(),
  message_state: z.number().int().optional(),
  item_list: z.array(messageItemSchema).optional(),
  context_token: z.string().optional(),
  run_id: z.string().optional(),
});

export const getUploadUrlRequestSchema = z.object({
  filekey: z.string().optional(),
  media_type: z.number().int().optional(),
  to_user_id: z.string().optional(),
  rawsize: z.number().int().nonnegative().optional(),
  rawfilemd5: z.string().optional(),
  filesize: z.number().int().nonnegative().optional(),
  thumb_rawsize: z.number().int().nonnegative().optional(),
  thumb_rawfilemd5: z.string().optional(),
  thumb_filesize: z.number().int().nonnegative().optional(),
  no_need_thumb: z.boolean().optional(),
  aeskey: z.string().optional(),
  base_info: baseInfoSchema.optional(),
});

export const sendMessageRequestSchema = z.object({
  msg: messageSchema.optional(),
  base_info: baseInfoSchema.optional(),
});

export const qrCodeResponseSchema = z.object({
  ...responseEnvelopeFields,
  qrcode: z.string(),
  qrcode_img_content: z.string(),
});

export const qrStatusResponseSchema = z.object({
  ...responseEnvelopeFields,
  status: z.enum([
    'wait', 'scaned', 'confirmed', 'expired', 'need_verifycode',
    'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect',
  ]).optional(),
  bot_token: z.string().optional(),
  ilink_bot_id: z.string().optional(),
  baseurl: z.string().optional(),
  ilink_user_id: z.string().optional(),
  redirect_host: z.string().optional(),
});

export const getUpdatesResponseSchema = z.object({
  ...responseEnvelopeFields,
  msgs: z.array(messageSchema).optional(),
  get_updates_buf: z.string().optional(),
  longpolling_timeout_ms: z.number().optional(),
});

export const sendMessageResponseSchema = z.object(responseEnvelopeFields);

export const getUploadUrlResponseSchema = z.object({
  ...responseEnvelopeFields,
  upload_param: z.string().optional(),
  thumb_upload_param: z.string().optional(),
  upload_full_url: z.string().optional(),
});

export const getConfigResponseSchema = z.object({
  ...responseEnvelopeFields,
  typing_ticket: z.string().optional(),
});

export const sendTypingResponseSchema = z.object(responseEnvelopeFields);
export const notifyResponseSchema = z.object(responseEnvelopeFields);
