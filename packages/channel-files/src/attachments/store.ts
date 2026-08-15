/**
 * Private channel inbound asset store (plan \u00a742-\u00a747).
 *
 * Disk layout (plan \u00a742):
 *
 * \`\`\`
 * <attachmentsRoot>/
 *   sessions/
 *     <sessionId>/
 *       <messageId>/
 *         <attachmentId>/
 *           meta.json      # StoredChannelAsset, schemaVersion: 1
 *           raw.bin        # verbatim stored bytes
 *           extracted.md   # written only when extraction is ready
 *   index.json            # store-owned attachmentId -> {sessionId,messageId}
 *   .staging/<uuid>/      # transient write area; never observed by readers
 * \`\`\`
 *
 * PUBLISH IS ATOMIC (plan \u00a744): `put` writes the whole asset into a fresh
 * `.staging/<uuid>` directory and then renames it over the final directory.
 * A reader never observes a half-written asset. `meta.json` records the final
 * `sha256` / `bytes` computed by the store (never caller-supplied truth), and
 * an adapter `mimeType` is only a hint that is re-verified by magic sniffing
 * (plan \u00a747).
 *
 * Extraction is two-phase: `put` stores the raw bytes + an initial extraction
 * status, and `putExtracted` atomically publishes the extracted text and flips
 * `meta.json` to `ready`. If `meta.json` is unreadable, `get` returns
 * undefined — corrupt metadata is never partially trusted.
 */
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAttachmentsRoot } from '../paths.js';
import { sanitizeFilename, normalizeMimeHint } from './filename.js';
import { verifiedMime } from './mime.js';
import { sha256Hex } from './hash.js';
import { parseStoredChannelAsset } from './schema.js';
import {
  ASSET_SCHEMA_VERSION,
  type StoredChannelAsset,
  type PutChannelAssetInput,
  type StoredAssetExtractionInput,
  type AssetExtraction,
} from './types.js';
import {
  DEFAULT_ATTACHMENT_POLICY,
  isInboundWithinLimit,
  type AttachmentPolicy,
} from './policy.js';

/** Errors the store raises for security / integrity boundaries. */
export class AssetStoreError extends Error {
  readonly code:
    | 'ASSET_NOT_FOUND'
    | 'ASSET_TOO_LARGE'
    | 'ASSET_OVER_MAX_INBOUND'
    | 'ASSET_CORRUPT_META';
  constructor(code: AssetStoreError['code'], message: string) {
    super(message);
    this.name = 'AssetStoreError';
    this.code = code;
  }
}

interface AssetLocation {
  sessionId: string;
  messageId: string;
}

export interface PutChannelAssetContext {
  root?: string;
  policy?: AttachmentPolicy;
}

/** The store contract (plan \u00a743). */
export interface ChannelInboundAssetStore {
  put(input: PutChannelAssetInput): Promise<StoredChannelAsset>;
  putExtracted(
    attachmentId: string,
    extraction: StoredAssetExtractionInput,
  ): Promise<StoredChannelAsset | undefined>;
  /**
   * Record a NON-ready extraction status (unsupported / failed / too-large)
   * for an already-stored asset, updating only meta.json. No extracted.md is
   * written. No-op when the asset does not exist.
   */
  recordExtraction?(
    attachmentId: string,
    extraction: AssetExtraction,
  ): Promise<void>;
  get(attachmentId: string): Promise<StoredChannelAsset | undefined>;
  readRaw(
    attachmentId: string,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<Uint8Array>;
  readExtracted(
    attachmentId: string,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<string | undefined>;
}

const INDEX_FILE = 'index.json';

/**
 * Filesystem-backed `ChannelInboundAssetStore`. Loads the durable
 * `index.json` lazily on first read, keeps an in-memory cache in sync, and
 * serializes all publish writes through a promise chain.
 */
export class FileChannelInboundAssetStore implements ChannelInboundAssetStore {
  private readonly root: string;
  private readonly policy: AttachmentPolicy;
  private index = new Map<string, AssetLocation>();
  private indexLoaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: PutChannelAssetContext = {}) {
    this.root = options.root ?? resolveAttachmentsRoot();
    this.policy = options.policy ?? DEFAULT_ATTACHMENT_POLICY;
  }

  /** Per-asset directory rooted at THIS store's root, not the global default. */
  private assetDir(attachmentId: string, sessionId: string, messageId: string): string {
    return join(this.root, 'sessions', sessionId, messageId, attachmentId);
  }

  /** Run a publish write serialized onto the chain (returns after this op). */
  private enqueue(op: () => Promise<void>): Promise<void> {
    this.writeChain = this.writeChain.then(op);
    return this.writeChain;
  }

  async put(input: PutChannelAssetInput): Promise<StoredChannelAsset> {
    if (!isInboundWithinLimit(input.data.byteLength, this.policy)) {
      throw new AssetStoreError(
        'ASSET_OVER_MAX_INBOUND',
        "asset '" + input.attachmentId + "' is " + input.data.byteLength
          + ' bytes, over the inbound cap ' + this.policy.maxInboundBytes,
      );
    }
    const attachmentId = this.resolveAttachmentId(input.attachmentId);
    const asset: StoredChannelAsset = {
      schemaVersion: ASSET_SCHEMA_VERSION,
      attachmentId,
      sessionId: input.sessionId,
      channelId: input.channelId,
      accountId: input.accountId,
      conversationId: input.conversationId,
      ...(input.conversationType ? { conversationType: input.conversationType } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      messageId: input.messageId,
      kind: input.kind,
      name: sanitizeFilename(input.name),
      mimeType: verifiedMime(input.data, normalizeMimeHint(input.mimeType)),
      bytes: input.data.byteLength,
      sha256: sha256Hex(input.data),
      extraction: input.extraction ?? { status: 'not-needed' },
      createdAt: input.createdAt ?? Date.now(),
    };
    await this.publishDir(input.sessionId, input.messageId, attachmentId, asset, input.data);
    return asset;
  }

  async putExtracted(
    attachmentId: string,
    extraction: StoredAssetExtractionInput,
  ): Promise<StoredChannelAsset | undefined> {
    const location = this.index.get(attachmentId);
    if (!location) throw new AssetStoreError('ASSET_NOT_FOUND', "no stored asset for '" + attachmentId + "'");
    const dir = this.assetDir(attachmentId, location.sessionId, location.messageId);
    const meta = await this.readMeta(dir);
    if (!meta) throw new AssetStoreError('ASSET_NOT_FOUND', "no meta for '" + attachmentId + "'");
    const outBytes = extraction.bytes ?? new TextEncoder().encode(extraction.text).byteLength;
    const updated: StoredChannelAsset = {
      ...meta,
      extraction: { status: 'ready', format: extraction.format, bytes: outBytes },
    };
    // Atomically replace extracted.md (staging file -> final name), then flip
    // meta.json. A reader either sees both, or neither flipped.
    await this.enqueue(async () => {
      const stagingDir = join(this.root, '.staging', randomUUID());
      await mkdir(stagingDir, { recursive: true });
      const stagedExtracted = join(stagingDir, 'extracted.md');
      await writeFile(stagedExtracted, extraction.text, 'utf8');
      await rename(stagedExtracted, join(dir, 'extracted.md'));
      // Replace meta.json atomically (temp file + rename within the asset dir).
      const metaTmp = join(dir, 'meta.json.' + randomUUID() + '.tmp');
      await writeFile(metaTmp, JSON.stringify(updated, null, 2), 'utf8');
      await rename(metaTmp, join(dir, 'meta.json'));
      await rm(stagingDir, { recursive: true, force: true });
    });
    return updated;
  }

  async recordExtraction(
    attachmentId: string,
    extraction: AssetExtraction,
  ): Promise<void> {
    const location = this.index.get(attachmentId);
    if (!location) return;
    const dir = this.assetDir(attachmentId, location.sessionId, location.messageId);
    const meta = await this.readMeta(dir);
    if (!meta) return;
    const updated: StoredChannelAsset = { ...meta, extraction };
    // Replace meta.json atomically (temp file + rename within the asset dir).
    await this.enqueue(async () => {
      const metaTmp = join(dir, 'meta.json.' + randomUUID() + '.tmp');
      await writeFile(metaTmp, JSON.stringify(updated, null, 2), 'utf8');
      await rename(metaTmp, join(dir, 'meta.json'));
    });
  }

  async get(attachmentId: string): Promise<StoredChannelAsset | undefined> {
    await this.ensureIndex();
    const location = this.index.get(attachmentId);
    if (!location) return undefined;
    return this.readMeta(this.assetDir(attachmentId, location.sessionId, location.messageId));
  }

  async readRaw(
    attachmentId: string,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<Uint8Array> {
    await this.ensureIndex();
    const location = this.index.get(attachmentId);
    if (!location) throw new AssetStoreError('ASSET_NOT_FOUND', "no stored asset for '" + attachmentId + "'");
    const file = join(this.assetDir(attachmentId, location.sessionId, location.messageId), 'raw.bin');
    return this.readBounded(file, options.maxBytes, options.signal);
  }

  async readExtracted(
    attachmentId: string,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<string | undefined> {
    await this.ensureIndex();
    const location = this.index.get(attachmentId);
    if (!location) return undefined;
    const dir = this.assetDir(attachmentId, location.sessionId, location.messageId);
    const meta = await this.readMeta(dir);
    if (!meta || meta.extraction.status !== 'ready') return undefined;
    const bytes = await this.readBounded(join(dir, 'extracted.md'), options.maxBytes, options.signal);
    return new TextDecoder('utf-8').decode(bytes);
  }

  /** Atomic directory publish (plan \u00a744): stage, then rename over target. */
  private async publishDir(
    sessionId: string,
    messageId: string,
    attachmentId: string,
    asset: StoredChannelAsset,
    data: Uint8Array,
  ): Promise<void> {
    const finalDir = this.assetDir(attachmentId, sessionId, messageId);
    const staging = join(this.root, '.staging', randomUUID());
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, 'raw.bin'), data);
    await writeFile(join(staging, 'meta.json'), JSON.stringify(asset, null, 2), 'utf8');
    await mkdir(join(finalDir, '..'), { recursive: true });
    await this.enqueue(async () => {
      await rename(staging, finalDir);
    });
    // Keep the lookup index durable. A publish that wrote bytes but failed to
    // record the index is recoverable by re-putting; we prefer correctness.
    this.idempotentIndex(attachmentId, { sessionId, messageId });
    await this.persistIndex();
  }

  private async readBounded(
    file: string,
    maxBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    if (signal?.aborted) throw new AssetStoreError('ASSET_CORRUPT_META', 'aborted');
    const handle = await open(file, 'r');
    try {
      const stat = await handle.stat();
      if (stat.size > maxBytes) {
        throw new AssetStoreError('ASSET_TOO_LARGE', 'read over cap ' + maxBytes);
      }
      const buffer = Buffer.alloc(stat.size);
      const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
    } finally {
      await handle.close();
    }
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexLoaded) return;
    this.indexLoaded = true;
    try {
      const text = await readFile(join(this.root, INDEX_FILE), 'utf8');
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        this.index = new Map(Object.entries(parsed as Record<string, AssetLocation>));
      }
    } catch {
      this.index = new Map();
    }
  }

  private async persistIndex(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const payload = JSON.stringify(Object.fromEntries(this.index), null, 2);
    await this.enqueue(async () => {
      const tmp = join(this.root, '.' + INDEX_FILE + '.' + randomUUID() + '.tmp');
      await writeFile(tmp, payload, 'utf8');
      await rename(tmp, join(this.root, INDEX_FILE));
    });
  }

  private idempotentIndex(attachmentId: string, location: AssetLocation): void {
    this.index.set(attachmentId, location);
  }

  private async readMeta(dir: string): Promise<StoredChannelAsset | undefined> {
    let text: string;
    try {
      text = await readFile(join(dir, 'meta.json'), 'utf8');
    } catch {
      return undefined;
    }
    try {
      return parseStoredChannelAsset(JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  private resolveAttachmentId(input: string): string {
    return input && input.trim().length > 0 ? input : 'att-' + randomUUID();
  }
}
