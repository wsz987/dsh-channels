/**
 * Structured message content shared by inbound (`MessagePart[]`) and
 * outbound (`OutboundMessage`) directions.
 *
 * Adapters MUST NOT collapse platform messages into a bare `text` string —
 * image understanding, ASR, document analysis and rich interaction all build
 * on structured content.
 */

/**
 * Stable, de-identified reason a binary asset failed to ingress. Adapters set
 * this on a part (instead of a platform-specific exception) so the host can
 * degrade gracefully and diagnose without leaking upstream internals.
 */
export type BinaryIngressFailureCode =
  | 'too-large'
  | 'download-failed'
  | 'decrypt-failed'
  | 'integrity-failed'
  | 'mime-invalid'
  | 'resource-unavailable';

/**
 * Common fields shared by every binary part (image / file / audio / video).
 *
 * Exactly one carrier should carry the bytes that actually reach the host:
 *
 * - `url` — ONLY a genuine `http(s)` URL. This is the only carrier the
 *   secure remote fetcher may ingest. Any other string (image_key,
 *   file_key, file_id, mediaId, …) is a platform-opaque handle and MUST NOT
 *   be put in `url`.
 * - `resourceRef` — a platform-opaque handle (Lark image_key/file_key,
 *   Telegram file_id, DingTalk mediaId, …). It is resolved ONLY by the
 *   platform upstream into bytes. It is NEVER passed to a generic fetch and
 *   never accepted by the secure fetcher.
 * - `dataUri` — an inline data URL.
 * - `localData` — trusted bytes already downloaded/decrypted by the
 *   adapter. It is preferred over `url` / `dataUri` / `resourceRef` when
 *   the adapter has the raw binary in hand.
 *
 * See the M2 contract (plan §8/§9) for the url-vs-resourceRef rule.
 */
export interface BinaryPartBase {
  /**
   * Only a genuine `http(s)` URL may be placed here. A string that is not a
   * real http(s) URL (e.g. a platform opaque handle) belongs in
   * `resourceRef`, never here.
   */
  url?: string;
  /**
   * Platform opaque handle (Lark image_key/file_key, Telegram file_id,
   * DingTalk mediaId, …). Resolved to bytes exclusively via the platform
   * upstream — NEVER via a generic `fetch`, and never accepted by the
   * secure remote media fetcher.
   */
  resourceRef?: string;
  /** Inline data URL. */
  dataUri?: string;
  /**
   * Trusted bytes already downloaded/decrypted by the adapter. Preferred over
   * `url` / `dataUri` / `resourceRef` when the adapter has the raw binary
   * in hand. Core never decodes or persists these — the Harness bridge turns
   * them into real attachments.
   */
  localData?: Uint8Array;
  /** Optional MIME type hint. */
  mimeType?: string;
  /** Optional human-readable filename. */
  name?: string;
  /** Optional byte size, when known in advance. */
  size?: number;
  /** Stable de-identified reason a binary asset failed to ingress. */
  ingressFailure?: BinaryIngressFailureCode;
}

/** Plain text. */
export interface TextPart {
  type: 'text';
  text: string;
}

/** A raster image reference (url or inline data uri). */
export interface ImagePart extends BinaryPartBase {
  type: 'image';
  /** Alt text or caption describing the image content. */
  alt?: string;
}

/** A generic file reference. */
export interface FilePart extends BinaryPartBase {
  type: 'file';
}

/** An audio reference (e.g. voice message, ASR input). */
export interface AudioPart extends BinaryPartBase {
  type: 'audio';
  /** Duration in milliseconds, when known. */
  durationMs?: number;
}

/** A video reference. */
export interface VideoPart extends BinaryPartBase {
  type: 'video';
  /** Duration in milliseconds, when known. */
  durationMs?: number;
}

/** A geographic location. */
export interface LocationPart {
  type: 'location';
  latitude: number;
  longitude: number;
  address?: string;
}

/**
 * A platform-native rich card. `payload` shape is platform-owned; core and
 * the Harness bridge never depend on it structurally.
 */
export interface CardPart {
  type: 'card';
  kind: string;
  payload?: unknown;
}

/**
 * Content the adapter recognized but cannot express structurally. Kept out
 * of the model surface unless the harness bridge opts in explicitly.
 */
export interface UnsupportedPart {
  type: 'unsupported';
  reason: string;
  raw?: unknown;
}

/** Any structured message part. */
export type MessagePart =
  | TextPart
  | ImagePart
  | FilePart
  | AudioPart
  | VideoPart
  | LocationPart
  | CardPart
  | UnsupportedPart;

/**
 * A platform-agnostic interactive action (button) attached to an outbound
 * message. Core only models the minimal generic surface: a stable `id` sent
 * back by the platform on interaction, a `label`, and an optional presentation
 * `style`. It intentionally carries NO platform-specific fields (e.g. Telegram
 * `callback_data` / Lark action value); adapters map `id ->` their inline
 * payload and `action -> id` on the corresponding interaction event.
 */
export interface OutboundAction {
  /** Stable action id returned verbatim by the platform on a press. */
  id: string;
  /** User-visible button label. */
  label: string;
  /** Optional presentation style; adapters map it to their closest equivalent. */
  style?: 'default' | 'primary' | 'success' | 'danger';
}

/** A single row of interactive buttons. */
export interface OutboundActionRow {
  actions: OutboundAction[];
}

/** Outbound message sent through `ChannelAdapter.send()`. */
export interface OutboundMessage {
  /** Plain text payload; most platforms support at least this. */
  text?: string;
  /** Structured parts, sent when the adapter's capabilities allow. */
  parts?: MessagePart[];
  /** Platform message id this message replies to, when applicable. */
  replyTo?: string;
  /**
   * Optional interactive action rows (buttons). Requires
   * `capabilities.interactiveActions`; adapters map them to their native
   * inline control (e.g. Telegram `InlineKeyboardMarkup`). Each action `id`
   * is echoed back on the matching `interaction.received` event.
   */
  actions?: OutboundActionRow[];
  /** Adapter-agnostic metadata (never passed to the model surface). */
  metadata?: Record<string, unknown>;
}

/** Result of one outbound send. */
export interface SendResult {
  /** Platform message id when the platform reports one. */
  messageId?: string;
  /** Whether the message was delivered or only queued. */
  delivered: boolean;
  /** Adapter-specific details for diagnostics. */
  raw?: unknown;
}

/** Collect plain text from a part list (skipping non-text content). */
export function collectText(parts: readonly MessagePart[]): string {
  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/** Build a text-only part list. */
export function textParts(text: string): TextPart[] {
  return [{ type: 'text', text }];
}
