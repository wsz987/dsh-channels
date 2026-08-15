/**
 * Media hydration for inbound messages (plan section 28 / 79A Lark).
 *
 * After a raw payload is mapped to a MessageReceived, the adapter hydrates
 * every binary part (image AND generic file) that carries a
 * platform-opaque resourceRef (a Lark image_key / file_key) by resolving it
 * through the injected LarkMediaPort into real bytes (localData + mimeType).
 * The messageId needed for
 * messageResource.get(message_id, file_key) comes from the invocation
 * context (the event message id) - it is NOT persisted into the part (plan
 * section 28 prefers the hydration invocation context over persisting it).
 *
 * Generic files (M7A): the type fed to the port is 'file', and the resolved
 * content-disposition filename is copied into part.name so the Harness bridge
 * stores/extracts the attachment without a second platform round-trip.
 *
 * On hydration failure the part keeps its resourceRef (so the platform
 * locator survives for a later retry) and records a stable ingressFailure;
 * text delivery is never blocked (plan section 79A DoD).
 */
import type { MessageReceived, MessagePart } from '@wsz987/channel-core';
import type { LarkMediaPort } from './upstream/media-port.js';

export interface ImageHydratorOptions {
  /** Media port used to resolve image/file resourceRefs into bytes. */
  mediaPort?: LarkMediaPort;
  /** Cancellation signal (the adapter context signal). */
  signal?: AbortSignal;
  /** Injectable logger (adapter context logger). */
  logger?: { debug(...args: unknown[]): void };
}

export class ImageHydrator {
  constructor(private readonly options: ImageHydratorOptions) {}

  /**
   * Hydrate image and file parts in place on the given event using the
   * event's own message id as the messageResource resolution context. Never
   * throws: a download failure marks the part instead of blocking the message.
   */
  async hydrateImages(event: MessageReceived): Promise<void> {
    const port = this.options.mediaPort;
    if (!port) return;
    const parts = event.message.content;
    if (!Array.isArray(parts)) return;
    const messageId = String(event.message.id);
    await Promise.all(parts.map((part) => this.hydratePart(port, part, messageId)));
  }

  private async hydratePart(
    port: LarkMediaPort,
    part: MessagePart,
    messageId: string,
  ): Promise<void> {
    // Hydrate image and generic file parts only; every other type is ignored.
    // Guarding on the literal union narrows `part` to `ImagePart | FilePart`, both of
    // which extend BinaryPartBase (resourceRef / localData / mimeType / name).
    if (part.type !== 'image' && part.type !== 'file') return;
    const resourceType: 'image' | 'file' = part.type;
    // Only hydrate parts that currently carry a platform handle and have no
    // bytes yet; anything else (URL-based, already-hydrated, or already
    // failed) is left untouched so a prior failure marker is preserved.
    if (!part.resourceRef) return;
    if (part.localData) return;
    if (part.ingressFailure) return;
    try {
      const resolved = await port.downloadMessageResource({
        messageId,
        resourceKey: part.resourceRef,
        type: resourceType,
        signal: this.options.signal,
      });
      part.localData = resolved.data;
      if (resolved.mimeType) part.mimeType = resolved.mimeType;
      if (resolved.name) part.name = resolved.name;
    } catch (error) {
      this.options.logger?.debug('[channel-lark] ' + resourceType + ' hydration failed', error);
      part.ingressFailure = classifyIngressFailure(error);
    }
  }
}

/**
 * Map a hydration failure to a stable de-identified code. Platform-plumbing
 * errors (SDK API errors / network) map to download-failed; a genuinely
 * absent resource maps to resource-unavailable.
 */
export function classifyIngressFailure(error: unknown): 'download-failed' | 'resource-unavailable' {
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
  return 'download-failed';
}
