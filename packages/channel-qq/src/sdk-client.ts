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

/**
 * QQ Gateway intents the adapter actually consumes today (minimal-intent
 * principle): `GROUP_AND_C2C` covers the C2C/group message events this adapter
 * processes inbound, and `INTERACTION` covers the button `INTERACTION_CREATE`
 * callbacks that drive `interaction.received`. The SDK defaults to
 * `FULL_INTENTS` (guilids + members + guild messages + dm + group/c2c +
 * interaction); requesting only what we use avoids `4914 INSUFFICIENT_INTENTS`
 * / `4915 DISALLOWED_INTENTS` gateway rejections for privileges the bridge
 * never exercises, and keeps the permission surface minimal. Bit values are
 * verified from the pinned SDK (`dist/protocol/gateway/constants.js`):
 * `GROUP_AND_C2C = 1 << 25`, `INTERACTION = 1 << 26`.
 */
export const QQ_MINIMAL_INTENTS = (1 << 25) | (1 << 26); // GROUP_AND_C2C | INTERACTION

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

/**
 * Structural slice of the SDK `InteractionEvent` the adapter needs for an
 * `interaction.received` round-trip. Kept port-local (no platform import in
 * the adapter) so the real SDK type and the offline fake both satisfy it.
 *
 * All fields are optional here to mirror the untrusted wire shape; the
 * adapter validates the actual payload with a zod schema at the trust
 * boundary before emitting a canonical event.
 */
export interface QQInteractionLike {
  id?: string;
  chat_type?: number;
  user_openid?: string;
  group_openid?: string;
  group_member_openid?: string;
  data?: {
    resolved?: {
      button_id?: string;
      button_data?: string;
    };
  };
}

/**
 * Structural slice of the SDK `KeyboardButton` row shape the outbound mapper
 * serializes into. Mirrors the QQ platform inline-keyboard contract:
 * `action.data` is the opaque value echoed back verbatim in
 * `InteractionEvent.data.resolved.button_data`, so the `uq_*` action id rides
 * there (and in `id`, the platform-stable button handle).
 */
export interface QQKeyboardButton {
  id: string;
  render_data: {
    label: string;
    visited_label: string;
    style: number;
  };
  action: {
    type: number;
    permission: { type: number };
    data: string;
    click_limit?: number;
  };
  group_id?: string;
}

/** Port-local structural slice of the SDK `InlineKeyboard`. */
export interface QQInlineKeyboardLike {
  content: {
    rows: Array<{ buttons: QQKeyboardButton[] }>;
  };
}

/** QQ inline-keyboard callback action (emits `INTERACTION_CREATE`). */
export const QQ_BUTTON_ACTION_TYPE = 1;
/** QQ inline-keyboard permission: any user may press. */
export const QQ_BUTTON_PERMISSION_TYPE = 2;
/** QQ button render style for the `primary` DSH action style. */
export const QQ_BUTTON_STYLE_PRIMARY = 1;
/** QQ button render style default. */
export const QQ_BUTTON_STYLE_DEFAULT = 0;

export interface QQSdkClient {
  onReady(handler: () => void): void;
  onResumed(handler: () => void): void;
  onError(handler: (error: Error) => void): void;
  onMessage(handler: (message: QQBotInboundMessage) => void): void;
  onInteraction(handler: (event: QQInteractionLike) => void): void;

  start(signal: AbortSignal): Promise<void>;
  stop(): void;

  sendText(target: QQReplyTarget, text: string): Promise<unknown>;
  sendMarkdownWithKeyboard(target: QQReplyTarget, text: string, keyboard: QQInlineKeyboardLike): Promise<unknown>;
  sendMedia(target: QQReplyTarget, message: OutboundMessage): Promise<unknown>;
  acknowledgeInteraction(id: string, code?: number, data?: Record<string, unknown>): Promise<unknown>;
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
      // Minimal intent mask (GROUP_AND_C2C | INTERACTION) — never rely on the
      // SDK `FULL_INTENTS` default (skill §6.2, P1). See QQ_MINIMAL_INTENTS.
      intents: QQ_MINIMAL_INTENTS,
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

  onInteraction(handler: (event: QQInteractionLike) => void): void {
    // The SDK dispatches the raw `InteractionEvent` as the second argument;
    // the handler only sees the port slice the adapter needs.
    this.bot.on('interaction', (_ctx, event) => handler(event));
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

  sendMarkdownWithKeyboard(target: QQReplyTarget, text: string, keyboard: QQInlineKeyboardLike): Promise<unknown> {
    // New QQ interactive messages are explicit Markdown messages. Do not use
    // sendTextWithKeyboard(): that helper follows `markdownSupport` and emits
    // msg_type=0 when the legacy config flag is false, in which case current
    // QQ clients do not render the keyboard.
    return this.bot.sendMarkdown(toSdkReplyTarget(target), text, { keyboard });
  }

  acknowledgeInteraction(id: string, code?: number, data?: Record<string, unknown>): Promise<unknown> {
    return this.bot.acknowledgeInteraction(id, code, data);
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
 * Carrier precedence: trusted bytes in hand win, then an
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
  private interactionHandlers: ((event: QQInteractionLike) => void)[] = [];

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
  readonly keyboardCalls: { target: QQReplyTarget; text: string; keyboard: QQInlineKeyboardLike; format: 'markdown' }[] = [];
  readonly mediaCalls: { target: QQReplyTarget; message: OutboundMessage }[] = [];
  readonly acknowledgeCalls: { id: string; code?: number; data?: Record<string, unknown> }[] = [];
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

  onInteraction(handler: (event: QQInteractionLike) => void): void {
    this.interactionHandlers.push(handler);
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
    // Mirror the real SDK teardown: once stopped, no more events are
    // dispatched to registered handlers.
    this.readyHandlers = [];
    this.resumedHandlers = [];
    this.errorHandlers = [];
    this.messageHandlers = [];
    this.interactionHandlers = [];
  }

  async sendText(target: QQReplyTarget, text: string): Promise<unknown> {
    if (this.sendError) throw this.sendError;
    this.textCalls.push({ target, text });
    return { id: `out-${this.textCalls.length}` };
  }

  async sendMarkdownWithKeyboard(
    target: QQReplyTarget,
    text: string,
    keyboard: QQInlineKeyboardLike,
  ): Promise<unknown> {
    if (this.sendError) throw this.sendError;
    this.keyboardCalls.push({ target, text, keyboard, format: 'markdown' });
    return { id: `out-kbd-${this.keyboardCalls.length}` };
  }

  async sendMedia(target: QQReplyTarget, message: OutboundMessage): Promise<unknown> {
    if (this.sendError) throw this.sendError;
    this.mediaCalls.push({ target, message });
    return { upload: {}, message: { id: `out-media-${this.mediaCalls.length}` } };
  }

  async acknowledgeInteraction(id: string, code?: number, data?: Record<string, unknown>): Promise<unknown> {
    this.acknowledgeCalls.push({ id, code, data });
    return undefined;
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

  emitInteraction(event: QQInteractionLike): void {
    for (const h of this.interactionHandlers) h(event);
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
