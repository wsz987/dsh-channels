/**
 * DSH SDK port — the thin seam between the QQ adapter and the Tencent SDK.
 *
 * The adapter never touches `QQBot` directly; everything flows through
 * `QQSdkClient`. Production wraps the real `QQBot` (`TencentQQSdkClient`);
 * tests inject a `FakeQQSdkClient` so the entire adapter contract suite runs
 * fully offline (no network, no real credentials).
 */
import {
  MediaFileType,
  QQBot,
  type Logger as SdkLogger,
  type QQBotInboundMessage,
  type ReplyTarget,
} from '@tencent-connect/qqbot-nodejs';
import { ChannelSendError, type ChannelLogger, type OutboundMessage } from '@wsz987/channel-core';
import type { QQConfig } from './config.js';

/** Reply target for outbound text/media send (port-local structural type). */
export interface QQReplyTarget {
  scope: 'c2c' | 'group';
  targetId: string;
  msgId?: string;
}

/** Stream target for native C2C streaming (port-local structural type). */
export interface QQStreamTarget {
  scope: 'c2c' | 'group';
  targetId: string;
  msgId?: string;
}

/**
 * Structural slice of the SDK `StreamSession` the adapter needs. Kept as an
 * interface so both the real SDK `StreamSession` and the offline fake satisfy
 * it (the SDK class carries private members a plain fake cannot implement).
 */
export interface QQStreamSession {
  update(fullText: string): Promise<void>;
  complete(): Promise<unknown>;
  cancel(): void;
}

export interface QQSdkClient {
  onReady(handler: () => void): void;
  onResumed(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
  onMessage(handler: (message: QQBotInboundMessage) => void): void;

  start(signal: AbortSignal): Promise<void>;
  stop(): void;

  sendText(target: QQReplyTarget, text: string): Promise<unknown>;
  sendMedia(target: QQReplyTarget, message: OutboundMessage): Promise<unknown>;
  openStream(target: QQStreamTarget, options: { throttleMs: number }): QQStreamSession;
}

/** Bridge a DSH `ChannelLogger` (variadic) to the SDK `Logger` shape. */
export function adaptLogger(logger: ChannelLogger): SdkLogger {
  return {
    info: (msg, meta) => logger.info(msg, meta),
    error: (msg, meta) => logger.error(msg, meta),
    warn: (msg, meta) => logger.warn(msg, meta),
    debug: (msg, meta) => logger.debug(msg, meta),
  };
}

/** Production `QQSdkClient`: wraps a real `QQBot` built from config. */
export class TencentQQSdkClient implements QQSdkClient {
  readonly bot: QQBot;

  constructor(config: QQConfig, logger: ChannelLogger, appSecret: string) {
    this.bot = new QQBot({
      appId: config.appId,
      appSecret,
      accountId: config.accountId,
      markdownSupport: config.markdownSupport,
      transport: 'websocket',
      tokenPrefetch: 'sync',
      logger: adaptLogger(logger),
    });
  }

  onReady(handler: () => void): void {
    this.bot.on('ready', () => handler());
  }

  onResumed(handler: () => void): void {
    this.bot.on('resumed', () => handler());
  }

  onError(handler: (error: Error) => void): void {
    this.bot.on('error', (error) => handler(error));
  }

  onMessage(handler: (message: QQBotInboundMessage) => void): void {
    this.bot.on('message', (_ctx, message) => handler(message));
  }

  start(signal: AbortSignal): Promise<void> {
    return this.bot.start(signal);
  }

  stop(): void {
    this.bot.stop();
  }

  sendText(target: QQReplyTarget, text: string): Promise<unknown> {
    return this.bot.sendText(target, text);
  }

  async sendMedia(target: QQReplyTarget, message: OutboundMessage): Promise<unknown> {
    return this.bot.sendMedia({ target: toSdkReplyTarget(target), ...mediaOpts(message) });
  }

  openStream(target: QQStreamTarget, options: { throttleMs: number }): QQStreamSession {
    return this.bot.openStream({
      target: toSdkReplyTarget(target),
      throttleMs: options.throttleMs,
    });
  }
}

/** Port `QQReplyTarget`/`QQStreamTarget` is structurally identical to the SDK
 * `ReplyTarget`; narrow explicitly so the SDK methods accept it. */
function toSdkReplyTarget(target: QQReplyTarget): ReplyTarget {
  return { scope: target.scope, targetId: target.targetId, msgId: target.msgId };
}

/**
 * Map an outbound message's first resolvable media part to SDK `sendMedia`
 * options (fileType + single source + optional caption).
 *
 * A `dataUri` (`data:<mime>;base64,<payload>`) is decoded to its raw base64
 * payload and sent as `fileData` — never as `url`: the QQ upload API fetches
 * `url` over HTTP and cannot resolve an inline `data:` URL. Only a real
 * `http(s)` `url` is passed through as `url`.
 */
export interface MediaOptions {
  fileType: MediaFileType;
  url?: string;
  fileData?: string;
  fileName?: string;
  content?: string;
}

export function mediaOpts(message: OutboundMessage): MediaOptions {
  for (const part of message.parts ?? []) {
    switch (part.type) {
      case 'image':
        if (part.url || part.dataUri || part.localData !== undefined) {
          return {
            fileType: MediaFileType.IMAGE,
            ...mediaSource(part),
            content: message.text,
          };
        }
        break;
      case 'audio':
        if (part.url || part.dataUri || part.localData !== undefined) {
          return { fileType: MediaFileType.VOICE, ...mediaSource(part) };
        }
        break;
      case 'video':
        if (part.url || part.dataUri || part.localData !== undefined) {
          return { fileType: MediaFileType.VIDEO, ...mediaSource(part) };
        }
        break;
      case 'file':
        if (part.url || part.dataUri || part.localData !== undefined) {
          return {
            fileType: MediaFileType.FILE,
            ...mediaSource(part),
            fileName: part.name,
            content: message.text,
          };
        }
        break;
      default:
        break;
    }
  }
  // No resolvable media part — fall back to a FILE with no source (caller
  // guarantees a media part; this branch is defensive only).
  return { fileType: MediaFileType.FILE, content: message.text };
}

/**
 * Resolve a media part to the SDK's single-source shape (`url` or `fileData`).
 *
 * Carrier precedence (plan §65 / §85): trusted bytes in hand win, then an
 * inline data URI, then a genuine `http(s)` `url`. `localData` /
 * `dataUri` are both base64-encoded for the QQ `uploadMedia` `fileData`
 * field — never sent as `url` (the QQ upload API fetches `url` over HTTP and
 * cannot resolve inline/raw bytes). Only a real `http(s)` `url` is passed
 * through as `url`.
 */
function mediaSource(part: { url?: string; dataUri?: string; localData?: Uint8Array }): { url?: string; fileData?: string } {
  if (part.localData !== undefined) {
    return { fileData: Buffer.from(part.localData).toString('base64') };
  }
  if (part.dataUri) {
    return { fileData: decodeDataUri(part.dataUri) };
  }
  return { url: part.url };
}

/**
 * Decode a `data:<mime>;base64,<payload>` URI into the raw base64 payload the
 * Tencent `uploadMedia` `fileData` field expects. Rejects non-base64 data URIs
 * (the QQ upload API ingests raw base64, not arbitrary URL-encoded payloads).
 */
export function decodeDataUri(dataUri: string): string {
  const match = /^data:[^;,]*;base64,([\s\S]+)$/.exec(dataUri);
  const payload = match?.[1];
  if (!payload) {
    throw new ChannelSendError('unsupported media data URI');
  }
  return payload;
}

/** Offline fake SDK client: records calls and exposes controllable emits. */
export class FakeQQSdkClient implements QQSdkClient {
  private readyHandlers: (() => void)[] = [];
  private resumedHandlers: (() => void)[] = [];
  private errorHandlers: ((error: Error) => void)[] = [];
  private messageHandlers: ((message: QQBotInboundMessage) => void)[] = [];

  started = false;
  stopped = false;
  /** If set, `start()` throws this error (never resolves). */
  startError?: Error;
  /** If true, `start()` resolves only when the signal aborts. */
  hangStart = false;
  /** If true, `start()` emits `ready` (then still resolves immediately). */
  autoReady = false;
  /** Last signal passed to `start()`. */
  lastSignal?: AbortSignal;

  readonly textCalls: { target: QQReplyTarget; text: string }[] = [];
  readonly mediaCalls: { target: QQReplyTarget; message: OutboundMessage }[] = [];
  readonly streamCalls: { target: QQStreamTarget; options: { throttleMs: number } }[] = [];
  /** The live stream sessions opened so far (same order as `streamCalls`). */
  readonly streams: QQStreamSession[] = [];
  /** If set, `sendText`/`sendMedia` reject with this error. */
  sendError?: Error;

  onReady(handler: () => void): void {
    this.readyHandlers.push(handler);
  }

  onResumed(handler: () => void): void {
    this.resumedHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  onMessage(handler: (message: QQBotInboundMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  async start(signal: AbortSignal): Promise<void> {
    this.started = true;
    this.lastSignal = signal;
    if (this.startError) throw this.startError;
    if (this.autoReady) this.emitReady();
    if (this.hangStart) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return;
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async sendText(target: QQReplyTarget, text: string): Promise<unknown> {
    if (this.sendError) throw this.sendError;
    this.textCalls.push({ target, text });
    return { id: `out-${this.textCalls.length}` };
  }

  async sendMedia(target: QQReplyTarget, message: OutboundMessage): Promise<unknown> {
    if (this.sendError) throw this.sendError;
    this.mediaCalls.push({ target, message });
    return { upload: {}, message: { id: `out-media-${this.mediaCalls.length}` } };
  }

  openStream(target: QQStreamTarget, options: { throttleMs: number }): QQStreamSession {
    this.streamCalls.push({ target, options });
    const session = new FakeStreamSession();
    this.streams.push(session);
    return session;
  }

  // —— controllable emit helpers (tests) ——

  emitReady(): void {
    for (const h of this.readyHandlers) h();
  }

  emitResumed(): void {
    for (const h of this.resumedHandlers) h();
  }

  emitError(error: Error): void {
    for (const h of this.errorHandlers) h(error);
  }

  emitMessage(message: QQBotInboundMessage): void {
    for (const h of this.messageHandlers) h(message);
  }
}

/** Minimal offline `QQStreamSession` double for fake-client tests. */
export class FakeStreamSession implements QQStreamSession {
  updates: string[] = [];
  completed = false;
  cancelled = false;

  async update(fullText: string): Promise<void> {
    this.updates.push(fullText);
  }

  async complete(): Promise<{ id: string; timestamp: number } | undefined> {
    this.completed = true;
    return { id: 'stream-final', timestamp: Date.now() };
  }

  cancel(): void {
    this.cancelled = true;
  }
}
