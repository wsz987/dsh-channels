/**
 * Telegram channel adapter.
 *
 * Maps the Telegram Bot API (through the upstream driver) to the Channel
 * Contract. All network/lifecycle resources live behind the upstream driver
 * and are aborted via the adapter context signal. The adapter never touches
 * Harness Agent APIs.
 *
 * Auth is token-driven: when a token is resolved (via `deps.token`, the
 * credential seam, or the deprecated plaintext `config.token`), `start`
 * verifies it with getMe() and launches the long-poll receive loop; without a
 * token the adapter reports health 'down' and skips the loop entirely.
 * `beginAuth`/`pollAuth` are intentionally not implemented — there is no
 * interactive flow in V1; token rotation can slot in behind the same optional
 * contract methods later.
 *
 * Streaming is `edit`: ReplyRouter opens a `TelegramStreamingReply` which sends
 * one message and edits it in place with `editMessageText` as full-text
 * previews arrive. Set `config.streaming.enabled: false` to force the buffered
 * send-once strategy.
 */
import type {
  ChannelAdapter,
  ChannelAdapterContext,
  ChannelCapabilities,
  ChannelHealth,
  ChannelTarget,
  CreateReplyOptions,
  OutboundMessage,
  ReplyHandle,
  SendResult,
  StreamingMode,
} from '@wsz987/channel-core';
import { ChannelError } from '@wsz987/channel-core';
import type { TelegramConfig, TelegramFormattingConfig } from './config.js';
import { FetchTransport, type HttpTransport } from './transport.js';
import {
  HttpTelegramUpstream,
  type TelegramUpdateCursor,
  type TelegramUpstream,
} from './upstream.js';
import { InboundProcessor } from './inbound.js';
import { OutboundSender } from './outbound.js';
import { TelegramStreamingReply } from './streaming-reply.js';
import { TelegramRichStreamingReply } from './rich-streaming-reply.js';
import { actionsToReplyMarkup } from './outbound.js';
import { manifest as telegramManifest, type TelegramManifest } from './manifest.js';
import { resolveMode } from './render/index.js';

export interface TelegramAdapterDeps {
  transport?: HttpTransport;
  /**
   * Resolved Telegram Bot API token. The plugin resolves it via
   * `ctx.credentials` and hands it in; profile config never carries it.
   */
  token?: string;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** Adapter-level auth state; emits AuthState 'unknown' when unauthenticated. */
type TelegramAuthState = 'unauthenticated' | 'authenticated' | 'failed';

export class TelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram';

  /** Upstream compatibility manifest (read structurally by `channels doctor`). */
  readonly manifest: TelegramManifest = telegramManifest;

  readonly capabilities: ChannelCapabilities = {
    text: true,
    image: true,
    file: true,
    audio: true,
    video: true,
    // Rich Markdown (Bot API 10.1/10.2 sendRichMessage / HTML / MarkdownV2) is
    // genuinely rendered, not just parse_mode in a body (plan §Phase 3).
    markdown: true,
    cards: false,
    reactions: false,
    threads: true,
    // Inline buttons + callback_query interactions are supported (plan §5).
    interactiveActions: true,
    // Telegram can edit sent messages with editMessageText and can stream rich
    // drafts natively for DMs; `resolveStreamingMode` picks per target.
    streaming: 'edit',
    maxTextLength: 4096,
  };

  readonly outboxCapabilities = { proactiveText: true, proactiveMedia: true };

  private ctx?: ChannelAdapterContext;
  private upstream: TelegramUpstream;
  private inbound!: InboundProcessor;
  private outbound!: OutboundSender;
  private started = false;
  private stopped = false;
  private receiveLoop?: Promise<void>;
  private receiveAbort?: AbortController;
  private removeContextAbortListener?: () => void;
  private connected = false;
  private authState: TelegramAuthState = 'unauthenticated';
  /** getUpdates acknowledgement cursor, shared with the driver across retries. */
  private readonly cursor: TelegramUpdateCursor = { offset: 0 };
  private readonly now: () => number;
  /** Resolved token used by the upstream driver (deps credential wins over legacy config). */
  private readonly token: string | undefined;
  /** Resolved once so outbound, streaming and explicit edits use one policy. */
  private readonly formattingMode: Exclude<TelegramFormattingConfig['mode'], 'auto'>;

  constructor(private readonly config: TelegramConfig, deps: TelegramAdapterDeps = {}) {
    this.now = deps.now ?? Date.now;
    const transport = deps.transport ?? new FetchTransport(config.baseUrl, { timeoutMs: config.timeoutMs });
    const token = deps.token ?? config.token;
    this.upstream = new HttpTelegramUpstream({
      transport,
      token,
      longPollTimeoutMs: config.longPollTimeoutMs,
    });
    this.token = token;
    this.formattingMode = resolveMode(config.formatting.mode);
  }

  async start(ctx: ChannelAdapterContext): Promise<void> {
    if (this.started) return;
    this.ctx = ctx;
    this.stopped = false;
    this.connected = false;
    this.cursor.offset = 0;
    this.inbound = this.createInboundProcessor();
    this.receiveAbort = new AbortController();
    const abortReceive = () => this.receiveAbort?.abort();
    if (ctx.signal.aborted) abortReceive();
    else {
      ctx.signal.addEventListener('abort', abortReceive, { once: true });
      this.removeContextAbortListener = () => ctx.signal.removeEventListener('abort', abortReceive);
    }

    this.outbound = new OutboundSender(this.upstream, ctx.logger, {
      formatting: { ...this.config.formatting, mode: this.formattingMode },
    });

    if (this.token) {
      try {
        await this.upstream.getMe();
        this.authState = 'authenticated';
        this.emitAuth('authenticated');
      } catch (error) {
        this.authState = 'failed';
        this.emitAuth('failed');
        this.ctx.logger.error(
          '[channel-telegram] auth check failed; receive loop disabled',
          error instanceof Error ? error.message : error,
        );
        this.started = true;
        return;
      }

      try {
        // getUpdates and webhooks are mutually exclusive. Preserve queued
        // updates while switching this bot to the local polling transport.
        await this.upstream.deleteWebhook();
        this.emitConnection('connecting');
        this.startReceiveLoop();
      } catch (error) {
        this.ctx.logger.error(
          '[channel-telegram] polling setup failed; receive loop disabled',
          error instanceof Error ? error.message : error,
        );
        this.emitConnection('disconnected');
      }
    } else {
      this.authState = 'unauthenticated';
      this.emitAuth('unknown');
    }
    this.started = true;
  }

  private createInboundProcessor(): InboundProcessor {
    return new InboundProcessor({
      ctx: this.ctx!,
      meta: { channel: this.id as never, accountId: this.config.accountId as never },
      dedupEnabled: this.config.dedup.enabled,
      dedupWindowMs: this.config.dedup.windowMs,
      files: this.upstream,
      maxDownloadBytes: this.config.maxDownloadBytes,
      now: this.now,
      // Best-effort callback ACK (clears the button spinner; never blocks on
      // agent resolution — plan §12.2).
      ackCallback: (callbackId) => this.upstream.answerCallbackQuery({ callback_query_id: callbackId }),
    });
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopped) return;
    this.stopped = true;
    this.started = false;
    this.connected = false;
    this.receiveAbort?.abort();
    this.receiveAbort = undefined;
    this.removeContextAbortListener?.();
    this.removeContextAbortListener = undefined;
    const loop = this.receiveLoop;
    this.receiveLoop = undefined;
    if (loop) await loop.catch(() => undefined);
    this.emitConnection('closed');
  }

  async send(target: ChannelTarget, message: OutboundMessage): Promise<SendResult> {
    if (!this.started || !this.outbound) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'telegram adapter is not started');
    }
    return this.outbound.send(target, message);
  }

  resolveStreamingMode(target: ChannelTarget): StreamingMode {
    // `streaming.enabled: false` is a hard off-switch: it forces the buffered
    // send-once strategy even though streaming is available.
    if (!this.config.streaming.enabled) return 'buffered';
    // Private DMs with rich output use the native sendRichMessageDraft flow.
    const rich = this.formattingMode === 'rich-markdown';
    if (rich && target.conversationType === 'dm') return 'native';
    // Everything else edits one message in place.
    return 'edit';
  }

  async createReply(target: ChannelTarget, _options?: CreateReplyOptions): Promise<ReplyHandle> {
    if (!this.started || !this.ctx) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'telegram adapter is not started');
    }
    const mode = this.formattingMode;
    const rich = mode === 'rich-markdown';
    // Native rich draft streaming for private DMs (plan §6.1).
    if (rich && target.conversationType === 'dm') {
      const reply = new TelegramRichStreamingReply(
        this.upstream,
        target,
        this.config.streaming.placeholder,
        { formatting: { mode } },
      );
      await reply.start();
      return reply;
    }
    // Group (or plain config): plain edit preview; finish upgrades the same
    // message to a Rich Message when rich output is active (plan §6.2).
    const reply = new TelegramStreamingReply(
      this.upstream,
      target,
      this.config.streaming.placeholder,
      { formatting: { mode }, richFinal: rich && target.conversationType !== 'dm' },
    );
    // Send the placeholder immediately so the user sees the bot is working;
    // subsequent full-text previews edit this same message in place.
    await reply.start();
    return reply;
  }

  /**
   * Optional in-place edit of an already-sent message (plan §15.3): either
   * update the interactive keyboard (`editMessageReplyMarkup`) or the text
   * (`editMessageText`).
   */
  async edit(target: ChannelTarget, messageId: string, message: OutboundMessage): Promise<SendResult> {
    if (!this.started) {
      throw new ChannelError('CHANNEL_NOT_STARTED', 'telegram adapter is not started');
    }
    if (message.text !== undefined) {
      const markup = message.actions === undefined
        ? undefined
        : actionsToReplyMarkup(message.actions) ?? { inline_keyboard: [] };
      const mode = this.formattingMode;
      const raw = mode === 'rich-markdown'
        ? await this.upstream.editMessageRich(
            target.conversationId,
            messageId,
            { markdown: message.text },
            markup,
          )
        : await this.upstream.editMessageText(
            target.conversationId,
            messageId,
            message.text,
            markup ? { replyMarkup: markup } : undefined,
          );
      return { delivered: true, raw };
    }
    if (message.actions !== undefined) {
      const markup = actionsToReplyMarkup(message.actions) ?? { inline_keyboard: [] };
      const raw = await this.upstream.editMessageReplyMarkup(target.conversationId, messageId, markup);
      return { delivered: true, raw };
    }
    return { delivered: true };
  }

  async getHealth(): Promise<ChannelHealth> {
    if (!this.started) {
      return { status: 'down', detail: 'telegram adapter is not started', authenticated: false };
    }
    if (this.authState === 'authenticated' && this.connected) {
      return { status: 'ok', detail: 'connected', connection: 'connected', authenticated: true };
    }
    if (this.authState === 'authenticated') {
      return {
        status: 'down',
        detail: 'authenticated but receive loop down',
        connection: 'disconnected',
        authenticated: true,
      };
    }
    if (this.authState === 'failed') {
      return { status: 'down', detail: 'authentication failed', authenticated: false };
    }
    return { status: 'down', detail: 'not configured: no bot token', authenticated: false };
  }

  /** Long-poll receive loop with exponential backoff on failure. */
  private startReceiveLoop(): void {
    if (this.receiveLoop) return;
    this.receiveLoop = this.runReceiveLoop();
  }

  private async runReceiveLoop(): Promise<void> {
    let attempt = 0;
    const signal = this.receiveAbort?.signal;
    if (!signal) return;
    while (!this.stopped && !signal.aborted) {
      try {
        await this.upstream.getUpdates(
          this.cursor,
          signal,
          async (raw) => {
            try {
              await this.inbound.handle(raw);
            } catch (error) {
              // Reset transient processor state before retrying the unacked
              // update after the receive loop reconnects.
              this.inbound = this.createInboundProcessor();
              throw error;
            }
          },
          () => {
            if (!this.connected) {
              this.connected = true;
              this.emitConnection('connected');
            }
          },
        );
        attempt = 0;
      } catch (error) {
        if (this.stopped || signal.aborted) break;
        attempt += 1;
        this.connected = false;
        this.emitConnection('reconnecting');
        if (!this.config.reconnect.enabled || attempt > this.config.reconnect.maxRetries) {
          this.ctx!.logger.warn('[channel-telegram] reconnect budget exhausted');
          this.emitConnection('disconnected');
          break;
        }
        const delay = Math.min(
          this.config.reconnect.baseDelayMs * 2 ** Math.min(attempt - 1, 8),
          this.config.reconnect.maxDelayMs,
        );
        this.ctx!.logger.warn(`[channel-telegram] receive loop error; retry in ${delay}ms`, error);
        await sleep(delay, signal);
      }
    }
    this.connected = false;
    if (!this.stopped && !signal.aborted) {
      this.emitConnection('disconnected');
    }
  }

  private emitAuth(state: 'unknown' | 'authenticated' | 'failed'): void {
    if (!this.ctx) return;
    void this.ctx
      .emit({
        type: 'auth.changed',
        channel: this.id as never,
        accountId: this.config.accountId as never,
        state,
      })
      .catch(() => undefined);
  }

  private emitConnection(state: 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'closed'): void {
    if (!this.ctx) return;
    void this.ctx
      .emit({
        type: 'connection.changed',
        channel: this.id as never,
        accountId: this.config.accountId as never,
        state,
      })
      .catch(() => undefined);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
