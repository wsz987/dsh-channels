/**
 * Inbound processing: dedup window + structured mapping + image hydration + emit.
 */
import type { ChannelAdapterContext, MessagePart, MessageReceived } from '@wsz987/channel-core';
import { dedupKey, mapInbound, type DingTalkInboundMeta } from './mapper.js';

/** Compact per-part summary for inbound message logs (debug diagnostics). */
function summarizeParts(parts: readonly MessagePart[]): unknown[] {
  return parts.map((part) => {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text.slice(0, 80) };
      case 'image':
        return {
          type: 'image',
          url: part.url,
          resourceRef: part.resourceRef,
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
        return { type: 'audio', durationMs: part.durationMs, localDataBytes: part.localData?.byteLength };
      case 'video':
        return { type: 'video', durationMs: part.durationMs, localDataBytes: part.localData?.byteLength };
      default:
        return { type: part.type };
    }
  });
}
import { hydrateFiles, hydrateImages, type RemoteMediaFetchLike } from './image-hydrator.js';
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
   * `localData` (plan §32A). Injectable for offline tests; defaults to a real
   * `SecureRemoteMediaFetcher` bound to the global fetch.
   */
  secureFetch?: RemoteMediaFetchLike;
  /**
   * DingTalk OpenAPI media resolver used to turn opaque file mediaIds into
   * trusted bytes during file ingress (plan §32A / §86). Injectable for offline
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
    const event: MessageReceived = mapInbound(raw, this.options.meta);
    // Per-message download context (official robot schema): the callback's
    // downloadCode + robotCode are transient upstream state the official
    // /v1.0/robot/messageFiles/download API needs. Read from the raw payload
    // and passed to hydration — never persisted onto core parts (plan §9/§46).
    const rawValue = raw as { picDownloadCode?: string; downloadCode?: string; robotCode?: string } | undefined;
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
          resourceRef: part.type === 'image' ? part.resourceRef : undefined,
          url: part.type === 'image' ? part.url : undefined,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    // Hydrate generic file parts: genuine http(s) urls via the secure fetcher;
    // opaque mediaIds via the DingTalk OpenAPI media resolver (plan §86 / §32A).
    await hydrateFiles(event.message.content, {
      secureFetch: this.options.secureFetch,
      resolveMedia: this.options.resolveMedia,
      downloadContext,
      signal: this.options.ctx.signal,
    });
    // Inbound message log (debug diagnostics): shows the mapped parts incl.
    // image/file locator + hydration result, so channel ingress is visible in
    // web:debug / DSH_CHANNELS_DEBUG=1 consoles.
    const rawRecord = raw as Record<string, unknown> | undefined;
    this.options.ctx.logger.info(
      `[channel-dingtalk] inbound message ${event.message.id} from ${event.sender.id} in ${event.conversation.id}`,
      {
        msgtype: rawRecord?.type,
        parts: summarizeParts(event.message.content),
      },
    );
    this.options.ctx.logger.debug('[channel-dingtalk] raw inbound media locators', {
      picUrl: rawRecord?.picUrl,
      picMediaId: rawRecord?.picMediaId,
      picDownloadCode: rawRecord?.picDownloadCode,
      mediaUrl: rawRecord?.mediaUrl,
      downloadCode: rawRecord?.downloadCode,
      robotCode: rawRecord?.robotCode,
    });
    await this.options.ctx.emit(event);
  }

  private prune(now: number): void {
    for (const [key, ts] of this.seen) {
      if (now - ts >= this.options.dedupWindowMs) this.seen.delete(key);
    }
  }
}
