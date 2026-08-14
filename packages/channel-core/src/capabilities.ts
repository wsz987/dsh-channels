/**
 * Channel capability negotiation.
 *
 * Core and the Harness bridge must negotiate against `adapter.capabilities`
 * instead of branching on `channel === '...'`.
 *
 * ## Two-layer semantics (doc §6)
 *
 * The `text/image/file/audio/video` flags describe the *platform side* of the
 * contract only: whether an ADAPTER can receive and send that kind of media on
 * the messaging platform. They are the channel's inbound/outbound transport
 * capability, NOT a statement that the Harness model already understands the
 * media as a real attachment.
 *
 * Today the Harness projection of an inbound media item is a plain-text
 * placeholder (`[image: …]` / `[audio: …]` / `[file: …]` / `[video: …]`,
 * see `message-converter`). So when `image === true`, that means the adapter
 * can carry images, NOT that a Harness agent has received a real image
 * attachment. A real attachment projection is a later milestone (doc WX5) and
 * must not be inferred from these flags.
 *
 * Capability negotiation for a *reply* uses `streaming` (statically, or
 * target-aware via `adapter.resolveStreamingMode`).
 */

export type StreamingMode = 'native' | 'edit' | 'buffered';

export interface ChannelCapabilities {
  /**
   * Whether the platform can carry plain text both inbound and outbound.
   */
  text: boolean;
  /**
   * Whether the platform/adapter can transport images. Platform transport
   * capability only — does NOT mean Harness has a real image attachment (see
   * two-layer semantics above).
   */
  image: boolean;
  /**
   * Whether the platform/adapter can transport files. Platform transport
   * capability only — not an Harness attachment projection.
   */
  file: boolean;
  /**
   * Whether the platform/adapter can transport audio. Platform transport
   * capability only — not an Harness attachment projection.
   */
  audio: boolean;
  /**
   * Whether the platform/adapter can transport video. Platform transport
   * capability only — not an Harness attachment projection.
   */
  video: boolean;

  /** Whether reply markdown is rendered by the platform. */
  markdown: boolean;
  /** Whether interactive cards are supported. */
  cards: boolean;
  /** Whether reaction support exists. */
  reactions: boolean;
  /** Whether thread support exists. */
  threads: boolean;

  /**
   * How incremental assistant output is delivered:
   * - `native`   — the platform streams chunks natively (e.g. DingTalk AI Card)
   * - `edit`     — an existing message/card can be updated in place
   * - `buffered` — accumulate chunks and send once (e.g. Weixin)
   */
  streaming: StreamingMode;

  /** Optional hard cap for a single outbound message. */
  maxTextLength?: number;
  /** Optional upload size cap. */
  maxFileSize?: number;
}
