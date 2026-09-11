/**
 * Media hydration for inbound messages (plan section 28 / 79A Lark; section
 * 23-A4 extends it from image/file to ALL four binary kinds).
 *
 * After a raw payload is mapped to a MessageReceived, the adapter hydrates
 * every binary part (image, generic file, audio AND video) that carries a
 * platform-opaque resourceRef (a Lark image_key / file_key) by resolving it
 * through the injected LarkMediaPort into real bytes (localData + mimeType).
 * The messageId needed for
 * messageResource.get(message_id, file_key) comes from the invocation
 * context (the event message id) - it is NOT persisted into the part (plan
 * section 28 prefers the hydration invocation context over persisting it).
 *
 * The per-kind `type` fed to the port mirrors the resource kind: the official
 * `message.resource` API documents its scope as 音频、视频、图片和文件 (audio,
 * video, image and file — see the SDK-embedded doc statement), and the SDK
 * `type` query param is typed `string`, so audio/video file_keys download
 * through the SAME seam as image/file (plan section 23-A4). Platform-level
 * resource limits (<= 100 MB; no stickers; no merged-forward sub-messages or
 * card-message resources, error 234043) surface as port failures that this
 * module maps to a stable ingressFailure — the locator is never fabricated
 * into bytes.
 *
 * Generic files (M7A): the type fed to the port is 'file', and the resolved
 * content-disposition filename is copied into part.name so the Harness bridge
 * stores/extracts the attachment without a second platform round-trip.
 *
 * The APPLICATION step reuses core's protocol-neutral `applyHydrationResult`
 * (plan section 6.3): it owns the byte cap ('too-large'), the AbortSignal
 * handling, the localData/size/mime/name merge and the success-clears-failure
 * rule. Failure CLASSIFICATION stays lark-specific (`classifyIngressFailure`)
 * so genuinely absent resources ('not found' / 234043-style platform errors)
 * map to 'resource-unavailable' while plumbing/network errors map to
 * 'download-failed' — core's generic mapping would collapse both to
 * 'download-failed' and lose that distinction.
 *
 * On hydration failure the part keeps its resourceRef (so the platform
 * locator survives for a later retry) and records a stable ingressFailure;
 * text delivery is never blocked (plan section 79A DoD).
 */
import {
  applyHydrationResult,
  isHydratableBinaryPart,
  toIngressFailureCode,
  type BinaryHydrationResult,
  type MessagePart,
} from '@wsz987/channel-core';
import type { MessageReceived } from '@wsz987/channel-core';
import {
  LARK_MESSAGE_RESOURCE_MAX_BYTES,
  type LarkMediaPort,
} from './upstream/media-port.js';

/** Avoid multiplying the 100 MiB per-resource bound across one message. */
export const DEFAULT_MEDIA_HYDRATION_CONCURRENCY = 2;

export interface MediaHydratorOptions {
  /** Media port used to resolve binary resourceRefs into bytes. */
  mediaPort?: LarkMediaPort;
  /** Cancellation signal (the adapter context signal). */
  signal?: AbortSignal;
  /** Injectable logger (adapter context logger). */
  logger?: { debug(...args: unknown[]): void };
  /**
   * Optional hard byte cap for one resource download. Defaults to the official
   * 100 MiB platform limit and is enforced while the SDK stream is consumed.
   */
  maxBytes?: number;
  /** Maximum number of media downloads active for one inbound message. */
  maxConcurrency?: number;
}

export class MediaHydrator {
  constructor(private readonly options: MediaHydratorOptions) {}

  /**
   * Hydrate image, file, audio and video parts in place on the given event
   * using the event's own message id as the messageResource resolution
   * context. Never throws: a download failure marks the part instead of
   * blocking the message.
   */
  async hydrateMedia(event: MessageReceived): Promise<void> {
    const port = this.options.mediaPort;
    if (!port) return;
    const parts = event.message.content;
    if (!Array.isArray(parts)) return;
    const messageId = String(event.message.id);
    const maxConcurrency = normalizeConcurrency(this.options.maxConcurrency);
    let nextIndex = 0;
    const worker = async () => {
      for (;;) {
        const index = nextIndex++;
        if (index >= parts.length) return;
        await this.hydratePart(port, parts[index]!, messageId);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(maxConcurrency, parts.length) }, () => worker()),
    );
  }

  /**
   * @deprecated use {@link MediaHydrator.hydrateMedia} — this alias covers
   * all four binary kinds and is kept so pre-§23-A4 call sites keep working.
   */
  async hydrateImages(event: MessageReceived): Promise<void> {
    return this.hydrateMedia(event);
  }

  private async hydratePart(
    port: LarkMediaPort,
    part: MessagePart,
    messageId: string,
  ): Promise<void> {
    // Hydrate the four binary kinds only; every other part type is ignored.
    // `isHydratableBinaryPart` narrows `part` to the BinaryPartBase variants
    // (resourceRef / localData / mimeType / name) shared by image, file,
    // audio and video.
    if (!isHydratableBinaryPart(part)) return;
    const resourceType = part.type;
    // Only hydrate parts that currently carry a platform handle and have no
    // bytes yet; anything else (URL-based, already-hydrated, or already
    // failed) is left untouched so a prior failure marker is preserved.
    if (!part.resourceRef) return;
    if (part.localData !== undefined) return;
    if (part.ingressFailure) return;
    // Pre-aborted: same fail-fast semantics as `applyHydrationResult`
    // (cancelled before the download started -> 'download-failed').
    if (this.options.signal?.aborted) {
      part.ingressFailure = 'download-failed';
      return;
    }
    try {
      const resolved = await port.downloadMessageResource({
        messageId,
        resourceKey: part.resourceRef,
        type: resourceType,
        signal: this.options.signal,
        maxBytes: this.options.maxBytes ?? LARK_MESSAGE_RESOURCE_MAX_BYTES,
      });
      const result: BinaryHydrationResult = {
        data: resolved.data,
        ...(resolved.mimeType !== undefined ? { mimeType: resolved.mimeType } : {}),
        ...(resolved.name !== undefined ? { name: resolved.name } : {}),
      };
      await applyHydrationResult(part, async () => result, {
        maxBytes: this.options.maxBytes ?? LARK_MESSAGE_RESOURCE_MAX_BYTES,
        signal: this.options.signal,
      });
      // Image parts never carry `size` (keep that shape stable), while
      // file/audio/video keep the authoritative `size` derived from the real
      // bytes (mirrors channel-qq).
      if (part.type === 'image') delete part.size;
    } catch (error) {
      this.options.logger?.debug('[channel-lark] ' + resourceType + ' hydration failed', error);
      part.ingressFailure = classifyIngressFailure(error);
    }
  }
}

/**
 * @deprecated use {@link MediaHydrator} — kept under the legacy name so
 * pre-§23-A4 imports (`new ImageHydrator(...)`) keep working.
 */
export const ImageHydrator = MediaHydrator;

/**
 * @deprecated use {@link MediaHydratorOptions} — legacy alias for the
 * pre-§23-A4 options shape.
 */
export type ImageHydratorOptions = MediaHydratorOptions;

/**
 * Map a hydration failure to a stable de-identified code. Platform-plumbing
 * errors (SDK API errors / network) map to download-failed; a genuinely
 * absent resource maps to resource-unavailable.
 */
export function classifyIngressFailure(
  error: unknown,
): 'download-failed' | 'resource-unavailable' | 'too-large' {
  const message = error instanceof Error ? error.message : String(error);
  const text = message.toLowerCase();
  const missing = [
    'not found',
    'no such',
    'does not exist',
    'resource not exist',
    'requested resource',
    '234043',
    'invalid parameter',
    'no permission',
  ];
  if (missing.some((needle) => text.includes(needle))) return 'resource-unavailable';
  const failure = toIngressFailureCode(error);
  return failure === 'resource-unavailable'
    ? 'resource-unavailable'
    : failure === 'too-large'
      ? 'too-large'
      : 'download-failed';
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MEDIA_HYDRATION_CONCURRENCY;
  return Math.max(1, Math.floor(value));
}
