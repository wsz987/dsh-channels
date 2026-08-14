/**
 * WX5 media scaffold — send a media sendmessage. Typed stub; throws while the
 * CDN spec is not pinned.
 */
import { wx5NotImplemented } from './decrypt.js';

export interface SendMediaOptions {
  to: string;
  /** CDN reference to embed. */
  media: {
    encrypt_query_param?: string;
    aes_key?: string;
    full_url?: string;
  };
  contextToken?: string;
  runId?: string;
}

/** Send a media message. */
export async function sendMedia(_to: string, _opts: SendMediaOptions): Promise<{ messageId: string }> {
  return wx5NotImplemented('sendMedia');
}
