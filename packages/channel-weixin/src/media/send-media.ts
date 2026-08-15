/**
 * Classification: C — duplicate send-media payload [@deprecated upstream-gap].
 *
 * Builds an iLink sendmessage image item + dispatches. The official composed
 * messaging/send.js (sendImageMessageWeixin) is OpenClaw coupled (imports
 * api/api + util/logger). Kept behind the facade as an upstream-gap; send
 * routing now lives in upstream/tencent-upstream.ts sendImage().
 */
/**
 * WX5 media — send a media sendmessage (WX5.1 Image outbound).
 *
 * Embeds a CDN media reference (encrypt_query_param / aes_key) into a real
 * iLink sendmessage item. `sendMedia` builds the full request and `dispatch`
 * performs the send through the client; the split keeps payload construction
 * pure for tests.
 */
import type { ILinkClient } from '../ilink/client.js';
import { MESSAGE_ITEM_TYPE_IMAGE, MESSAGE_STATE_FINISH, MESSAGE_TYPE_BOT } from '../ilink/types.js';
import { randomUUID } from 'node:crypto';

export interface SendMediaOptions {
  to: string;
  media: {
    encrypt_query_param?: string;
    aes_key?: string;
    full_url?: string;
  };
  contextToken?: string;
  runId?: string;
}

/** Build the iLink sendmessage payload for a media (image) item. */
export function buildSendMediaPayload(options: SendMediaOptions): Record<string, unknown> {
  const media: Record<string, unknown> = {};
  if (options.media.encrypt_query_param) media.encrypt_query_param = options.media.encrypt_query_param;
  if (options.media.aes_key) media.aes_key = options.media.aes_key;
  if (options.media.full_url) media.full_url = options.media.full_url;
  return {
    msg: {
      from_user_id: '',
      to_user_id: options.to,
      client_id: randomUUID(),
      message_type: MESSAGE_TYPE_BOT,
      message_state: MESSAGE_STATE_FINISH,
      item_list: [{ type: MESSAGE_ITEM_TYPE_IMAGE, image_item: { media } }],
      context_token: options.contextToken ?? undefined,
      run_id: options.runId ?? undefined,
    },
  };
}

/** Send a media message through the client; returns the client_id. */
export async function sendMedia(client: ILinkClient, options: SendMediaOptions): Promise<{ messageId: string }> {
  const payload = buildSendMediaPayload(options);
  await client.sendMessage(payload);
  return { messageId: (payload.msg as { client_id: string }).client_id };
}