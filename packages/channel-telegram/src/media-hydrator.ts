/**
 * Telegram inbound media hydration.
 *
 * The pure mapper maps Telegram file_id values to the contract's
 * `resourceRef` carrier (an opaque platform handle — never `url`). This module
 * resolves those handles through the platform upstream (`getFile` +
 * `/file/bot<token>/<file_path>`) and places the trusted bytes on
 * `localData`, exactly like the official adapters' hydrators do for their
 * platform URLs.
 *
 * Only `image` and `file` parts are hydrated — those are the binary types the
 * Harness bridge currently projects as real attachments (image -> ImageBlock,
 * file -> private asset store). Audio/video keep their `resourceRef`
 * placeholder in V1 (no DSH consumer yet).
 *
 * Failure handling follows the shared contract: a download failure never
 * blocks text delivery. The part keeps its `resourceRef` and records a stable
 * de-identified `ingressFailure` code via `toIngressFailureCode` from
 * `@wsz987/channel-core`.
 */
import {
  toIngressFailureCode,
  type BinaryIngressFailureCode,
  type ChannelLogger,
  type FilePart,
  type ImagePart,
  type MessagePart,
} from '@wsz987/channel-core';

/** Platform file resolution seam (implemented by the upstream driver). */
export interface TelegramFileResolver {
  downloadFile(
    fileId: string,
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; mimeType?: string; name?: string }>;
}

export interface TelegramMediaHydratorOptions {
  /** Hard byte cap for one download. */
  maxBytes: number;
  /** External cancellation signal (from the adapter context). */
  signal?: AbortSignal;
  /** Optional logger for safe per-media failure diagnostics. */
  logger?: Pick<ChannelLogger, 'warn'>;
}

/**
 * Hydrate Telegram `resourceRef` bytes on `parts` in place. Returns the
 * mutated array. Never throws — every download failure is recorded as
 * `ingressFailure` on the part and the event still carries the text parts.
 */
export async function hydrateTelegramParts(
  parts: MessagePart[],
  resolver: TelegramFileResolver,
  options: TelegramMediaHydratorOptions,
): Promise<MessagePart[]> {
  const { maxBytes, signal, logger } = options;

  await Promise.allSettled(
    parts.map(async (part): Promise<void> => {
      if (part.type !== 'image' && part.type !== 'file') return;
      const binary = part as ImagePart | FilePart;
      const fileId = binary.resourceRef;
      if (typeof fileId !== 'string' || fileId.length === 0) return;
      // Trusted bytes already in hand take precedence — never re-download.
      if (binary.localData !== undefined || binary.dataUri !== undefined) return;

      try {
        const result = await resolver.downloadFile(fileId, signal);
        if (result.data.byteLength > maxBytes) {
          throw new FileTooLargeError(maxBytes, result.data.byteLength);
        }
        binary.localData = result.data;
        // Telegram's original message metadata is more authoritative than
        // metadata reconstructed from the download response/path. Only fill
        // missing hints so a generated file_path cannot replace a user name.
        if (binary.mimeType === undefined && result.mimeType) binary.mimeType = result.mimeType;
        if (binary.type === 'file') {
          binary.size = result.data.byteLength;
          if (binary.name === undefined && result.name) binary.name = result.name;
        }
        // A successful hydration clears any previous failure marker.
        delete binary.ingressFailure;
      } catch (error) {
        // Keep the resourceRef, record the stable de-identified failure code.
        binary.ingressFailure = error instanceof FileTooLargeError
          ? 'too-large'
          : toIngressFailureCode(error);
        logger?.warn('[channel-telegram] media hydration failed', {
          type: binary.type,
          failure: binary.ingressFailure,
          error: safeErrorDetails(error),
        });
      }
    }),
  );

  return parts;
}

/** Keep diagnostics useful without allowing bearer paths or raw payloads into logs. */
function safeErrorDetails(error: unknown): Record<string, string> {
  if (!(error instanceof Error)) return { message: 'unknown error' };
  const value = error as Error & { code?: unknown };
  return {
    name: value.name,
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    message: value.message.replace(/\/file\/bot[^/?#]+/g, '/file/bot<redacted>')
      .replace(/\/bot[^/?#]+/g, '/bot<redacted>'),
  };
}

/** Local size guard; mapped to 'too-large' by `toIngressFailureCode`. */
class FileTooLargeError extends Error {
  readonly code = 'BODY_TOO_LARGE';
  constructor(
    readonly maxBytes: number,
    readonly received: number,
  ) {
    super(`Telegram file ${received} bytes exceeds the ${maxBytes} byte cap`);
    this.name = 'FileTooLargeError';
  }
}

/** Re-exported so tests can build stable ingress-failure expectations. */
export type { BinaryIngressFailureCode };
