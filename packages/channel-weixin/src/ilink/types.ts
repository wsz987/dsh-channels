/**
 * Classification: C — duplicate protocol wire types [@deprecated upstream-gap].
 *
 * iLink message / media / QR wire shapes self-maintained. The official
 * @tencent-weixin/openclaw-weixin has equivalent internal enums and types, but
 * its package is OpenClaw-coupled. These are therefore DSH-side structural
 * mirrors used by the mapper and send paths, kept as an explicit upstream-gap
 * until Tencent exports a host-neutral API.
 */
/**
 * Tencent Weixin iLink wire types.
 *
 * Ported from the upstream Tencent/openclaw-weixin proto mirror. Bytes fields
 * (context buffer, media AES keys) are base64 strings in JSON.
 */
import type { ChannelId } from '@wsz987/channel-core';

/** Common request metadata attached to every iLink CGI request. */
export interface ILinkBaseInfo {
  channel_version?: string;
  /** Self-declared identity of the bot/app, UA-style `Name/Version`. */
  bot_agent?: string;
}

/** Enum values for `message_type`. */
export const MESSAGE_TYPE_USER = 1;
export const MESSAGE_TYPE_BOT = 2;

/** Enum values for `message_state`. */
export const MESSAGE_STATE_NEW = 0;
export const MESSAGE_STATE_GENERATING = 1;
export const MESSAGE_STATE_FINISH = 2;

/** Enum values for `item_list[*].type`. */
export const MESSAGE_ITEM_TYPE_NONE = 0;
export const MESSAGE_ITEM_TYPE_TEXT = 1;
export const MESSAGE_ITEM_TYPE_IMAGE = 2;
export const MESSAGE_ITEM_TYPE_VOICE = 3;
export const MESSAGE_ITEM_TYPE_FILE = 4;
export const MESSAGE_ITEM_TYPE_VIDEO = 5;

/** CDN media reference; Tencent outbound uses base64 of the ASCII hex AES key. */
export interface ILinkCDNMedia {
  /** Encrypted download query parameter for the CDN URL. */
  encrypt_query_param?: string;
  /** Base64 key payload (32-char ASCII hex for Tencent 2.4.6 outbound). */
  aes_key?: string;
  /** 0 = only file id encrypted, 1 = thumbnail/mid image info packaged. */
  encrypt_type?: number;
  /** Full download URL (server-returned). */
  full_url?: string;
}

export interface ILinkTextItem {
  text?: string;
}

export interface ILinkImageItem {
  media?: ILinkCDNMedia;
  thumb_media?: ILinkCDNMedia;
  /** Raw AES-128 key as hex string (16 bytes); preferred for inbound decryption. */
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
}

export interface ILinkVoiceItem {
  media?: ILinkCDNMedia;
  /** 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex. */
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  /** Voice length in ms. */
  playtime?: number;
  /** Voice transcription text. */
  text?: string;
}

export interface ILinkFileItem {
  media?: ILinkCDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

export interface ILinkVideoItem {
  media?: ILinkCDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: ILinkCDNMedia;
  thumb_size?: number;
}

export interface ILinkRefMessage {
  message_item?: ILinkMessageItem;
  title?: string;
}

/** One item inside `item_list`. */
export interface ILinkMessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: ILinkRefMessage;
  text_item?: ILinkTextItem;
  image_item?: ILinkImageItem;
  voice_item?: ILinkVoiceItem;
  file_item?: ILinkFileItem;
  video_item?: ILinkVideoItem;
  tool_call_start_item?: { tool_name?: string; tool_call_id?: string };
  tool_call_result_item?: { tool_name?: string; tool_call_id?: string; status?: string };
}

/** Unified inbound message delivered by `getUpdates`. */
export interface ILinkMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: ILinkMessageItem[];
  context_token?: string;
  run_id?: string;
}

/** `getUpdates` request body. */
export interface ILinkGetUpdatesRequest {
  /** Full context buffer cached locally; send `''` when none. */
  get_updates_buf?: string;
  base_info: ILinkBaseInfo;
}

/** `getUpdates` response. */
export interface ILinkGetUpdatesResponse {
  ret?: number;
  /** Server error code (e.g. -14 = session stale token). */
  errcode?: number;
  errmsg?: string;
  msgs?: ILinkMessage[];
  /** Full context buffer to cache locally and send on the next request. */
  get_updates_buf?: string;
  /** Server-suggested timeout (ms) for the next getUpdates long-poll. */
  longpolling_timeout_ms?: number;
}

/** `sendmessage` request wrapping a single message. */
export interface ILinkSendMessageRequest {
  msg?: ILinkMessage;
  base_info?: ILinkBaseInfo;
}

export interface ILinkSendMessageResponse {
  ret?: number;
  errmsg?: string;
}

/** `getconfig` request+response. */
export interface ILinkGetConfigRequest {
  ilink_user_id?: string;
  context_token?: string;
  base_info?: ILinkBaseInfo;
}

export interface ILinkGetConfigResponse {
  ret?: number;
  errmsg?: string;
  /** Base64-encoded typing ticket for `sendtyping`. */
  typing_ticket?: string;
}

/**
 * Typing status sent to `sendtyping`:
 * 1 = typing (default), 2 = cancel typing.
 */
export const TYPING_STATUS_TYPING = 1;
export const TYPING_STATUS_CANCEL = 2;

export interface ILinkSendTypingRequest {
  ilink_user_id?: string;
  typing_ticket?: string;
  status?: number;
  base_info?: ILinkBaseInfo;
}

export interface ILinkSendTypingResponse {
  ret?: number;
  errmsg?: string;
}

/** `get_bot_qrcode` response. */
export interface ILinkQrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

/** QR login status state machine (full upstream fidelity kept). */
export type ILinkQrStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'scaned_but_redirect'
  | 'binded_redirect';

/** `get_qrcode_status` response. */
export interface ILinkQrStatusResponse {
  status?: ILinkQrStatus;
  /** Bot token issued on `confirmed`. NEVER logged. */
  bot_token?: string;
  /** Remote bot identity issued on `confirmed`. */
  ilink_bot_id?: string;
  /** Effective API base URL on `confirmed`. */
  baseurl?: string;
  /** Weixin user id of the person who scanned. */
  ilink_user_id?: string;
  /** New host to redirect polling to on `scaned_but_redirect`. */
  redirect_host?: string;
}

/** `getuploadurl` request/response (WX5 media scaffold). */
export interface ILinkGetUploadUrlRequest {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  rawsize?: number;
  rawfilemd5?: string;
  filesize?: number;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  no_need_thumb?: boolean;
  aeskey?: string;
  base_info?: ILinkBaseInfo;
}

export interface ILinkGetUploadUrlResponse {
  upload_param?: string;
  thumb_upload_param?: string;
  upload_full_url?: string;
}

/** Notify lifecycle responses. */
export interface ILinkNotifyResponse {
  ret?: number;
  errmsg?: string;
}

/** Inbound metadata attached when mapping an iLink message. */
export interface WeixinInboundMeta {
  channel: ChannelId;
  accountId: string;
}
