/**
 * Structured message content shared by inbound (`MessagePart[]`) and
 * outbound (`OutboundMessage`) directions.
 *
 * Adapters MUST NOT collapse platform messages into a bare `text` string —
 * image understanding, ASR, document analysis and rich interaction all build
 * on structured content.
 */

/** Plain text. */
export interface TextPart {
  type: 'text';
  text: string;
}

/** A raster image reference (url or inline data uri). */
export interface ImagePart {
  type: 'image';
  url?: string;
  dataUri?: string;
  mimeType?: string;
  alt?: string;
  /**
   * Bytes the adapter already downloaded and decrypted (e.g. an encrypted CDN
   * body). Core never decodes or persists these — the Harness bridge turns
   * them into a real image attachment. Prefer over `url`/`dataUri` when the
   * adapter has the raw image in hand.
   */
  localData?: Uint8Array;
}

/** A generic file reference. */
export interface FilePart {
  type: 'file';
  url?: string;
  dataUri?: string;
  mimeType?: string;
  name?: string;
  size?: number;
  /** Downloaded/decrypted bytes (see ImagePart.localData). */
  localData?: Uint8Array;
}

/** An audio reference (e.g. voice message, ASR input). */
export interface AudioPart {
  type: 'audio';
  url?: string;
  dataUri?: string;
  mimeType?: string;
  durationMs?: number;
}

/** A video reference. */
export interface VideoPart {
  type: 'video';
  url?: string;
  dataUri?: string;
  mimeType?: string;
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

/** Outbound message sent through `ChannelAdapter.send()`. */
export interface OutboundMessage {
  /** Plain text payload; most platforms support at least this. */
  text?: string;
  /** Structured parts, sent when the adapter's capabilities allow. */
  parts?: MessagePart[];
  /** Platform message id this message replies to, when applicable. */
  replyTo?: string;
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
