/**
 * Channel capability negotiation.
 *
 * Core and the Harness bridge must negotiate against `adapter.capabilities`
 * instead of branching on `channel === '...'`.
 */

export type StreamingMode = 'native' | 'edit' | 'buffered';

export interface ChannelCapabilities {
  text: boolean;
  image: boolean;
  file: boolean;
  audio: boolean;
  video: boolean;

  markdown: boolean;
  cards: boolean;
  reactions: boolean;
  threads: boolean;

  /**
   * How incremental assistant output is delivered:
   * - `native`   — the platform streams chunks natively (e.g. DingTalk AI Card)
   * - `edit`     — an existing message/card can be updated in place
   * - `buffered` — accumulate chunks and send once (e.g. Weixin)
   */
  streaming: StreamingMode;

  maxTextLength?: number;
  maxFileSize?: number;
}
