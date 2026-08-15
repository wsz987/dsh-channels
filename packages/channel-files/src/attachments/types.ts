/**
 * Stored channel asset metadata (plan \u00a745).
 *
 * A `StoredChannelAsset` is the durable, platform-agnostic record of a file /
 * audio / video part that entered the private channel asset store. Images are
 * NOT stored here — they use the Harness native image seam
 * (`@deepseek-ai/dsh-attachment`, the `SaveImageHook` path), so `kind` is
 * only `'file' | 'audio' | 'video'`.
 *
 * The metadata deliberately carries NO transient platform state (plan \u00a746):
 * there is no `resourceRef`, no provider URL, no access token, no
 * `contextToken`, no `sessionWebhook` and no encrypted AES key. Only what the
 * harness needs to read the bytes back locally, bound to the session that owns
 * them (the ACL is `sessionId`).
 */

/** Schema version of `StoredChannelAsset` (mirrors the v1 directory). */
export const ASSET_SCHEMA_VERSION = 1 as const;

export type ChannelAssetKind = 'file' | 'audio' | 'video';

export type ExtractionStatus =
  | 'not-needed'
  | 'ready'
  | 'unsupported'
  | 'failed'
  | 'too-large';

export type ExtractionFormat = 'text' | 'markdown';

export interface AssetExtraction {
  status: ExtractionStatus;
  /** Present when `status` is `ready`. */
  format?: ExtractionFormat;
  /** Byte length of the extracted text (when status is `ready`). */
  bytes?: number;
  /** Stable, de-identified failure reason (when status is `failed`). */
  errorCode?: string;
}

export interface StoredChannelAsset {
  schemaVersion: typeof ASSET_SCHEMA_VERSION;
  attachmentId: string;
  sessionId: string;
  channelId: string;
  accountId: string;
  conversationId: string;
  conversationType?: 'dm' | 'group';
  threadId?: string;
  messageId: string;
  kind: ChannelAssetKind;
  name: string;
  mimeType?: string;
  /** Final byte length (computed by the store from the written bytes). */
  bytes: number;
  sha256: string;
  extraction: AssetExtraction;
  createdAt: number;
}

/**
 * Input to `ChannelInboundAssetStore.put`.
 *
 * `bytes` / `sha256` / `mimeType` are NOT caller-supplied truth: the store
 * computes the final `sha256` and `bytes` from `data` and re-verifies
 * `mimeType` via magic sniffing (plan \u00a747); an adapter `mimeType` is only
 * a hint. `extraction` (when given) records the initial extraction state in
 * `meta.json`; the extracted text itself arrives later via
 * `putExtracted`.
 */
export interface PutChannelAssetInput {
  attachmentId: string;
  sessionId: string;
  channelId: string;
  accountId: string;
  conversationId: string;
  conversationType?: 'dm' | 'group';
  threadId?: string;
  messageId: string;
  kind: ChannelAssetKind;
  name: string;
  /** Adapter MIME hint — re-verified by the store, never trusted verbatim. */
  mimeType?: string;
  /** The raw bytes to persist (written verbatim as `raw.bin`). */
  data: Uint8Array;
  /** Initial extraction state; defaults to `{ status: 'not-needed' }`. */
  extraction?: AssetExtraction;
  createdAt?: number;
}

/** Input to `ChannelInboundAssetStore.putExtracted` (plan \u00a743). */
export interface StoredAssetExtractionInput {
  /** The extracted readable text (written to `extracted.md`). */
  text: string;
  format: ExtractionFormat;
  /** Byte length override; defaults to the UTF-8 byte length of `text`. */
  bytes?: number;
}

/** User-visible descriptor for a stored asset (plan \u00a754). */
export interface StoredAssetDescriptor {
  attachmentId: string;
  name: string;
  mimeType?: string;
  bytes: number;
  durable: boolean;
  /** Whether exposed extracted text is ready (not the text itself). */
  readable: boolean;
}
