/**
 * Inbound processing: dedup window + structured mapping + media hydration (image/file/audio/video) + emit.
 */
import type { ChannelAdapterContext, MessagePart, MessageReceived } from '@wsz987/channel-core';
import { z } from 'zod';
import { dedupKey, mapInbound, mapInteraction, type DingTalkInboundMeta } from './mapper.js';

const downloadContextSchema = z.object({
  type: z.string().optional(),
  picDownloadCode: z.string().min(1).optional(),
  downloadCode: z.string().min(1).optional(),
  robotCode: z.string().min(1).optional(),
});

/** Compact per-part summary for inbound message logs (debug diagnostics). */
function summarizeParts(parts: readonly MessagePart[]): unknown[] {
  return parts.map((part) => {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text.slice(0, 80) };
      case 'image':
        return {
          type: 'image',
          hasUrl: Boolean(part.url),
          resourceRef: part.resourceRef ? '[redacted]' : undefined,
          mimeType: part.mimeType,
          localDataBytes: part.localData?.byteLength,
          ingressFailure: part.ingressFailure,
        };
      case 'file':
        return {
          type: 'file',
          name: part.name,
          size: part.size,
          mimeType: part.mimeType,
          localDataBytes: part.localData?.byteLength,
          ingressFailure: part.ingressFailure,
        };
      case 'audio':
        return {
          type: 'audio',
          durationMs: part.durationMs,
          mimeType: part.mimeType,
          size: part.size,
          localDataBytes: part.localData?.byteLength,
          ingressFailure: part.ingressFailure,
        };
      case 'video':
        return {
          type: 'video',
          durationMs: part.durationMs,
          mimeType: part.mimeType,
          size: part.size,
          localDataBytes: part.localData?.byteLength,
          ingressFailure: part.ingressFailure,
        };
      default:
        return { type: part.type };
    }
  });
}
import { hydrateFiles, hydrateImages, hydrateMedia, type RemoteMediaFetchLike } from './image-hydrator.js';
import type { MediaResolverLike } from './openapi-port.js';

export interface InboundProcessorOptions {
  ctx: ChannelAdapterContext;
  meta: DingTalkInboundMeta;
  dedupEnabled: boolean;
  dedupWindowMs: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /**
   * Secure remote media fetcher used to hydrate inbound image URLs into
   * `localData`. Injectable for offline tests; defaults to a real
   * `SecureRemoteMediaFetcher` bound to the global fetch.
   */
  secureFetch?: RemoteMediaFetchLike;
  /**
   * DingTalk OpenAPI media resolver used to turn opaque file mediaIds into
   * trusted bytes during file ingress. Injectable for offline
   * tests; when absent, opaque file handles are deferred to `resourceRef`.
   */
  resolveMedia?: MediaResolverLike;
}

export class InboundProcessor {
  private readonly now: () => number;
  /** dedup key -> last-seen timestamp, pruned on every handle. */
  private readonly seen = new Map<string, number>();

  constructor(private readonly options: InboundProcessorOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Process one raw payload from the upstream; dedup, hydrate, then emit. */
  async handle(raw: unknown): Promise<void> {
    const key = dedupKey(raw);
    if (this.options.dedupEnabled) {
      const now = this.now();
      const last = this.seen.get(key);
      if (last !== undefined && now - last < this.options.dedupWindowMs) {
        this.options.ctx.logger.debug(`[channel-dingtalk] dropped duplicate message '${key}'`);
        return;
      }
      this.seen.set(key, now);
      this.prune(now);
    }
    const kind = z.object({ type: z.string().optional() }).passthrough().safeParse(raw);
    if (kind.success && kind.data.type === 'interaction') {
      const interaction = mapInteraction(raw, this.options.meta);
      this.options.ctx.logger.info('[channel-dingtalk] inbound interaction', {
        interactionId: interaction.interactionId,
        conversationId: interaction.conversation.id,
        senderId: interaction.sender.id,
        action: interaction.action,
      });
      await this.options.ctx.emit(interaction);
      return;
    }
    const event: MessageReceived = mapInbound(raw, this.options.meta);
    // Per-message download context (official robot schema): the callback's
    // downloadCode + robotCode are transient upstream state the official
    // /v1.0/robot/messageFiles/download API needs. Read from the raw payload
    // and passed to hydration — never persisted onto core parts.
    const parsedDownloadContext = downloadContextSchema.safeParse(raw);
    const rawValue = parsedDownloadContext.success ? parsedDownloadContext.data : undefined;
    const downloadContext = {
      downloadCode: rawValue?.picDownloadCode ?? rawValue?.downloadCode,
      robotCode: rawValue?.robotCode,
    };
    // Hydrate image parts (never throws / never blocks text delivery). The
    // adapter context signal lets the owning scope abort in-flight downloads.
    await hydrateImages(event.message.content, {
      secureFetch: this.options.secureFetch,
      resolveMedia: this.options.resolveMedia,
      downloadContext,
      signal: this.options.ctx.signal,
      onFailure: (error, part) => {
        this.options.ctx.logger.warn('[channel-dingtalk] inbound image hydration failed', {
          hasResourceRef: part.type === 'image' && Boolean(part.resourceRef),
          hasUrl: part.type === 'image' && Boolean(part.url),
          error: summarizeError(error),
        });
      },
    });
    // Hydrate generic file parts: genuine http(s) urls via the secure fetcher;
    // opaque mediaIds via the DingTalk OpenAPI media resolver.
    await hydrateFiles(event.message.content, {
      secureFetch: this.options.secureFetch,
      resolveMedia: this.options.resolveMedia,
      downloadContext,
      signal: this.options.ctx.signal,
    });
    // Hydrate audio/video parts: audio/video follow the exact
    // same URL-or-opaque resolution as image/file — genuine http(s) urls via
    // the secure fetcher, opaque downloadCodes via the official
    // messageFiles/download seam (the connector oracle downloads voice/video
    // bytes through the identical downloadCode -> downloadUrl -> raw bytes
    // flow). Failures only annotate the part; text still delivers.
    await hydrateMedia(event.message.content, {
      secureFetch: this.options.secureFetch,
      resolveMedia: this.options.resolveMedia,
      downloadContext,
      signal: this.options.ctx.signal,
    });
    // Inbound message log: expose hydration state without platform locators.
    // Signed URLs and download codes must never enter logs at any level.
    this.options.ctx.logger.info(
      `[channel-dingtalk] inbound message ${event.message.id} from ${event.sender.id} in ${event.conversation.id}`,
      {
        msgtype: rawValue?.type,
        parts: summarizeParts(event.message.content),
      },
    );
    await this.options.ctx.emit(event);
  }

  private prune(now: number): void {
    for (const [key, ts] of this.seen) {
      if (now - ts >= this.options.dedupWindowMs) this.seen.delete(key);
    }
  }
}

function summarizeError(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: 'UnknownError' };
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return { name: error.name, ...(code !== undefined ? { code } : {}) };
}
